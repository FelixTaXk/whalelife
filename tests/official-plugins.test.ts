import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { temporaryDirectory } from "./temporary-directory.ts";
import { Runtime } from "../core/runtime.ts";
import { OfficialPlugins } from "../core/official-plugins.ts";
import { recordCommunityInstalls } from "../core/community-install-receipts.ts";
import { startWeb } from "../core/web.ts";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function fixture(t: TestContext, broken = false, required = "1.0.0", parentVersion = "1.0.0") {
  const root = await temporaryDirectory("whale-official-manager-");
  const cache = join(root, ".artifacts/official-packages");
  await mkdir(cache, { recursive: true });
  const create = async (id: string, parentId: string | null, body: string, version = "1.0.0") => {
    const files = [
      ["plugin.yaml", JSON.stringify({ id, name: id, version, description: "fixture", depends: parentId ? [parentId] : [] })],
      ["index.ts", body],
    ].map(([path, code]) => ({ path, bytes: Buffer.from(code) }));
    const header = { format: 1, files: files.map(f => ({ path: f.path, size: f.bytes.length, sha256: hash(f.bytes) })) };
    const packed = gzipSync(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), ...files.map(f => f.bytes)]));
    const sha256 = hash(packed);
    await writeFile(join(cache, sha256 + ".wlpkg.gz"), packed);
    const entry = { id, name: id, repository: "", requiredPlugins: parentId ? [parentId] : [], parentId,
      verifiedReleases: [{ version, hostRange: "0.1.0", platform: process.platform, arch: process.arch, sha256,
        dependencies: parentId ? { [parentId]: required } : {} }] };
    return { entry, files, packed, inventory: Buffer.from(JSON.stringify(header) + "\n") };
  };
  const createParent = (version: string) => create("surf", null, 'export function apply(ctx){ctx.provide("surf",{ ping(){return true} })}', version);
  const parent = await createParent(parentVersion);
  const child = await create("bilibili", "surf", broken ? 'export function apply(){throw Error("test initialization failure")}' : "export function apply(){}");
  const runtime = new Runtime(root, { info() {}, warn() {}, error() {} } as any);
  t.after(() => runtime.bus.stop());
  await runtime.bus.start();
  await runtime.scan();
  const manager = new OfficialPlugins(runtime, [parent.entry, child.entry]);
  const get = async (id: string) => (await manager.list()).plugins.find(p => p.id === id)!;
  const apply = async (id: string) => manager.apply(await get(id));
  return { root, runtime, manager, get, apply, createParent, parentFiles: parent.files, packages: [parent, child] };
}

test("停用的社区插件仍保护其经审核的必需插件，重读安装记录不依赖在线目录", async t => {
  const f = await fixture(t);
  await f.apply("surf");
  const dir = join(f.root, "plugins", "sample");
  await mkdir(dir);
  await writeFile(join(dir, "plugin.yaml"), JSON.stringify({id:"sample", name:"示例", version:"1.0.0", description:"测试"}));
  await f.runtime.pluginState.setEnabled("sample", false);
  assert.equal((await f.runtime.loadPath("sample")).status, "stopped");
  await recordCommunityInstalls(f.root, [{id:"sample", name:"示例", version:"1.0.0", sha256:"a".repeat(64), dependencies:["surf"]}]);
  const plan = await f.get("surf");
  assert.equal(plan.action, null);
  assert.match(plan.reason, /请先卸载依赖它的插件：示例/);
});

async function isolatedManager(root: string, plugins: unknown[], installedBuilds: unknown[] = []) {
  const core = join(root, "core"), market = join(root, "market");
  await mkdir(core);
  await mkdir(join(market, "inventories"), { recursive: true });
  for (const file of ["official-plugins.ts", "official-package-files.ts", "official-package-download.ts",
    "community-install-receipts.ts", "plugin-state.ts", "memory.ts"]) {
    await copyFile(new URL("../core/" + file, import.meta.url), join(core, file));
  }
  await writeFile(join(market, "official-releases.json"), JSON.stringify({ plugins, installedBuilds }));
  await writeFile(join(market, "catalog.json"), JSON.stringify({ official: [], community: [] }));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "0.1.0" }));
  return (await import(pathToFileURL(join(core, "official-plugins.ts")).href)).OfficialPlugins as typeof OfficialPlugins;
}

