import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CommunityPackages, type ReviewedCommunityEntry, type ReviewedCommunityRelease } from "../core/community-packages.ts";
import { Runtime } from "../core/runtime.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const program = "export function apply(){}";
async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-community-install-");
  const runtime = new Runtime(root, {info() {}, error() {}, warn() {}} as any);
  t.after(() => runtime.bus.stop());
  await runtime.bus.start();
  await runtime.scan();
  const assets = new Map<string, Buffer>(), downloads: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    downloads.push(url.href);
    const bytes = assets.get(url.href);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, {status:404});
  });
  function plugin(id: string, version = "1.0.0", options: {deps?: Record<string,string>; extra?: Record<string,string>;
    children?: string[]; source?: string; manifest?: Record<string,unknown>} = {}) {
    const repository = "https://github.com/testing/" + id.replaceAll("/", "-");
    const assetUrl = repository + "/releases/download/v" + version + "/plugin.wlpkg.gz";
    const manifest = {id:id.split("/").at(-1), name:id, version, description:"test", ...options.manifest};
    const files = Object.entries({"plugin.yaml":JSON.stringify(manifest), "index.ts":options.source ?? program, ...options.extra})
      .map(([path, text]) => ({path, bytes:Buffer.from(text)}));
    const inventory = files.map(f => ({path:f.path, size:f.bytes.length, sha256:hash(f.bytes)}));
    const packed = gzipSync(Buffer.concat([Buffer.from(JSON.stringify({format:1, files:inventory}) + "\n"), ...files.map(f => f.bytes)]));
    assets.set(assetUrl, packed);
    const release: ReviewedCommunityRelease = {version, platform:"any", arch:"any", hostRange:"0.1.0",
      sha256:hash(packed), sizeBytes:packed.length, assetUrl, dependencies:options.deps ?? {}, bundledPluginIds:options.children};
    const entry: ReviewedCommunityEntry = {id, name:id, description:"fixture", repository, installation:repository,
      dependencies:Object.keys(release.dependencies), verifiedReleases:[release]};
    return {entry, release, packed};
  }
  return {root, runtime, assets, downloads, plugin, manager:(entries: ReviewedCommunityEntry[]) => new CommunityPackages(runtime, entries)};
}
async function row(manager: CommunityPackages, id: string) {
  const result = (await manager.list()).plugins.find(p => p.id === id);
  assert.ok(result);
  return result;
}

test("cold install uses reviewed bytes only on confirmation, keeps old data, and serializes double clicks", async t => {
  const f = await fixture(t), top = f.plugin("notes"), manual = {...f.plugin("manual").entry, verifiedReleases:undefined};
  const manager = f.manager([top.entry, manual]);
  await mkdir(join(f.root, "plugins/notes/data"), {recursive:true});
  await writeFile(join(f.root, "plugins/notes/data/entry"), "old note");
  const plan = await row(manager, "notes");
  assert.equal(plan.action, "install");
  assert.deepEqual((await manager.list()).plugins.map(p => p.id), ["notes"]);
  await assert.rejects(manager.apply({id:"notes",action:"install",planKey:"stale"}), /重新确认|状态已变化/);
  await assert.rejects(manager.apply({id:"manual",action:"install",planKey:plan.planKey}), /审核/);
  assert.deepEqual(f.downloads, []);
  const result = await Promise.allSettled([manager.apply(plan), manager.apply(plan)]);
  assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
  assert.deepEqual(f.downloads, [top.release.assetUrl]);
  assert.equal(f.runtime.records.get("notes").status, "active");
  assert.equal(await readFile(join(f.root,"plugins/notes/data/entry"),"utf8"), "old note");
  assert.equal((await row(manager,"notes")).action,"installed");
  const receipts = JSON.parse(await readFile(join(f.root,"config/community-installs.json"),"utf8")).installs;
  assert.deepEqual(receipts.map((r:any) => [r.id,r.sha256]), [["notes",top.release.sha256]]);
});

