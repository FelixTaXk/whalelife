import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { temporaryDirectory } from "./temporary-directory.ts";
import { Runtime } from "../core/runtime.ts";
import { OfficialPlugins } from "../core/official-plugins.ts";
import { recordCommunityInstalls } from "../core/community-install-receipts.ts";
import {beginUpdateDependencies, recoverUpdateDependencies} from "../core/package-update-journal.ts";
import {installOfficialFiles} from "../core/official-package-files.ts";
import { startWeb } from "../core/web.ts";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function fixture(t: TestContext, broken = false, required = "1.0.0") {
  const root = await temporaryDirectory("whale-official-manager-");
  const cache = join(root, ".artifacts/official-packages");
  await mkdir(cache, { recursive: true });
  const create = async (id: string, parentId: string | null, body: string, version = "1.0.0",
    dependencies: Record<string, string> = parentId ? { [parentId]: required } : {}, manifest: {sub?:string[]} = {}) => {
    const files = [
      ["plugin.yaml", JSON.stringify({ id, name: id, version, description: "fixture", depends: parentId ? [parentId] : [], ...manifest })],
      ["index.ts", body],
    ].map(([path, code]) => ({ path, bytes: Buffer.from(code) }));
    const header = { format: 1, files: files.map(f => ({ path: f.path, size: f.bytes.length, sha256: hash(f.bytes) })) };
    const packed = gzipSync(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), ...files.map(f => f.bytes)]));
    const sha256 = hash(packed);
    await writeFile(join(cache, sha256 + ".wlpkg.gz"), packed);
    const entry = { id, name: id, repository: "https://github.com/testing/" + id, requiredPlugins: Object.keys(dependencies), parentId,
      verifiedReleases: [{ version, hostRange: "0.1.0", platform: process.platform, arch: process.arch, sha256, dependencies }] };
    return { entry, files, packed, inventory: Buffer.from(JSON.stringify(header) + "\n") };
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
  return { root, runtime, manager, get, apply, create, parentFiles: parent.files, packages: [parent, child] };
}