test("an empty cache downloads only on confirmation and verifies every dependency before activating any", async t => {
  const f = await fixture(t);
  const cache = join(f.root, ".artifacts/official-packages");
  const assets = new Map<string, Buffer>();
  const entries = [];
  for (const { entry, packed, inventory } of f.packages) {
    const release = entry.verifiedReleases[0];
    await unlink(join(cache, release.sha256 + ".wlpkg.gz"));
    const repository = "https://github.com/example/" + entry.id;
    const assetUrl = repository + "/releases/download/v1.0.0/package.wlpkg.gz";
    assets.set(assetUrl, packed);
    entries.push({ ...entry, repository, verifiedReleases: [{ ...release, assetUrl, sizeBytes: packed.length, inventorySha256: hash(inventory) }] });
  }
  const LocalManager = await isolatedManager(f.root, entries);
  for (const { inventory } of f.packages)
    await writeFile(join(f.root, "market/inventories", hash(inventory) + ".json"), inventory);
  const manager = new LocalManager(f.runtime);
  const plan = async () => (await manager.list()).plugins.find(p => p.id === "bilibili")!;
  const requests: string[] = [];
  let corrupt = true;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    const bytes = Buffer.from(assets.get(url.href)!);
    if (url.pathname.includes("/bilibili/") && corrupt) bytes[0] ^= 1;
    requests.push(url.href);
    return new Response(new Uint8Array(bytes));
  });
  const first = await plan();
  assert.equal(first.action, "install");
  assert.deepEqual(first.steps.map(s => s.action), ["install", "install"]);
  assert.equal(requests.length, 0);
  assert.deepEqual(await readdir(cache), []);
  await assert.rejects(manager.apply(first), (err: any) => /bilibili.*下载并校验.*SHA-256/.test(err.message) && err.rolledBack.length === 0);
  assert.deepEqual(requests, [...assets.keys()]);
  assert.equal(f.runtime.records.size, 0);
  assert.deepEqual(await readdir(cache), [entries[0].verifiedReleases[0].sha256 + ".wlpkg.gz"]);
  const parentPlan = (await manager.list()).plugins.find(p => p.id === "surf")!;
  await manager.apply(parentPlan);
  await f.runtime.action("surf", "stop");
  const retry = await plan();
  assert.deepEqual(retry.steps.map(s => s.action), ["enable", "install"]);
  await assert.rejects(manager.apply(retry), /SHA-256/);
  assert.equal(f.runtime.pluginState.enabled("surf"), false);
  corrupt = false;
  await manager.apply(retry);
  assert.deepEqual((await manager.list()).recognizedRuntimeIds.sort(), ["surf", "surf/bilibili"]);
  assert.equal(f.runtime.records.get("surf/bilibili").status, "active");
  assert.equal(requests.filter(url => url.includes("/surf/")).length, 1);
  for (const file of await readdir(cache)) await unlink(join(cache, file));
  const downloadsBefore = requests.length;
  await manager.apply(await plan());
  assert.equal(f.runtime.records.get("surf").status, "active");
  assert.equal(requests.length, downloadsBefore);
});

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

test("official children install the latest compatible parent and reuse an intact installed release above their floor", async t => {
  const f = await fixture(t, false, "0.22.0", "0.22.0");
  const releases = f.packages[0].entry.verifiedReleases;
  const next = (await f.createParent("0.23.0")).entry.verifiedReleases[0];
  releases.push(next);
  const plan = () => f.get("bilibili");
  releases.push((await f.createParent("0.9.0")).entry.verifiedReleases[0]);
  releases.push((await f.createParent("2.0.0-rc.1")).entry.verifiedReleases[0]);
  const fresh = await plan();
  assert.deepEqual(fresh.steps.map(s => [s.action, s.version]), [["install", "0.23.0"], ["install", "1.0.0"]]);
  await f.apply("surf");
  await assert.rejects(f.manager.apply(fresh), /刷新/);
  const later = (await f.createParent("1.0.0")).entry.verifiedReleases[0];
  releases.push(later);
  assert.deepEqual((await plan()).steps.map(s => [s.action, s.version]), [["reuse", "0.23.0"], ["install", "1.0.0"]]);
  await f.runtime.action("surf", "stop");
  const stopped = await plan();
  assert.equal(stopped.steps[0].action, "enable");
  await f.manager.apply(stopped);
  assert.equal(f.runtime.records.get("surf/bilibili")?.status, "active");
  await f.apply("bilibili");
  next.hostRange = "0.2.0";
  assert.equal((await plan()).action, null);
  next.hostRange = "0.1.0";
  await f.apply("surf");
  assert.equal((await plan()).steps[0].version, "1.0.0");
  later.hostRange = "0.2.0";
  assert.equal((await plan()).steps[0].version, "0.23.0");
  await f.apply("surf");
  await writeFile(join(f.root, "plugins/surf/index.ts"), "// locally changed");
  assert.equal((await plan()).action, null);
});

