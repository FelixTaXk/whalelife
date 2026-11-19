import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { inspectOfficialFiles, installOfficialFiles, uninstallOfficialFiles } from "../core/official-package-files.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const program: [string, Buffer][] = [
  ["plugin.yaml", Buffer.from("id: example\nversion: 1.0.0")], ["index.ts", Buffer.from("export default 42")],
  ["src/empty.ts", Buffer.alloc(0)], ["node_modules/example/data/table.bin", Buffer.alloc(600_000, 0xa5)],
];
async function fixture(files = program, alter?: (bytes: Buffer) => Buffer) {
  const root = await temporaryDirectory("whale-official-files-"), cache = join(root, ".artifacts/official-packages");
  await mkdir(cache, { recursive: true });
  const header = files.map(([path, bytes]) => ({ path, size: bytes.length, sha256: digest(bytes) }));
  const raw = Buffer.concat([Buffer.from(JSON.stringify({ format: 1, files: header }) + "\n"), ...files.map(entry => entry[1])]);
  const archive = gzipSync(alter ? alter(raw) : raw), sha256 = digest(archive);
  await writeFile(join(cache, sha256 + ".wlpkg.gz"), archive);
  const spec = { directory: "plugins/example", sha256 }, base = join(root, spec.directory);
  async function save(path: string, bytes: Buffer | string) {
    const target = join(base, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return { root, cache, spec, base, save };
}

test("manual verified installs are adopted and concurrent retries preserve persisted files byte for byte", async () => {
  const { root, base, spec, save } = await fixture();
  const user = new Map([["data/originals/image.png", Buffer.from([0, 1, 0xff])],
    ["data/tags.sqlite", Buffer.from("tag store")], ["config.json", Buffer.from('{"quality":90}')],
    ["sub/child/index.ts", Buffer.from("independent child")]]);
  for (const [path, bytes] of user) await save(path, bytes);
  for (const [path, bytes] of program) await save(path, bytes);
  assert.equal((await inspectOfficialFiles(root, spec)).state, "installed");
  await Promise.all([uninstallOfficialFiles(root, spec), uninstallOfficialFiles(root, spec)]);
  assert.equal((await inspectOfficialFiles(root, spec)).state, "absent");
  await assert.rejects(readFile(join(base, "index.ts")), { code: "ENOENT" });
  for (const [path, bytes] of user) assert.deepEqual(await readFile(join(base, path)), bytes);
  await Promise.all([installOfficialFiles(root, spec), installOfficialFiles(root, spec)]);
  assert.equal((await inspectOfficialFiles(root, spec)).state, "installed");
  for (const [path, bytes] of [...program, ...user]) assert.deepEqual(await readFile(join(base, path)), bytes);
});

test("a changed, missing or unidentified program file blocks all deletions", async () => {
  const { root, base, spec, save } = await fixture();
  await installOfficialFiles(root, spec);
  await save("index.ts", "export default 43");
  assert.match((await inspectOfficialFiles(root, spec)).reason!, /index\.ts/);
  await assert.rejects(uninstallOfficialFiles(root, spec), /index\.ts/);
  assert.deepEqual(await readFile(join(base, "plugin.yaml")), program[0][1]);
  await save("index.ts", program[1][1]);
  await save("unknown.js", "my custom script");
  await assert.rejects(uninstallOfficialFiles(root, spec), /unknown\.js/);
  await rm(join(base, "unknown.js"));
  await rm(join(base, "src/empty.ts"));
  await assert.rejects(uninstallOfficialFiles(root, spec), /src\/empty\.ts/);
  assert.deepEqual(await readFile(join(base, "index.ts")), program[1][1]);
});

test("bundled bridge code can be removed while its data, configuration and sibling plugins survive", async () => {
  const files: [string, Buffer][] = [...program, ["sub/gallery/index.ts", Buffer.from("bridge")],
    ["sub/gallery/plugin.yaml", Buffer.from("id: gallery")]];
  const { root, base, spec, save } = await fixture(files);
  await save("sub/gallery/data/picture", "keep");
  await save("sub/gallery/config/bridge.json", "settings");
  await save("sub/neighbor/plugin.yaml", "id: neighbor");
  await installOfficialFiles(root, spec);
  await uninstallOfficialFiles(root, spec);
  assert.equal(await readFile(join(base, "sub/gallery/data/picture"), "utf8"), "keep");
  assert.equal(await readFile(join(base, "sub/gallery/config/bridge.json"), "utf8"), "settings");
  assert.equal(await readFile(join(base, "sub/neighbor/plugin.yaml"), "utf8"), "id: neighbor");
  await assert.rejects(readFile(join(base, "sub/gallery/index.ts")), { code: "ENOENT" });
});

test("ownership rejects aliases, shared file/directory names and protected user namespaces in archives", async () => {
  for (const path of ["Src/other.ts", "src/empty.ts/file", "data/originals/image", "sub/gallery/config.json",
    "../something", "dir/CON.log", "index.ts:alternate", "plugin.yaml"]) {
    const { root, spec, base } = await fixture([...program, [path, Buffer.from("invalid")]]);
    await assert.rejects(installOfficialFiles(root, spec), /发行/);
    await assert.rejects(readdir(base), { code: "ENOENT" });
  }
});

test("cache digest and each streamed payload are validated before publishing any program files", async () => {
  const corrupt = await fixture(program, bytes => { bytes[bytes.length - 1] ^= 1; return bytes; });
  await assert.rejects(installOfficialFiles(corrupt.root, corrupt.spec), /校验失败/);
  await assert.rejects(readdir(corrupt.base), { code: "ENOENT" });
  assert.deepEqual(await readdir(corrupt.cache), [corrupt.spec.sha256 + ".wlpkg.gz"]);
  const truncated = await fixture(program, bytes => bytes.subarray(0, -20));
  await assert.rejects(installOfficialFiles(truncated.root, truncated.spec), /不完整/);
  const missing = { ...corrupt.spec, sha256: "0".repeat(64) };
  assert.match((await inspectOfficialFiles(corrupt.root, missing)).reason!, /尚未取得/);
  await writeFile(join(corrupt.cache, missing.sha256 + ".wlpkg.gz"), Buffer.from("untrusted"));
  assert.match((await inspectOfficialFiles(corrupt.root, missing)).reason!, /SHA-256/);
});

test("plugin and ancestor directory junctions cannot redirect program operations", async () => {
  const { root, base, spec } = await fixture();
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(root, "plugins"), "junction");
  await assert.rejects(installOfficialFiles(root, spec), /链接/);
  assert.deepEqual(await readdir(elsewhere), []);
  await rm(join(root, "plugins"));
  await installOfficialFiles(root, spec);
  await symlink(elsewhere, join(base, "redirect"), "junction");
  await assert.rejects(uninstallOfficialFiles(root, spec), /链接/);
  assert.equal((await readFile(join(base, "index.ts"))).toString(), "export default 42");
});

test("a file arriving while the program is published is preserved and preceding writes are withdrawn", async () => {
  const files: [string, Buffer][] = [...program, ...Array.from({ length: 80 }, (_, i): [string, Buffer] =>
    [`more/${i}.ts`, Buffer.from(String(i))])];
  const { root, spec, base, save, cache } = await fixture(files);
  await save("data/picture", "original");
  let collision: Promise<void> | undefined;
  const watcher = watch(base, (_event, filename) => {
    if (filename === "index.ts" && !collision) collision = writeFile(join(base, "plugin.yaml"), "local file", { flag: "wx" });
  });
  try {
    await assert.rejects(installOfficialFiles(root, spec), /已撤回本步/);
    await collision;
    assert.equal(await readFile(join(base, "plugin.yaml"), "utf8"), "local file");
    assert.equal(await readFile(join(base, "data/picture"), "utf8"), "original");
    assert.deepEqual((await readdir(base)).sort(), ["data", "plugin.yaml"]);
    assert.deepEqual(await readdir(cache), [spec.sha256 + ".wlpkg.gz"]);
  } finally { watcher.close(); }
});
