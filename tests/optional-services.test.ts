import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../core/runtime.ts";
import { Tools } from "../core/tools.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const limits = { startupTimeoutMs: 4000, callTimeoutMs: 2500, heartbeatTimeoutMs: 1200, stopTimeoutMs: 400 };
async function until(check: () => boolean | Promise<boolean>, label = "optional transition", ms = 6000) {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < deadline, label); await delay(20); }
}
async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-optional-services-");
  const errors: any[] = [];
  const logger: any = { info() {}, debug() {}, warn() {}, log() {}, error: (...args: any[]) => errors.push(args) };
  const runtime = new Runtime(root, logger, limits), tools = new Tools(logger);
  t.after(() => runtime.bus.stop());
  await runtime.builtin("tools", tools);
  await runtime.bus.start();
  const plugin = async (id: string, body: string, manifest: any = {}) => {
    const dir = join(root, "plugins", id.split("/").join("/sub/"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), JSON.stringify({ id: id.split("/").at(-1), name: id, description: "isolated optional fixture", version: "1.0.0", ...manifest }));
    await writeFile(join(dir, "index.ts"), `export async function apply(ctx) { ${body} }`);
    return dir;
  };
  const load = async (id: string) => {
    const record = await runtime.loadPath(id);
    assert.equal(record.status, "active", record.error);
    assert.notEqual(record.execution.pid, process.pid);
    return record;
  };
  const service = (name: string) => runtime.services.get(name)?.value;
  const status = (id: string) => runtime.records.get(id)?.status;
  return { root, runtime, tools, plugin, load, service, status, errors };
}

const provider = `
  ctx.provide('pictures', {
    pid: process.pid, nested: { read() { return 'nested'; } },
    read() { return process.pid; },
    wait(signal) { return new Promise(resolve => {
      if (signal.aborted) return resolve('cancelled');
      signal.addEventListener('abort', () => resolve('cancelled'), {once:true});
    }); },
    hang() { return new Promise(() => {}); },
    crash() { process.exit(19); }
  });
`;
const consumer = `
  let current, old, oldMethod, cleanups = 0, updates = [], calls = 0;
  const dispose = ctx.optional('pictures', binding => {
    current = binding;
    updates.push(binding ? 'up' : 'down');
    if (!binding) return;
    old ??= binding;
    oldMethod ??= binding.service.read;
    binding.effect(() => () => { cleanups++; });
    binding.effect(() => ctx.tools.register({ name: 'optional_picture', description: 'fixture', schema: {},
      async run() { try { calls++; return {pid: await binding.service.read()}; } catch { return {unavailable:true}; } }
    }));
  });
  ctx.provide('consumer', {
    state() { return {pid:process.pid, available:!!current, cleanups, updates, calls, oldAborted:old?.signal.aborted}; },
    ping() { return 'text works'; },
    async read() { return current ? current.service.read() : null; },
    async nested() { return current.service.nested.read(); },
    async oldRead() { try { return await old.service.read(); } catch { return 'revoked'; } },
    async oldMethod() { try { return await oldMethod(); } catch { return 'revoked'; } },
    lateSetup() { try { old.effect(() => ctx.tools.register({name:'late_tool',description:'late',schema:{},run(){}})); return false; } catch { return true; } },
    async wait() { try { return await current.service.wait(current.signal); } catch { return 'revoked'; } },
    async hang() { try { return await current.service.hang(); } catch { return 'revoked'; } },
    dispose() { dispose(); }
  });
`;

test("optional service absence, late arrival, stop, reload, stale references and scoped cleanup across real processes", async t => {
  const f = await fixture(t);
  await f.plugin("consumer", consumer, { optionalDepends: ["pictures"] });
  await f.plugin("provider", provider);
  await f.plugin("witness", `ctx.provide('witness', { ping(){return 'alive';} });`);
  await f.load("consumer"); await f.load("witness");
  const api = f.service("consumer"), consumerPid = (await api.state()).pid;
  await until(async () => (await api.state()).updates.length === 1);
  assert.equal((await api.state()).available, false);
  assert.equal(await api.ping(), "text works");
  await f.load("provider");
  await until(async () => (await api.state()).available && f.tools.entries.has("optional_picture"));
  const providerPid = await api.read();
  assert.notEqual(providerPid, consumerPid);
  assert.equal(await api.nested(), "nested");
  assert.equal(f.runtime.records.get("consumer").dependencies.has("pictures"), false);
  await f.runtime.action("provider", "stop");
  await until(async () => !(await api.state()).available && !f.tools.entries.has("optional_picture"));
  assert.equal((await api.state()).cleanups, 1);
  assert.equal(await api.oldRead(), "revoked");
  assert.equal(await api.oldMethod(), "revoked");
  assert.equal(await api.lateSetup(), true);
  assert.equal(f.tools.entries.has("late_tool"), false);
  assert.equal(f.status("consumer"), "active");
  assert.equal(await f.service("witness").ping(), "alive");
  await f.runtime.action("provider", "start");
  await until(async () => (await api.state()).available && f.tools.entries.has("optional_picture"));
  assert.notEqual(await api.read(), providerPid);
  assert.equal((await api.state()).pid, consumerPid);
  await f.runtime.action("provider", "reload");
  await until(async () => (await api.state()).cleanups === 2 && f.tools.entries.has("optional_picture"));
  assert.equal(await api.oldRead(), "revoked");
  assert.equal(await api.oldMethod(), "revoked");
  assert.equal((await api.state()).calls, 0, "recovery must not replay business operations");
  assert.equal(f.runtime.list().length, 4, "no bridge plugin records are created");
  await api.dispose(); await api.dispose();
  await until(() => !f.tools.entries.has("optional_picture"));
  assert.equal((await api.state()).cleanups, 3);
  await f.runtime.action("provider", "reload");
  assert.equal((await api.state()).cleanups, 3);
  assert.equal((f.runtime as any).optionalServices.watchers.size, 0);
});

