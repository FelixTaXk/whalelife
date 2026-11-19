import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { temporaryDirectory } from "./temporary-directory.ts";
import { Runtime } from "../core/runtime.ts";
import { OfficialPlugins } from "../core/official-plugins.ts";
import { startWeb } from "../core/web.ts";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function fixture(t: TestContext, broken = false, required = "1.0.0") {
  const root = await temporaryDirectory("whale-official-manager-");
  const cache = join(root, ".artifacts/official-packages");
  await mkdir(cache, { recursive: true });
  const create = async (id: string, parentId: string | null, body: string) => {
    const files = [
      ["plugin.yaml", JSON.stringify({ id, name: id, version: "1.0.0", description: "fixture", depends: parentId ? [parentId] : [] })],
      ["index.ts", body],
    ].map(([path, code]) => ({ path, bytes: Buffer.from(code) }));
    const header = { format: 1, files: files.map(f => ({ path: f.path, size: f.bytes.length, sha256: hash(f.bytes) })) };
    const packed = gzipSync(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), ...files.map(f => f.bytes)]));
    const sha256 = hash(packed);
    await writeFile(join(cache, sha256 + ".wlpkg.gz"), packed);
    const entry = { id, name: id, repository: "", requiredPlugins: parentId ? [parentId] : [], parentId,
      verifiedReleases: [{ version: "1.0.0", hostRange: "0.1.0", platform: process.platform, arch: process.arch, sha256,
        dependencies: parentId ? { [parentId]: required } : {} }] };
    return { entry, files };
  };
  const parent = await create("surf", null, 'export function apply(ctx){ctx.provide("surf",{ ping(){return true} })}');
  const child = await create("bilibili", "surf", broken ? 'export function apply(){throw Error("test initialization failure")}' : "export function apply(){}");
  const runtime = new Runtime(root, { info() {}, warn() {}, error() {} } as any);
  t.after(() => runtime.bus.stop());
  await runtime.bus.start();
  await runtime.scan();
  const manager = new OfficialPlugins(runtime, [parent.entry, child.entry]);
  const get = async (id: string) => (await manager.list()).plugins.find(p => p.id === id)!;
  const apply = async (id: string) => manager.apply(await get(id));
  return { root, runtime, manager, get, apply, parentFiles: parent.files };
}

test("install previews missing dependencies, rejects stale plans, and uninstalls only the selected child", async t => {
  const f = await fixture(t);
  const first = await f.get("bilibili");
  assert.equal(first.runtimeId, "surf/bilibili");
  assert.equal(first.recognized, false);
  assert.equal((await f.get("surf")).runtimeId, "surf");
  assert.deepEqual(first.steps.map(s => [s.action, s.id]), [["install","surf"], ["install","bilibili"]]);
  await f.apply("surf");
  await assert.rejects(f.manager.apply(first), /刷新/);
  await f.runtime.action("surf", "stop");
  const plan = await f.get("bilibili");
  assert.deepEqual(plan.steps.map(s => s.action), ["enable","install"]);
  assert.equal(f.runtime.pluginState.enabled("surf"), false);
  await f.manager.apply(plan);
  await f.runtime.action("surf/bilibili", "stop");
  const parent = await f.get("surf");
  assert.match(parent.reason, /依赖.*bilibili/);
  assert.equal(parent.recognized, true);
  assert.equal((await f.get("bilibili")).recognized, true);
  assert.deepEqual((await f.manager.list()).recognizedRuntimeIds.sort(), ["surf", "surf/bilibili"]);
  await f.apply("bilibili");
  assert.equal(f.runtime.records.get("surf").status, "active");
  assert.equal(f.runtime.records.has("surf/bilibili"), false);
  await f.apply("surf");
});

test("failed activation removes fresh packages and restores an existing disabled or active dependency", async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.apply("bilibili"), (err: any) => /启用插件失败/.test(err.message) && err.rolledBack.length === 2);
  assert.equal(f.runtime.records.size, 0);
  await f.apply("surf");
  await f.runtime.action("surf", "stop");
  await assert.rejects(f.apply("bilibili"), /test initialization failure/);
  assert.equal(f.runtime.records.get("surf").status, "stopped");
  assert.equal(f.runtime.pluginState.enabled("surf"), false);
  await f.runtime.action("surf", "start");
  await assert.rejects(f.apply("bilibili"), /test initialization failure/);
  assert.equal(f.runtime.records.get("surf").status, "active");
  assert.equal(f.runtime.records.has("surf/bilibili"), false);
});

