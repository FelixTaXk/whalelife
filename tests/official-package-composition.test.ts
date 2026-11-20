import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { ensureComposedOfficialPackage } from "../core/official-package-composition.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const repository = "https://github.com/example/plugin";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const asset = (name: string, bytes: Buffer) => ({
  repository, assetUrl: repository + "/releases/download/v1/" + name, sha256: digest(bytes), sizeBytes: bytes.length,
});

function zip(entries: [string, string, boolean][]) {
  const files: Buffer[] = [], records: Buffer[] = [];
  let offset = 0;
  for (const [name, content, deflate] of entries) {
    const bytes = Buffer.from(content), filename = Buffer.from(name), packed = deflate ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    local.copy(record, 6, 4, 28);
    record.writeUInt32LE(offset, 42);
    records.push(record, filename);
    files.push(local, filename, packed);
    offset += local.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}

const files = [["decoder/a", "abc"], ["plugin.yaml", "id: vision\n"], ["runtime/b", "payload".repeat(60_000)]]
  .map(([path, content]) => ({ path, bytes: Buffer.from(content) }));
function pack(list: typeof files) {
  const inventory = Buffer.from(JSON.stringify({ format: 1, files: list.map(({ path, bytes }) =>
    ({ path, size: bytes.length, sha256: digest(bytes) })) }) + "\n");
  return { inventory, data: gzipSync(Buffer.concat([inventory, ...list.map(f => f.bytes)]), { level: 6 }) };
}
const final = pack(files), part = pack([files[1]]), mappings = [
  { path: "decoder/a", member: "upstream/a" }, { path: "runtime/b", member: "upstream/b" },
];
const zipEntries: [string, string, boolean][] = [
  ["upstream/a", files[0].bytes.toString(), false], ["upstream/other", "unused", false],
  ["upstream/b", files[2].bytes.toString(), true],
];
function recipe(bytes: Buffer) {
  return { sha256: digest(final.data), sizeBytes: final.data.length, inventory: final.inventory,
    packagePart: asset("part.gz", part.data), zipPart: { ...asset("vendor.zip", bytes), files: mappings } };
}

test("two pinned downloads reproduce the original release byte for byte and work offline on retry", async t => {
  const root = await temporaryDirectory("whale-composition-"), vendor = zip(zipEntries), spec = recipe(vendor);
  const network = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.ok(url.href === spec.zipPart.assetUrl || url.href === spec.packagePart.assetUrl);
    return new Response(new Uint8Array(url.href === spec.zipPart.assetUrl ? vendor : part.data));
  });
  await Promise.all([ensureComposedOfficialPackage(root, spec), ensureComposedOfficialPackage(root, spec)]);
  assert.deepEqual(await readFile(join(root, ".artifacts/official-packages", spec.sha256 + ".wlpkg.gz")), final.data);
  await ensureComposedOfficialPackage(root, spec);
  assert.equal(network.mock.callCount(), 2);
});

test("composition rejects conflicting members, altered files, invalid partial metadata and final digest", async t => {
  let vendor = zip(zipEntries), partial = part.data;
  t.mock.method(globalThis, "fetch", async (url: URL) =>
    new Response(new Uint8Array(url.pathname.endsWith("part.gz") ? partial : vendor)));
  for (const error of ["missing", "duplicate", "changed", "partial", "digest"]) {
    const root = await temporaryDirectory("whale-composition-");
    vendor = zip(error === "missing" ? zipEntries.slice(1) : error === "duplicate" ? [...zipEntries, zipEntries[0]] :
      error === "changed" ? [["upstream/a", "xyz", false], ...zipEntries.slice(1)] : zipEntries);
    partial = error === "partial" ? gzipSync(Buffer.from("invalid inventory".repeat(30))) : part.data;
    const spec = { ...recipe(vendor), packagePart: asset("part.gz", partial) };
    if (error === "digest") spec.sha256 = "9".repeat(64);
    await assert.rejects(ensureComposedOfficialPackage(root, spec), /ZIP|组装文件校验|部分包清单|SHA-256/);
    const cache = await readdir(join(root, ".artifacts/official-packages"));
    assert.deepEqual(cache.sort(), [spec.zipPart.sha256, spec.packagePart.sha256].map(s => s + ".wlpkg.gz").sort());
  }
});