test("provider stop cancels optional waiting calls without stopping the consumer or hanging shutdown", async t => {
  const f = await fixture(t);
  await f.plugin("provider", provider); await f.load("provider");
  await f.plugin("consumer", consumer, { optionalDepends: ["pictures"] }); await f.load("consumer");
  const api = f.service("consumer");
  await until(async () => (await api.state()).available);
  const waiting = api.wait(), hanging = api.hang();
  await delay(80);
  const before = Date.now();
  await f.runtime.action("provider", "stop");
  assert.equal(await waiting, "revoked");
  assert.equal(await hanging, "revoked");
  assert.ok(Date.now() - before < 2000);
  assert.equal(f.status("consumer"), "active");
  assert.equal(await api.ping(), "text works");
});

test("a crashed provider is cut off; optional consumer stays active and reconnects without replay", async t => {
  const f = await fixture(t);
  await f.plugin("provider", provider); await f.load("provider");
  await f.plugin("consumer", consumer, { optionalDepends: ["pictures"] }); await f.load("consumer");
  const api = f.service("consumer");
  await until(async () => (await api.state()).available);
  await assert.rejects(f.service("pictures").crash());
  await until(async () => f.status("provider") === "failed" && !(await api.state()).available);
  assert.equal(f.status("consumer"), "active");
  await f.runtime.records.get("provider").stopping;
  await f.runtime.action("provider", "start");
  await until(async () => (await api.state()).available);
  assert.equal(await api.oldRead(), "revoked");
  assert.equal((await api.state()).calls, 0);
});

test("consumer stop releases optional resources, persists the user's choice and cannot be revived by provider reload", async t => {
  const f = await fixture(t);
  await f.plugin("provider", provider); await f.load("provider");
  await f.plugin("consumer", consumer, { optionalDepends: ["pictures"] }); await f.load("consumer");
  await until(() => f.tools.entries.has("optional_picture"));
  await f.runtime.action("consumer", "stop");
  assert.equal(f.tools.entries.has("optional_picture"), false);
  assert.equal((f.runtime as any).optionalServices.watchers.size, 0);
  await f.runtime.action("provider", "reload");
  assert.equal(f.status("consumer"), "stopped");
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "config/plugins.json"), "utf8")).disabled, ["consumer"]);
  await f.runtime.action("consumer", "start");
  await until(() => f.tools.entries.has("optional_picture"));
  assert.equal(f.status("provider"), "active");
});

test("optional declarations are checked before import and undeclared subscriptions are rejected", async t => {
  const f = await fixture(t);
  for (const [id, declaration] of [["string", "pictures"], ["empty", [""]], ["mixed", [12]], ["overlap", ["pictures"]]] as const) {
    await f.plugin(id, `throw Error('must not import');`, { optionalDepends: declaration, ...(id === "overlap" ? { depends: ["pictures"] } : {}) });
    const record = await f.runtime.loadPath(id);
    assert.equal(record.status, "failed"); assert.match(record.error, /optionalDepends/);
  }
  await f.plugin("undeclared", `ctx.optional('pictures', () => {});`);
  const record = await f.runtime.loadPath("undeclared");
  assert.equal(record.status, "failed"); assert.match(record.error, /optionalDepends/);
  assert.equal((f.runtime as any).optionalServices.watchers.size, 0);
});

test("mandatory depends and successful legacy get(false) still cascade; optional declaration does not weaken get", async t => {
  const f = await fixture(t);
  await f.plugin("provider", provider);
  await f.plugin("mandatory", `ctx.get('pictures');`, { depends: ["pictures"] });
  assert.equal((await f.runtime.loadPath("mandatory")).status, "blocked");
  await f.load("provider"); await f.load("mandatory");
  await f.plugin("legacy", `ctx.get('pictures', false);`, { optionalDepends: ["pictures"] }); await f.load("legacy");
  await f.runtime.action("provider", "stop");
  assert.equal(f.status("mandatory"), "blocked");
  assert.equal(f.status("legacy"), "blocked");
});

