import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Runtime } from "../core/runtime.ts";
import { startWeb } from "../core/web.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-plugin-state-"));
  const logger: any = { info() {}, warn() {}, error() {} };
  const hits: string[] = [], cleanups: string[] = [];
  let runtime: Runtime;
  const plugin = async (id: string, body = "", manifest: any = {}) => {
    const dir = join(root, "plugins", id.split("/").join("/sub/"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), JSON.stringify({ id: id.split("/").at(-1), name: id, description: "fixture", version: "1.0.0", ...manifest }));
    await writeFile(join(dir, "index.ts"), `export async function apply(ctx) {
      const probe = ctx.get('probe'); probe.hits.push(${JSON.stringify(id)});
      ctx.effect(() => () => probe.cleanups.push(${JSON.stringify(id)}));
      ${body}
    }`);
    return dir;
  };
  const boot = async () => {
    if (runtime) await runtime.bus.stop();
    runtime = new Runtime(root, logger);
    await runtime.builtin("probe", { hits, cleanups });
    await runtime.bus.start();
    await runtime.scan();
    return runtime;
  };
  const state = async () => JSON.parse(await readFile(join(root, "config/plugins.json"), "utf8"));
  t.after(async () => {
    await runtime?.bus.stop();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, plugin, boot, state, hits, cleanups };
}

test("an explicit stop survives a cold restart without importing the disabled entry; enabling persists too", async (t) => {
  const f = await fixture(t), dir = await f.plugin("qq");
  let runtime = await f.boot();
  await runtime.action("qq", "stop");
  assert.deepEqual((await f.state()).disabled, ["qq"]);
  assert.deepEqual(f.cleanups, ["qq"]);
  await writeFile(join(dir, "index.ts"), "throw Error('disabled code must not run');");
  runtime = await f.boot();
  assert.equal(runtime.records.get("qq").status, "stopped");
  assert.equal(runtime.list().find(x => x.id === "qq")?.enabled, false);
  assert.deepEqual(f.hits, ["qq"]);
  await f.plugin("qq");
  await runtime.action("qq", "start");
  assert.deepEqual((await f.state()).disabled, []);
  runtime = await f.boot();
  assert.equal(runtime.records.get("qq").status, "active");
  assert.deepEqual(f.hits, ["qq", "qq", "qq"]);
});

test("parent off blocks children; child choices survive explicit loading, parent reload and cold restart", async (t) => {
  const f = await fixture(t);
  await f.plugin("qq", "await ctx.plugin({ id: 'manual' });", { sub: ["manual", "auto"] });
  await f.plugin("qq/manual"); await f.plugin("qq/auto");
  let runtime = await f.boot();
  await runtime.action("qq/manual", "stop");
  await runtime.action("qq", "reload");
  assert.equal(runtime.records.get("qq/manual").status, "stopped");
  assert.equal(runtime.records.get("qq/auto").status, "active");
  await runtime.action("qq", "stop");
  assert.equal(runtime.records.get("qq/auto").status, "blocked");
  runtime = await f.boot();
  assert.equal(runtime.records.get("qq/manual").status, "stopped");
  assert.equal(runtime.records.get("qq/auto").status, "blocked");
  await assert.rejects(runtime.action("qq/manual", "start"), /父插件/);
  assert.deepEqual((await f.state()).disabled, ["qq", "qq/manual"]);
  await runtime.action("qq", "start");
  assert.equal(runtime.records.get("qq/manual").status, "stopped");
  assert.equal(runtime.records.get("qq/auto").status, "active");
  assert.equal(f.hits.filter(x => x === "qq/manual").length, 1);
});

test("dependency shutdown does not become a user opt-out and recovery skips explicitly disabled consumers", async (t) => {
  const f = await fixture(t);
  await f.plugin("a-consumer", "ctx.get('connection');", { depends: ["connection"] });
  await f.plugin("b-consumer", "ctx.get('connection');", { depends: ["connection"] });
  await f.plugin("z-provider", "ctx.provide('connection', {});");
  let runtime = await f.boot();
  assert.equal(runtime.records.get("a-consumer").status, "active", "directory order must not strand a declared dependency");
  await runtime.action("b-consumer", "stop");
  await runtime.action("z-provider", "stop");
  assert.equal(runtime.records.get("a-consumer").status, "blocked");
  assert.deepEqual((await f.state()).disabled, ["b-consumer", "z-provider"]);
  runtime = await f.boot();
  assert.equal(runtime.records.get("a-consumer").status, "blocked");
  await runtime.action("z-provider", "start");
  assert.equal(runtime.records.get("a-consumer").status, "active");
  assert.equal(runtime.records.get("b-consumer").status, "stopped");
});

test("reload respects a saved off choice and concurrent actions do not lose either plugin choice", async (t) => {
  const f = await fixture(t);
  await f.plugin("one"); await f.plugin("two");
  const runtime = await f.boot();
  await Promise.all([runtime.action("one", "stop"), runtime.action("two", "stop")]);
  assert.deepEqual((await f.state()).disabled, ["one", "two"]);
  const before = [...f.hits];
  await runtime.action("one", "reload");
  assert.deepEqual(f.hits, before);
  await Promise.all([runtime.action("one", "start"), runtime.action("one", "stop")]);
  assert.equal(runtime.records.get("one").status, "stopped");
  assert.deepEqual((await f.state()).disabled, ["one", "two"]);
});

test("failed persistence leaves the running plugin and previous choice unchanged", async (t) => {
  const f = await fixture(t); await f.plugin("one");
  const runtime = await f.boot();
  await mkdir(join(f.root, "config/plugins.json"), { recursive: true });
  await assert.rejects(runtime.action("one", "stop"));
  assert.equal(runtime.records.get("one").status, "active");
  assert.equal(runtime.list().find(x => x.id === "one")?.enabled, true);
  assert.deepEqual(f.cleanups, []);
});