test("a shared official parent satisfies the child's floor and other consumers' exact pins in either dependency order", async t => {
  const f = await fixture(t, false, "0.22.0", "0.22.0");
  const [parent, child] = f.packages.map(p => p.entry);
  parent.verifiedReleases.push((await f.createParent("0.23.0")).entry.verifiedReleases[0]);
  // The community manager presents official children under their full runtime IDs.
  const childId = "surf/bilibili";
  const flatChild = { ...child, id: childId, parentId: null };
  const pinned: Record<string, string> = { surf: "0.22.0", [childId]: "1.0.0" };
  const consumer = { ...parent, id: "consumer", community: true, requiredPlugins: [childId, "surf"],
    verifiedReleases: [{ ...parent.verifiedReleases[0], dependencies: pinned }] };
  const manager = new OfficialPlugins(f.runtime, [parent, flatChild, consumer], [], [], {
    async available() {}, async verify() {}, async installed() {},
  });
  const plan = async () => (await manager.list()).plugins.find(p => p.id === "consumer")!;
  for (const order of [[childId, "surf"], ["surf", childId]]) {
    consumer.requiredPlugins = order;
    assert.deepEqual((await plan()).steps.map(s => [s.id, s.version]), [["surf", "0.22.0"], [childId, "1.0.0"], ["consumer", "0.22.0"]]);
  }
  pinned.surf = "0.21.0";
  parent.verifiedReleases.push((await f.createParent("0.21.0")).entry.verifiedReleases[0]);
  assert.equal((await plan()).action, null);
  delete pinned.surf;
  consumer.requiredPlugins = [childId];
  assert.equal((await plan()).steps[0].version, "0.23.0");
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
  const market = join(f.root, "market");
  const inventory = Buffer.from(JSON.stringify({ format: 1,
    files: f.parentFiles.map(file => ({ path: file.path, size: file.bytes.length, sha256: hash(file.bytes) })),
  }));
  const build = { runtimeId: "surf", version: "1.0.0", platform: process.platform, arch: process.arch,
    sourceCommit: "1".repeat(40), sha256: hash(inventory) };
  const LocalManager = await isolatedManager(f.root, [], [build]);
  await writeFile(join(market, "inventories", build.sha256 + ".json"), inventory);
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

test("official and community plugin operations require a logged-in same-origin console and JSON mutation", async t => {
  const f = await fixture(t);
  const web = await startWeb({ web: { port: 0 } }, { channels: {}, logger: { info() {}, error() {} } }, f.runtime);
  t.after(() => web.close());
  const address = web.server.address() as { port: number };
  const base = "http://127.0.0.1:" + address.port;
  const login = await fetch(base + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  for (const route of ["/api/official-plugins", "/api/community-plugins"]) {
    const path = base + route;
    assert.equal((await fetch(path)).status, 401);
    assert.equal((await fetch(path + "/apply", { method: "POST" })).status, 401);
    assert.equal((await fetch(path + "/apply", { method: "POST", headers: { cookie, origin: "https://example.invalid" } })).status, 403);
    assert.equal((await fetch(path + "/apply", { method: "POST", headers: { cookie } })).status, 415);
  }
  const suppliedAsset = await fetch(base + "/api/community-plugins/apply", {
    method: "POST", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sample", action: "install", planKey: "a".repeat(64), assetUrl: "https://example.invalid/sample.gz" }),
  });
  assert.equal(suppliedAsset.status, 400);
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

test("shutdown while activating a second plugin protects both packages through rollback", async t => {
  const f = await fixture(t);
  const load = f.runtime.loadPath.bind(f.runtime);
  const stop = f.runtime.stop.bind(f.runtime);
  let closing: Promise<void> | undefined;
  t.mock.method(f.runtime, "loadPath", async (id: string) => {
    if (id === "surf/bilibili") {
      assert.equal(f.runtime.records.get("surf").status, "active");
      assert.ok(f.runtime.pendingPackageCommit);
      closing = f.runtime.finishManagement();
    }
    return load(id);
  });
  t.mock.method(f.runtime, "stop", async (id: string) => {
    assert.ok(f.runtime.pendingPackageCommit);
    return stop(id);
  });
  const plan = await f.get("bilibili");
  await assert.rejects(f.manager.apply(plan), (error: any) => /正在关闭/.test(error.message) &&
    error.rolledBack.join(",") === "撤回新装的bilibili,撤回新装的surf");
  assert.ok(closing); await closing;
  assert.equal(f.runtime.pendingPackageCommit, undefined);
  assert.equal(f.runtime.records.size, 0);
  await assert.rejects(readFile(join(f.root,"plugins/surf/plugin.yaml")), { code:"ENOENT" });
  await assert.rejects(readFile(join(f.root,"plugins/surf/sub/bilibili/plugin.yaml")), { code:"ENOENT" });
});