test("confirmed update previews missing dependencies, serializes concurrent requests and keeps a stopped target stopped", async t => {
  const f = await fixture(t);
  await f.apply("surf");
  await f.runtime.action("surf", "stop");
  const lib = await f.create("library", null, "export function apply(){}");
  const next = await f.create("surf", null, "export function apply(){}", "1.1.0", {library:"1.0.0"});
  next.entry.verifiedReleases.push(f.packages[0].entry.verifiedReleases[0]);
  const manager = new OfficialPlugins(f.runtime, [lib.entry, next.entry]);
  const plan = await manager.updatePlan("surf", "1.1.0");
  assert.equal(plan.action, "update");
  assert.deepEqual(plan.steps.map(s => [s.action,s.id]), [["install","library"],["update","surf"]]);
  assert.equal(f.runtime.records.has("library"), false);
  const data = join(f.root, "plugins/surf/data");
  await mkdir(data);
  await writeFile(join(data, "photo"), "photo and tags");
  const results = await Promise.allSettled([manager.apply(plan), manager.apply(plan)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.runtime.records.get("library").status, "active");
  assert.equal(f.runtime.records.get("surf").manifest.version, "1.1.0");
  assert.equal(f.runtime.records.get("surf").status, "stopped");
  assert.equal(f.runtime.pluginState.enabled("surf"), false);
  assert.equal(await readFile(join(data, "photo"), "utf8"), "photo and tags");
  assert.equal((await manager.updatePlan("surf", "1.0.0")).planKey, "");
});

test("failed update restores old program and data, unwinds new dependencies, and restores prior dependency state", async t => {
  const f = await fixture(t);
  await f.apply("surf");
  const original = f.packages[0], lib = await f.create("library", null, "export function apply(){}");
  const next = await f.create("surf", null, `export async function apply(ctx) {
    await ctx.config.save("history", {migration:"new schema"});
    throw Error("upgrade activation failed");
  }`, "1.1.0", {library:"1.0.0"});
  next.entry.verifiedReleases.push(original.entry.verifiedReleases[0]);
  const manager = new OfficialPlugins(f.runtime, [next.entry, lib.entry]);
  const data = join(f.root, "plugins/surf/data");
  await mkdir(data);
  await writeFile(join(data, "history"), "old history");
  for (const dependency of ["install", "enable", "reuse"]) {
    if (dependency === "enable") {
      await manager.apply((await manager.list()).plugins.find(p => p.id === "library")!);
      await f.runtime.action("library", "stop");
    } else if (dependency === "reuse") await f.runtime.action("library", "start");
    const plan = await manager.updatePlan("surf","1.1.0");
    assert.equal(plan.steps[0].action, dependency);
    await assert.rejects(manager.apply(plan), (error: any) =>
      /upgrade activation failed/.test(error.message) && !error.message.includes("未能自动撤回") && error.rolledBack.length > 0);
    assert.equal(await readFile(join(data,"history"), "utf8"), "old history");
    assert.equal(f.runtime.records.get("surf").manifest.version, "1.0.0");
    assert.equal(f.runtime.records.get("surf").status, "active");
    assert.deepEqual(await readFile(join(f.root,"plugins/surf/index.ts")), original.files[1].bytes);
    assert.equal(f.runtime.records.get("library")?.status, {install:undefined, enable:"stopped", reuse:"active"}[dependency]);
  }
});

test("an update that removes a live service restores its provider and downstream consumers", async t => {
  const f = await fixture(t);
  await f.apply("surf");
  const consumer = join(f.root, "plugins", "service-user");
  await mkdir(consumer);
  await writeFile(join(consumer, "plugin.yaml"), JSON.stringify({
    id:"service-user", name:"服务使用者", version:"1.0.0", description:"fixture", depends:["surf"],
  }));
  await writeFile(join(consumer, "index.ts"), "export function apply(){}");
  assert.equal((await f.runtime.loadPath("service-user")).status, "active");
  const next = await f.create("surf", null, "export function apply(){}", "1.1.0");
  next.entry.verifiedReleases.push(f.packages[0].entry.verifiedReleases[0]);
  const manager = new OfficialPlugins(f.runtime, [next.entry]);
  await assert.rejects(manager.apply(await manager.updatePlan("surf","1.1.0")), /无法恢复更新前运行的插件：service-user/);
  assert.equal(f.runtime.records.get("surf").manifest.version,"1.0.0");
  assert.equal(f.runtime.records.get("surf").status,"active");
  assert.equal(f.runtime.records.get("service-user").status,"active");
});

test("a new parent cannot hide an already installed disabled independent child", async t => {
  const f = await fixture(t);
  await f.apply("surf");
  const child = join(f.root,"plugins/surf/sub/manual");
  await mkdir(child,{recursive:true});
  await writeFile(join(child,"plugin.yaml"), JSON.stringify({id:"manual",name:"独立子插件",version:"1.0.0",description:"fixture"}));
  await writeFile(join(child,"index.ts"), "export function apply(){}");
  await f.runtime.pluginState.setEnabled("surf/manual",false);
  assert.equal((await f.runtime.loadPath("surf/manual")).status, "stopped");
  const next = await f.create("surf",null,"export function apply(){}", "1.1.0", {}, {sub:[]});
  next.entry.verifiedReleases.push(f.packages[0].entry.verifiedReleases[0]);
  const manager = new OfficialPlugins(f.runtime,[next.entry]);
  await assert.rejects(manager.apply(await manager.updatePlan("surf","1.1.0")), /无法继续加载已安装的独立子插件/);
  assert.equal(f.runtime.records.get("surf").manifest.version, "1.0.0");
  assert.equal(f.runtime.records.get("surf/manual").status, "stopped");
  assert.equal(await readFile(join(child,"index.ts"),"utf8"), "export function apply(){}");
});

test("a restarted host can recognize and uninstall an approved version newer than its offline catalog", async t => {
  const f = await fixture(t);
  await f.apply("surf");
  const next = await f.create("surf",null,"export function apply(){}", "1.1.0");
  next.entry.verifiedReleases.push(f.packages[0].entry.verifiedReleases[0]);
  const online = new OfficialPlugins(f.runtime,[next.entry]);
  await online.apply(await online.updatePlan("surf","1.1.0"));
  await f.runtime.bus.stop();
  const runtime = new Runtime(f.root, { info(){}, warn(){}, error(){} } as any);
  t.after(() => runtime.bus.stop());
  await runtime.bus.start();
  await runtime.scan();
  const offline = new OfficialPlugins(runtime,[f.packages[0].entry]);
  const before = await offline.list();
  assert.deepEqual(before.recognizedRuntimeIds, ["surf"]);
  assert.equal(before.plugins[0].installedVersion,"1.1.0");
  const script = join(f.root,"plugins/surf/index.ts");
  const original = await readFile(script);
  await writeFile(script,"// user edited");
  assert.deepEqual((await offline.list()).recognizedRuntimeIds, []);
  await assert.rejects(offline.apply(before.plugins[0]));
  await writeFile(script,original);
  await offline.apply((await offline.list()).plugins[0]);
  const fresh = (await offline.list()).plugins[0];
  assert.equal(fresh.installed,false);
  assert.equal(fresh.version,"1.0.0");
});

test("restart undoes interrupted dependency changes but keeps committed or newly shared dependencies", async t => {
  for (const mode of ["uncommitted", "partial", "committed", "new-consumer"]) {
    const f = await fixture(t);
    await f.apply("surf");
    const old = await f.create("old-library",null,"export function apply(){}");
    const fresh = await f.create("new-library",null,"export function apply(){}");
    const manager = new OfficialPlugins(f.runtime,[old.entry]);
    await manager.apply((await manager.list()).plugins[0]);
    await f.runtime.action("old-library","stop");
    const id = randomUUID(), sha = "d".repeat(64);
    const first = {id:"old-library", action:"enable" as const, enabled:false, mayRemove:false, bundled:[], dependencies:[],
      files:{directory:"plugins/old-library",sha256:old.entry.verifiedReleases[0].sha256}};
    const second = {id:"new-library", action:"install" as const, enabled:true, mayRemove:true, bundled:[], dependencies:[],
      files:{directory:"plugins/new-library",sha256:fresh.entry.verifiedReleases[0].sha256}};
    const journal = await beginUpdateDependencies(f.root,id,"surf",sha,[first,second]);
    await journal!.start(first.id);
    await f.runtime.pluginState.setEnabled(first.id,true);
    await journal!.start(second.id);
    await installOfficialFiles(f.root,second.files);
    if (mode === "partial") await unlink(join(f.root,second.files.directory,"plugin.yaml"));
    await mkdir(join(f.root,second.files.directory,"data"));
    await writeFile(join(f.root,second.files.directory,"data/mine"), "mine");
    if (mode === "new-consumer") {
      const third = await f.create("new-consumer",null,"export function apply(){}");
      await installOfficialFiles(f.root,{directory:"plugins/new-consumer",sha256:third.entry.verifiedReleases[0].sha256});
    } else {
      // A stale successful operation can have exactly the same SHA, but not this transaction ID.
      await recordCommunityInstalls(f.root,[],[{id:"surf",name:"surf",version:"1.1.0",sha256:sha,
        transactionId:mode === "committed" ? id : randomUUID(), repository:f.packages[0].entry.repository, platform:process.platform,
        arch:process.arch,dependencies:[],bundledPluginIds:[],preserve:[]}]);
    }
    await f.runtime.bus.stop();
    const restarted = new Runtime(f.root, {info(){},warn(){},error(){}} as any);
    t.after(() => restarted.bus.stop());
    await restarted.bus.start();
    await recoverUpdateDependencies(restarted);
    await restarted.scan();
    assert.equal(restarted.pluginState.enabled(first.id),mode === "committed");
    assert.equal(restarted.records.has(second.id),mode === "committed" || mode === "new-consumer");
    assert.equal(await readFile(join(f.root,second.files.directory,"data/mine"),"utf8"), "mine");
    assert.equal((await readdir(join(f.root,".artifacts/official-packages"))).some(n => n.includes("dependencies-")),false);
  }
});

test("update rejects incompatible and changed dependencies, locally edited files and stale plans", async t => {
  const f = await fixture(t);
  await f.apply("surf");
  const lib = await f.create("library", null, "export function apply(){}");
  const next = await f.create("surf", null, "export function apply(){}", "1.1.0", {library:"1.0.0"});
  next.entry.verifiedReleases.push(f.packages[0].entry.verifiedReleases[0]);
  const manager = new OfficialPlugins(f.runtime, [next.entry, lib.entry, f.packages[1].entry]);
  const fresh = await manager.updatePlan("surf", "1.1.0");
  await manager.apply((await manager.list()).plugins.find(p => p.id === "library")!);
  await assert.rejects(manager.apply(fresh), /状态已变化/);
  next.entry.verifiedReleases[0].dependencies.library = "2.0.0";
  assert.match((await manager.updatePlan("surf","1.1.0")).reason,/先升级library/);
  next.entry.verifiedReleases[0].dependencies.library = "1.0.0";
  await f.apply("bilibili");
  const reverse = await manager.updatePlan("surf","1.1.0");
  assert.equal(reverse.planKey, "");
  assert.match(reverse.reason,/bilibili.*依赖/);
  await f.apply("bilibili");
  const valid = await manager.updatePlan("surf","1.1.0");
  const script = join(f.root, "plugins/surf/index.ts");
  await writeFile(script, "// changed locally");
  await assert.rejects(manager.apply(valid));
  assert.equal(await readFile(script,"utf8"), "// changed locally");
  assert.equal(f.runtime.records.get("surf").manifest.version, "1.0.0");
});

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
    "community-install-receipts.ts", "plugin-replacement-recovery.ts", "package-update-journal.ts", "plugin-state.ts", "memory.ts"]) {
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