test("corrupt persisted choices fail closed without erasing the file or executing extensions", async (t) => {
  const f = await fixture(t); await f.plugin("one");
  await mkdir(join(f.root, "config"));
  const file = join(f.root, "config/plugins.json"), corrupt = '{"version":1,"disabled":';
  await writeFile(file, corrupt);
  const runtime = await f.boot();
  assert.equal(runtime.records.get("one").status, "failed");
  assert.match(runtime.records.get("one").error, /启停配置/);
  assert.equal(runtime.records.get("probe").status, "active");
  assert.deepEqual(f.hits, []);
  await assert.rejects(runtime.action("one", "start"), /启停配置/);
  assert.equal(await readFile(file, "utf8"), corrupt);
});

test("invalid IDs, core services and unsupported actions cannot change saved choices", async (t) => {
  const f = await fixture(t); await f.plugin("one");
  const runtime = await f.boot();
  await runtime.action("one", "stop");
  const before = await f.state();
  for (const [id, action] of [["../one", "start"], ["probe", "stop"], ["missing", "stop"], ["one", "unexpected"]])
    await assert.rejects(runtime.action(id, action));
  assert.deepEqual(await f.state(), before);
});

test("plugin cards distinguish saved enablement from temporarily blocked execution", async () => {
  const { renderPlugins } = await import(new URL("../core/ui/views.js", import.meta.url).href);
  const html = renderPlugins({ state: { status: { plugins: [
    { id: "waiting", enabled: true, status: "blocked", error: "等待依赖：connection" },
    { id: "disabled", enabled: false, status: "stopped" },
  ] } } });
  assert.match(html, /等待依赖/);
  assert.match(html, /data-plugin-id="waiting" data-plugin-action="stop"/);
  assert.match(html, /data-plugin-id="disabled" data-plugin-action="start"/);
});

test("transitive dependencies resume in order while cycles remain blocked without running code", async (t) => {
  const f = await fixture(t);
  await f.plugin("a-leaf", "ctx.get('middle');", { depends: ["middle"] });
  await f.plugin("m-middle", "ctx.get('base'); ctx.provide('middle', {}); ctx.get('middle');", { depends: ["base"] });
  await f.plugin("z-base", "ctx.provide('base', {});");
  await f.plugin("cycle-one", "ctx.provide('cycle-one', {});", { depends: ["cycle-two"] });
  await f.plugin("cycle-two", "ctx.provide('cycle-two', {});", { depends: ["cycle-one"] });
  const runtime = await f.boot();
  assert.equal(runtime.records.get("a-leaf").status, "active");
  assert.equal(runtime.records.get("cycle-one").status, "blocked");
  assert.equal(runtime.records.get("cycle-two").status, "blocked");
  assert.ok(!f.hits.some(x => x.startsWith("cycle-")));
  await runtime.action("z-base", "stop");
  assert.equal(runtime.records.get("m-middle").status, "blocked");
  assert.equal(runtime.records.get("a-leaf").status, "blocked");
  await runtime.action("z-base", "start");
  assert.equal(runtime.records.get("a-leaf").status, "active");
  assert.equal(f.hits.filter(x => x === "m-middle").length, 2);
});

test("authenticated console actions persist across a fresh runtime and are reflected in status", async (t) => {
  const f = await fixture(t); await f.plugin("one");
  let runtime = await f.boot();
  const web = await startWeb({ web: { port: 0 }, providers: [], channels: { web: { persona: "test" } } },
    { logger: runtime.logger, memory: { status: async () => ({}) }, sessions: {} }, runtime);
  try {
    const base = `http://127.0.0.1:${(web.server.address() as any).port}`;
    const send = (cookie?: string) => fetch(base + "/api/plugin", { method: "POST", headers: cookie ? { Cookie: cookie } : {},
      body: JSON.stringify({ id: "one", action: "stop" }) });
    assert.equal((await send()).status, 401);
    const login = await fetch(base + "/api/login", { method: "POST", body: "{}" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await send(cookie)).status, 200);
    const status = await (await fetch(base + "/api/status", { headers: { Cookie: cookie } })).json();
    assert.equal(status.plugins.find((x: any) => x.id === "one").enabled, false);
    assert.equal(status.plugins.find((x: any) => x.id === "one").status, "stopped");
  } finally { await web.close(); }
  runtime = await f.boot();
  assert.equal(runtime.records.get("one").status, "stopped");
  assert.deepEqual(f.hits, ["one"]);
});

test("saved choices are honored by separate Node processes, not just an in-process cache", async (t) => {
  const f = await fixture(t); await f.plugin("one");
  const runtime = await f.boot();
  await runtime.action("one", "stop");
  const script = `import {Runtime} from ${JSON.stringify(new URL("../core/runtime.ts", import.meta.url).href)};
    const hits=[], runtime=new Runtime(process.argv[1],{info(){},warn(){},error(){}});
    await runtime.builtin('probe',{hits,cleanups:[]}); await runtime.bus.start(); await runtime.scan();
    if(process.argv[2]==='start')await runtime.action('one','start');
    console.log(JSON.stringify({status:runtime.records.get('one').status,loads:hits.length}));
    await runtime.bus.stop();`;
  const run = async (action = "") => JSON.parse((await promisify(execFile)(process.execPath,
    ["--input-type=module", "-e", script, f.root, action], { timeout: 10000 })).stdout);
  assert.deepEqual(await run(), { status: "stopped", loads: 0 });
  assert.deepEqual(await run("start"), { status: "active", loads: 1 });
  assert.deepEqual(await run(), { status: "active", loads: 1 });
});
