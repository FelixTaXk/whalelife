import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ensureOfficialPackage } from "../core/official-package-download.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const bytes = "test archive verified bytes";
const sha256 = createHash("sha256").update(bytes).digest("hex");
const repository = "https://github.com/example/plugin";
const asset = { sha256, sizeBytes: Buffer.byteLength(bytes), repository, assetUrl: repository + "/releases/download/v1/plugin.wlpkg.gz" };
const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/100/fixture?signature=temporary";
const cacheDir = (root: string) => join(root, ".artifacts", "official-packages");
const archiveName = sha256 + ".wlpkg.gz";

test("concurrent installations fetch one release, follow the GitHub CDN and reuse the verified cache offline", async t => {
  const root = await temporaryDirectory("whale-official-download-");
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    calls.push(url.href);
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.deepEqual(init.headers, { Accept: "application/octet-stream", "Accept-Encoding": "identity" });
    assert.ok(init.signal);
    if (url.href === asset.assetUrl) return new Response(null, { status: 302, headers: { location: cdn } });
    assert.equal(url.href, cdn);
    return new Response(bytes, { headers: { "content-length": String(asset.sizeBytes) } });
  });
  await Promise.all([ensureOfficialPackage(root, asset), ensureOfficialPackage(root, asset)]);
  assert.equal(await readFile(join(cacheDir(root), archiveName), "utf8"), bytes);
  await ensureOfficialPackage(root, asset);
  assert.deepEqual(calls, [asset.assetUrl, cdn]);
  assert.deepEqual(await readdir(cacheDir(root)), [archiveName]);
});

test("download errors leave no partial archive; the same installation can be retried", async t => {
  const root = await temporaryDirectory("whale-official-download-");
  const responses = [
    new Response(null, { status: 404 }),
    new Response(bytes, { headers: { "content-length": "10000" } }),
    new Response(bytes + "!"), new Response(bytes.slice(1)), new Response("x".repeat(bytes.length)),
    new Response(new ReadableStream({ start(controller) { controller.error(TypeError("connection reset")); } })),
    new Response(bytes),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift()!);
  for (const reason of [/HTTP 404/, /大小/, /超出/, /不完整/, /SHA-256/, /网络/]) {
    await assert.rejects(ensureOfficialPackage(root, asset), reason);
    assert.deepEqual(await readdir(cacheDir(root)), []);
  }
  await ensureOfficialPackage(root, asset);
  assert.deepEqual(await readdir(cacheDir(root)), [archiveName]);
});

test("rejects credentials, foreign release URLs, untrusted redirect destinations and redirect loops", async t => {
  const root = await temporaryDirectory("whale-official-download-");
  const locations = ["https://elsewhere.example/archive", "http://release-assets.githubusercontent.com/file",
    "https://user:pass@objects.githubusercontent.com/file", asset.assetUrl.replace("/example/", "/other/")];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: locations.shift() || asset.assetUrl } });
  });
  const otherURLs = [asset.assetUrl.replace("github.com", "github.com.invalid"), asset.assetUrl.replace("https:", "http:"),
    asset.assetUrl.replace("/example/", "/other/"), asset.assetUrl.replace("github.com", "user:pass@github.com"),
    asset.assetUrl.replace("releases/download", "archive"), asset.assetUrl + "?token=secret"];
  for (const assetUrl of otherURLs) await assert.rejects(ensureOfficialPackage(root, { ...asset, assetUrl }), /发行包地址/);
  await assert.rejects(ensureOfficialPackage(root, { ...asset, sha256: "../foo" }), /SHA-256/);
  assert.equal(calls, 0);
  for (let i = 0; i < 4; i++) await assert.rejects(ensureOfficialPackage(root, asset), /拒绝跳转/);
  await assert.rejects(ensureOfficialPackage(root, asset), /重定向次数/);
  assert.deepEqual(await readdir(cacheDir(root)), []);
});

test("a broken cache is replaced only by a fully verified download", async t => {
  const root = await temporaryDirectory("whale-official-download-");
  const cache = cacheDir(root), target = join(cache, archiveName);
  await mkdir(cache, { recursive: true });
  const old = "?".repeat(bytes.length);
  await writeFile(target, old);
  let content = "!".repeat(bytes.length);
  t.mock.method(globalThis, "fetch", async () => new Response(content));
  await assert.rejects(ensureOfficialPackage(root, asset), /SHA-256/);
  assert.equal(await readFile(target, "utf8"), old);
  content = bytes;
  await ensureOfficialPackage(root, asset);
  assert.equal(await readFile(target, "utf8"), bytes);
  assert.deepEqual(await readdir(cache), [archiveName]);
});

test("a linked cache directory is refused before fetching or writing", async t => {
  const root = await temporaryDirectory("whale-official-download-"), outside = await temporaryDirectory("whale-official-outside-");
  await mkdir(join(root, ".artifacts"));
  await symlink(outside, cacheDir(root), process.platform === "win32" ? "junction" : "dir");
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(bytes));
  await assert.rejects(ensureOfficialPackage(root, asset), /链接/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(await readdir(outside), []);
});

test("shutdown aborts an in-flight release body and removes the owned partial download", async t => {
  const root = await temporaryDirectory("whale-official-download-");
  const shutdown = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once:true });
      ready();
    },
  })));
  const installing = ensureOfficialPackage(root, asset, shutdown.signal);
  await started;
  shutdown.abort(Error("核心正在关闭"));
  await assert.rejects(installing, /核心正在关闭/);
  assert.deepEqual(await readdir(cacheDir(root)), []);
});