test("late async setup is rejected, new binding waits for old setup, and class resources retain identity", async t => {
  const f = await fixture(t);
  await f.plugin("provider", provider); await f.load("provider");
  await f.plugin("late", `
    let entered = 0, rejected = 0, cleaned = 0, identity = false;
    ctx.optional('pictures', async binding => {
      if (!binding) return;
      entered++;
      if (entered === 1) await new Promise(resolve => setTimeout(resolve, 250));
      try {
        binding.effect(() => ctx.tools.register({name:'late_scoped',description:'fixture',schema:{},run(){return 'ready';}}));
        class Resource { #value = 9; read(){return this.#value;} dispose(){cleaned++;} }
        const original = new Resource(), resource = binding.effect(() => original);
        identity = resource === original && resource.read() === 9;
        await resource.dispose(); await resource.dispose();
      } catch { rejected++; }
    });
    ctx.provide('late', {state(){return {entered,rejected,cleaned,identity};}});
  `, { optionalDepends: ["pictures"] });
  await f.load("late");
  const api = f.service("late");
  await until(async () => (await api.state()).entered === 1);
  await f.runtime.action("provider", "stop");
  await until(async () => (await api.state()).rejected === 1);
  assert.equal(f.tools.entries.has("late_scoped"), false);
  assert.equal(f.status("late"), "active");
  await f.runtime.action("provider", "start");
  await until(async () => (await api.state()).identity);
  assert.equal((await api.state()).cleaned, 1);
  assert.equal(f.tools.entries.has("late_scoped"), true);
  await f.runtime.action("provider", "stop");
  await until(() => !f.tools.entries.has("late_scoped"));
  assert.equal((await api.state()).cleaned, 1);
});

test("optional subscriptions release lifecycle registrations after repeated manual disposal", async t => {
  const f = await fixture(t);
  await f.plugin("consumer", `ctx.provide('churn', {run(){
    for (let i=0;i<100;i++) { const remove=ctx.optional('pictures',()=>{}); remove(); remove(); }
    return true;
  }});`, { optionalDepends: ["pictures"] });
  const record = await f.load("consumer"), baseline = record.cordis.scope.disposables.length;
  assert.equal(await f.service("churn").run(), true);
  await delay(30);
  assert.equal((f.runtime as any).optionalServices.watchers.size, 0);
  assert.equal(record.cordis.scope.disposables.length, baseline);
});

test("optional lookup respects parent-local services and never exposes internal core implementations", async t => {
  const f = await fixture(t);
  await f.plugin("parent", `ctx.provide('pictures',{read(){return 'parent';}});`);
  await f.plugin("parent/child", `let found, core; ctx.optional('pictures', b=>{found=b;}); ctx.optional('tools', b=>{core=b;});
    ctx.tools.register({name:'local_probe',description:'fixture',schema:{}, async run(){return {value:await found?.service.read(),core:!!core};}});
  `, { optionalDepends: ["pictures", "tools"] });
  await f.load("parent");
  await until(() => f.status("parent/child") === "active");
  await until(async () => (await f.tools.call("local_probe", {}, { id: "fixture", permission: "full" } as any)).result?.value === "parent");
  const result = await f.tools.call("local_probe", {}, { id: "fixture", permission: "full" } as any);
  assert.deepEqual(result.result, { value: "parent", core: false });
});

for (const [label, body] of [
  ["throwing setup", `throw Error('consumer callback failed');`],
  ["hanging setup", `await new Promise(() => {});`],
  ["hanging cleanup", `binding.effect(() => () => new Promise(() => {}));`],
  ["looping setup", `binding.effect(() => ctx.tools.register({name:'loop_scoped',description:'fixture',schema:{},run(){}})); while(true) {}`],
] as const) test(`${label} is attributed to consumer without blocking provider or witness`, async t => {
  const f = await fixture(t);
  await f.plugin("witness", `ctx.provide('witness', {ping(){return true;}});`); await f.load("witness");
  await f.plugin("provider", provider); await f.load("provider");
  await f.plugin("bad-consumer", `ctx.optional('pictures', async binding => { if (!binding) return; ${body} });`, { optionalDepends: ["pictures"] });
  await f.runtime.loadPath("bad-consumer");
  await delay(100);
  if (label !== "throwing setup") await f.runtime.action("provider", "stop");
  await until(() => f.status("bad-consumer") === "failed");
  assert.equal(f.tools.entries.has("loop_scoped"), false);
  assert.equal(await f.service("witness").ping(), true);
  assert.equal(f.status("witness"), "active");
  if (label === "throwing setup") assert.equal(f.status("provider"), "active");
  else await f.runtime.action("provider", "start");
  assert.equal(f.status("provider"), "active");
});