test("manual releases are recognized, dependency upgrades require user action, and modified scripts stay on disk", async t => {
  const f = await fixture(t, false, "1.1.0");
  const directory = join(f.root, "plugins/surf");
  await mkdir(directory, { recursive: true });
  for (const file of f.parentFiles) await writeFile(join(directory, file.path), file.bytes);
  await f.runtime.loadPath("surf");
  assert.match((await f.get("bilibili")).reason, /请先升级.*1.1.0/);
  const old = await f.get("surf");
  assert.equal(old.recognized, true);
  const script = join(f.root, "plugins/surf/index.ts");
  await writeFile(script, "// locally edited");
  const modified = await f.get("surf");
  assert.equal(modified.installed, true);
  assert.equal(modified.recognized, false);
  await assert.rejects(f.manager.apply(old));
  assert.equal(await readFile(script, "utf8"), "// locally edited");
  assert.equal(f.runtime.records.get("surf").status, "active");
});

test("a separately distributed official build identifies its installed runtime without granting package actions", async t => {
  const f = await fixture(t);
  await f.apply("surf");
  // Inventories are resolved relative to the host module. Keep the synthetic registry and its files in this test's host.
  const core = join(f.root, "core"), market = join(f.root, "market");
  await mkdir(core);
  await mkdir(join(market, "inventories"), { recursive: true });
  for (const file of ["official-plugins.ts", "official-package-files.ts"]) {
    await copyFile(new URL("../core/" + file, import.meta.url), join(core, file));
  }
  const inventory = Buffer.from(JSON.stringify({ format: 1,
    files: f.parentFiles.map(file => ({ path: file.path, size: file.bytes.length, sha256: hash(file.bytes) })),
  }));
  const build = { runtimeId: "surf", version: "1.0.0", platform: process.platform, arch: process.arch,
    sourceCommit: "1".repeat(40), sha256: hash(inventory) };
  await writeFile(join(market, "inventories", build.sha256 + ".json"), inventory);
  await writeFile(join(market, "official-releases.json"), JSON.stringify({ plugins: [], installedBuilds: [build] }));
  await writeFile(join(market, "catalog.json"), JSON.stringify({ official: [], community: [] }));
  await writeFile(join(f.root, "package.json"), JSON.stringify({ type: "module", version: "0.1.0" }));
  const { OfficialPlugins: LocalManager }: typeof import("../core/official-plugins.ts") =
    await import(pathToFileURL(join(core, "official-plugins.ts")).href);
  const manager = new LocalManager(f.runtime);
  assert.deepEqual(await manager.list(), { plugins: [], recognizedRuntimeIds: ["surf"] });
  for (const action of ["install", "uninstall"]) {
    await assert.rejects(manager.apply({ id: "surf", action, planKey: "" }), /请选择官方目录内的插件/);
  }
  for (const variant of [{ runtimeId: "other/surf" }, { version: "0.9.0" }]) {
    const mismatched = new LocalManager(f.runtime, [], [{ ...build, ...variant }]);
    assert.deepEqual((await mismatched.list()).recognizedRuntimeIds, []);
  }
  await writeFile(join(f.root, "plugins/surf/index.ts"), "// changed by local user");
  assert.deepEqual((await manager.list()).recognizedRuntimeIds, []);
});

test("official plugin operations require a logged-in same-origin console and JSON mutation", async t => {
  const f = await fixture(t);
  const web = await startWeb({ web: { port: 0 } }, { channels: {}, logger: { info() {}, error() {} } }, f.runtime);
  t.after(() => web.close());
  const address = web.server.address() as { port: number };
  const base = "http://127.0.0.1:" + address.port, path = base + "/api/official-plugins";
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path + "/apply", { method: "POST" })).status, 401);
  const login = await fetch(base + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await fetch(path + "/apply", { method: "POST", headers: { cookie, origin: "https://example.invalid" } })).status, 403);
  assert.equal((await fetch(path + "/apply", { method: "POST", headers: { cookie } })).status, 415);
});

test("graceful shutdown finishes an accepted package transaction before closing plugin services", async t => {
  const { runtime } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  const pending = runtime.managePackages(async () => { await gate; finished = true; });
  const shutdown = runtime.finishManagement();
  await assert.rejects(runtime.managePackages(async () => {}), /正在关闭/);
  assert.equal(finished, false);
  release();
  await Promise.all([pending, shutdown]);
  assert.equal(finished, true);
});