test("a same-ID manual installation with different code is neither adopted nor overwritten", async t => {
  const f = await fixture(t), note = f.plugin("notes"), manager = f.manager([note.entry]);
  await mkdir(join(f.root,"plugins/notes"), {recursive:true});
  await writeFile(join(f.root,"plugins/notes/plugin.yaml"), JSON.stringify({id:"notes",name:"other",description:"other",version:"1.0.0"}));
  await writeFile(join(f.root,"plugins/notes/index.ts"), program + " // local");
  await f.runtime.loadPath("notes");
  const plan = await row(manager,"notes");
  assert.equal(plan.action,"blocked"); assert.match(plan.reason,/归属/);
  await assert.rejects(manager.apply({...plan,action:"install"}));
  assert.deepEqual(f.downloads,[]);
  assert.equal(await readFile(join(f.root,"plugins/notes/index.ts"),"utf8"),program + " // local");
});

test("pin a dependency's reviewed version; reuse or explicitly enable it and restore its old state after failed activation", async t => {
  const f = await fixture(t), base = f.plugin("test-provider"), newer = f.plugin("test-provider","1.1.0");
  const child = f.plugin("test-provider/child","1.0.0",{deps:{"test-provider":"1.0.0"},source:'export function apply(){throw Error("fixture activation")}'});
  base.entry.verifiedReleases!.push(newer.release);
  const manager = f.manager([base.entry, child.entry]);
  const fresh = await row(manager,child.entry.id);
  assert.deepEqual(fresh.steps.map(s => [s.id,s.version,s.action]), [["test-provider","1.0.0","install"],[child.entry.id,"1.0.0","install"]]);
  await assert.rejects(manager.apply(fresh), (e:any) => /fixture activation/.test(e.message) && e.rolledBack.length === 2);
  assert.equal(f.runtime.records.has("test-provider"),false);
  await assert.rejects(readFile(join(f.root,"plugins/test-provider/plugin.yaml")), {code:"ENOENT"});
  const oldOnly = f.manager([{...base.entry,verifiedReleases:[base.release]},child.entry]);
  await oldOnly.apply(await row(oldOnly,"test-provider"));
  assert.equal((await row(manager,child.entry.id)).steps[0].action,"reuse");
  await f.runtime.action("test-provider","stop");
  const stopped = await row(manager,child.entry.id);
  assert.equal(stopped.steps[0].action,"enable");
  await assert.rejects(manager.apply(stopped), /fixture activation/);
  assert.equal(f.runtime.pluginState.enabled("test-provider"),false);
  assert.equal(f.runtime.records.get("test-provider").status,"stopped");
  assert.equal(f.runtime.records.has(child.entry.id),false);
});

test("a reviewed bundled child is activated and identified without taking another plugin's directory", async t => {
  const f = await fixture(t);
  const bundle = f.plugin("studio-tools", "1.0.0", {children:["studio-tools/brush"], manifest:{sub:["brush"]}, extra:{
    "sub/brush/plugin.yaml":JSON.stringify({id:"brush",name:"Brush",description:"fixture",version:"0.3.0"}),
    "sub/brush/index.ts":program,
  }});
  const manager = f.manager([bundle.entry]);
  await manager.apply(await row(manager, bundle.entry.id));
  assert.equal(f.runtime.records.get("studio-tools/brush").status, "active");
  assert.equal((await row(manager, bundle.entry.id)).action, "installed");
  await assert.rejects(manager.apply({id:"studio-tools/brush",action:"install",planKey:"unknown"}));
});

test("corrupt bytes and identity or undeclared child mismatches fail before a dependency is installed", async t => {
  const f = await fixture(t), base = f.plugin("library"), deps = {library:"1.0.0"};
  const bad = f.plugin("bad","1.0.0",{deps}), packed = Buffer.from(bad.packed);
  packed[0] ^= 0xff; f.assets.set(bad.release.assetUrl, packed);
  const wrong = f.plugin("wrong","1.0.0",{deps,manifest:{id:"something-else"}});
  const extra = f.plugin("extra","1.0.0",{deps,extra:{"sub/shadow/index.ts":program}});
  for (const target of [bad,wrong,extra]) {
    const manager = f.manager([base.entry,target.entry]);
    await assert.rejects(manager.apply(await row(manager,target.entry.id)), (e:any) =>
      /SHA-256|插件清单|子插件文件/.test(e.message) && e.rolledBack.length === 0);
    assert.equal(f.runtime.records.size,0);
    await assert.rejects(readFile(join(f.root,"plugins/library/plugin.yaml")), {code:"ENOENT"});
  }
});
