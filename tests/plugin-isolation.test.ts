import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Runtime } from "../core/runtime.ts";
import { Tools } from "../core/tools.ts";
import { boot } from "../core/index.ts";

// These fixtures intentionally hang or exit their plugin process. Never load them via Runtime.load.
const limits = { startupTimeoutMs: 1500, callTimeoutMs: 800, heartbeatTimeoutMs: 800, stopTimeoutMs: 250 };
const session = { id: "isolation-test", permission: "full" };

async function until(check: () => boolean | Promise<boolean>, description: string, timeout = 3500) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < end, "等待超时：" + description);
    await delay(20);
  }
}

async function exists(file: string) {
  try { await access(file); return true; }
  catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}

function tool(name: string, body: string) {
  return `ctx.tools.register({name: ${JSON.stringify(name)}, description: "isolation fixture",
    schema: {type: "object", properties: {}}, danger: "safe", async run() { ${body} }});`;
}

async function fixture(t: TestContext, options = limits) {
  const root = await mkdtemp(join(tmpdir(), "whale-plugin-isolation-"));
  const logger: any = { secrets: [], log() {}, debug() {}, info() {}, warn() {}, error() {} };
  const runtime = new Runtime(root, logger, options);
  const tools = new Tools(logger);
  await runtime.builtin("tools", tools);
  await runtime.bus.start();
  t.after(async () => {
    runtime.beginClose();
    await runtime.bus.stop();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const plugin = async (id: string, source: string, manifest: Record<string, unknown> = {}) => {
    const dir = join(root, "plugins", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), JSON.stringify({ id, name: id, description: "isolated test fixture", version: "1.0.0", ...manifest }));
    await writeFile(join(dir, "index.ts"), source);
    return dir;
  };
  const healthy = async (id = "healthy") => plugin(id,
    `export function apply(ctx) { ${tool(id + "_ping", `return {value: "alive", pid: process.pid};`)} }`);
  const ping = async (id = "healthy") => {
    const result = await tools.call(id + "_ping", {}, session);
    assert.equal(result.ok, true);
    assert.equal(result.result.value, "alive");
    assert.notEqual(result.result.pid, process.pid, "安装插件不能运行在主干进程中");
    assert.equal(runtime.records.get(id)?.status, "active");
    return result.result;
  };
  return { root, runtime, tools, plugin, healthy, ping };
}

for (const [name, source] of [
  ["top-level synchronous loop", "while (true) {}"],
  ["initialization promise that never settles", "export async function apply() { await new Promise(() => {}); }"],
] as const) {
  test("isolated " + name + " cannot block another plugin from starting", { timeout: 12000 }, async (t) => {
    const f = await fixture(t);
    await f.plugin("a-broken", source);
    await f.healthy("z-healthy");
    const started = Date.now();
    await f.runtime.scan();
    assert.ok(Date.now() - started < 5000, "启动失败必须有截止时间");
    assert.equal(f.runtime.records.get("a-broken")?.status, "failed");
    assert.ok(f.runtime.records.get("a-broken")?.error);
    assert.equal(f.runtime.list().find(p => p.id === "a-broken")?.enabled, true);
    await f.ping("z-healthy");
  });
}

test("two installed plugins run in separate processes", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.healthy("first"); await f.healthy("second");
  await f.runtime.scan();
  const first = await f.ping("first"), second = await f.ping("second");
  assert.notEqual(first.pid, second.pid);
});

test("isolated effect preserves class resource identity and disposes it only once", async (t) => {
  const f = await fixture(t);
  await f.plugin("resource", `export function apply(ctx) {
    class Resource { #value = 7; disposed = 0; read() { return this.#value; } dispose() { this.disposed++; } }
    const original = new Resource(), managed = ctx.effect(() => original);
    if (managed !== original || managed.read() !== 7) throw Error('effect changed the resource');
    managed.dispose(); managed.dispose();
    ${tool("resource_result", "return {value: managed.read(), disposed: managed.disposed};")}
  }`);
  await f.runtime.scan();
  assert.equal(f.runtime.records.get("resource")?.status, "active");
  assert.deepEqual((await f.tools.call("resource_result", {}, session)).result, { value: 7, disposed: 1 });
});

for (const [name, body] of [
  ["synchronous loop", "while (true) {}"],
  ["never-settling promise", "await new Promise(() => {});"],
  ["process.exit", "process.exit(17);"],
  ["exception", "throw Error('synthetic plugin tool failure');"],
] as const) {
  test("isolated tool " + name + " is cut off while healthy tools remain usable", { timeout: 12000 }, async (t) => {
    const f = await fixture(t);
    const broken = await f.plugin("broken", `export function apply(ctx) { ${tool("break_now", body)} }`);
    await mkdir(join(broken, "data"));
    await writeFile(join(broken, "data", "keep.json"), '{"user":"keep me"}');
    await f.healthy();
    await f.runtime.scan();
    await f.ping();
    const started = Date.now();
    const result = await f.tools.call("break_now", {}, session);
    assert.equal(result.ok, false);
    assert.ok(String(result.result).length > 0);
    await until(() => f.runtime.records.get("broken")?.status === "failed", "工具故障隔离");
    assert.ok(Date.now() - started < 5000);
    assert.equal(f.tools.entries.has("break_now"), false, "失败插件工具必须被移除");
    assert.equal(f.runtime.list().find(p => p.id === "broken")?.enabled, true, "故障不能变更用户启停选择");
    assert.deepEqual(JSON.parse(await readFile(join(broken, "data", "keep.json"), "utf8")), { user: "keep me" });
    const failed = f.runtime.records.get("broken");
    await f.runtime.action("healthy", "reload");
    await f.ping();
    assert.equal(f.runtime.records.get("broken"), failed, "其他插件重载不能自动重启失败插件");
    assert.equal(failed.status, "failed");
  });
}

test("manual stop interrupts a pending plugin call and bounded cleanup leaves the core usable", { timeout: 12000 }, async (t) => {
  const f = await fixture(t, { ...limits, callTimeoutMs: 5000 });
  const marker = join(f.root, "entered.txt");
  await f.plugin("waiting", `import { writeFile } from "node:fs/promises";
    export function apply(ctx) {
      ctx.effect(() => () => new Promise(() => {}));
      ${tool("wait_forever", `await writeFile(${JSON.stringify(marker)}, "entered"); await new Promise(() => {});`)}
    }`);
  await f.healthy(); await f.runtime.scan();
  const pending = f.tools.call("wait_forever", {}, session);
  await until(() => exists(marker), "工具开始执行");
  const started = Date.now();
  await f.runtime.action("waiting", "stop");
  assert.ok(Date.now() - started < 3000, "插件自己的清理不能挡住停用");
  assert.equal((await pending).ok, false);
  assert.equal(f.runtime.records.get("waiting")?.status, "stopped");
  assert.equal(f.runtime.list().find(p => p.id === "waiting")?.enabled, false);
  assert.equal(f.tools.entries.has("wait_forever"), false);
  await f.ping();
});

test("incompatible API major is refused before import, while an unversioned legacy plugin still loads", { timeout: 10000 }, async (t) => {
  const f = await fixture(t), marker = join(f.root, "must-not-import.txt");
  await f.plugin("incompatible", `import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "imported"); export function apply() {}`, { apiVersion: "2" });
  await f.healthy("legacy");
  await f.runtime.scan();
  assert.equal(f.runtime.records.get("incompatible")?.status, "failed");
  assert.match(f.runtime.records.get("incompatible")?.error ?? "", /API|版本|version/i);
  assert.equal(await exists(marker), false, "不兼容代码连顶层入口也不能执行");
  await f.ping("legacy");
});

test("provider faults block dependents without changing enabled choices or retrying the failed provider", { timeout: 12000 }, async (t) => {
  const f = await fixture(t), imports = join(f.root, "provider-imports.txt");
  await f.plugin("a-provider", `import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(imports)}, "loaded\\n");
    export function apply(ctx) {
      ctx.provide("fixture_dependency", { ping() { return "ready"; } });
      ${tool("kill_provider", "process.exit(23);")}
    }`);
  await f.plugin("b-dependent", `export function apply(ctx) {
    const dependency = ctx.get("fixture_dependency");
    ${tool("dependent_ping", "return dependency.ping();")}
  }`, { depends: ["fixture_dependency"] });
  await f.healthy(); await f.runtime.scan();
  assert.equal(f.runtime.records.get("b-dependent")?.status, "active");
  assert.equal((await f.tools.call("dependent_ping", {}, session)).result, "ready");
  assert.equal((await f.tools.call("kill_provider", {}, session)).ok, false);
  await until(() => f.runtime.records.get("a-provider")?.status === "failed"
    && f.runtime.records.get("b-dependent")?.status === "blocked", "依赖故障传播");
  assert.equal(f.tools.entries.has("dependent_ping"), false);
  for (const id of ["a-provider", "b-dependent"])
    assert.equal(f.runtime.list().find(p => p.id === id)?.enabled, true);
  await f.runtime.action("healthy", "reload");
  await f.ping();
  assert.equal(await readFile(imports, "utf8"), "loaded\n", "依赖重试不能重新导入故障提供方");
  assert.equal(f.runtime.records.get("a-provider")?.status, "failed");
  assert.equal(f.runtime.records.get("b-dependent")?.status, "blocked");
});

test("reload starts a new process and picks up edited submodules without deleting plugin data", { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const dir = await f.plugin("reloadable", `import { value } from "./lib/value.ts";
    export function apply(ctx) { ${tool("read_version", "return { value, pid: process.pid };")} }`);
  await mkdir(join(dir, "lib")); await mkdir(join(dir, "data"));
  await writeFile(join(dir, "lib", "value.ts"), 'export const value = "before";');
  await writeFile(join(dir, "data", "config.json"), '{"user":"saved"}');
  await f.runtime.scan();
  const first = await f.tools.call("read_version", {}, session);
  assert.equal(first.ok, true); assert.equal(first.result.value, "before");
  await writeFile(join(dir, "lib", "value.ts"), 'export const value = "after";');
  await f.runtime.action("reloadable", "reload");
  const second = await f.tools.call("read_version", {}, session);
  assert.equal(second.ok, true); assert.equal(second.result.value, "after");
  assert.notEqual(first.result.pid, second.result.pid);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "data", "config.json"), "utf8")), { user: "saved" });
});

test("plugin process failure leaves authenticated Web and normal model sessions operational", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whale-isolation-web-"));
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  t.after(async () => {
    await app?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "config"));
  await mkdir(join(root, "plugins", "crash"), { recursive: true });
  await writeFile(join(root, "plugins", "crash", "plugin.yaml"), JSON.stringify({ id: "crash", name: "crash", description: "fixture", version: "1.0.0" }));
  await writeFile(join(root, "plugins", "crash", "index.ts"), `export function apply(ctx) { ${tool("crash_now", "process.exit(31);")} }`);
  await writeFile(join(root, "config", "config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 }, plugin_runtime: limits,
    providers: [{ id: "test", name: "Test", base_url: "https://unused.example/v1", api_key: "synthetic-secret" }],
    models: [{ id: "chat", name: "测试模型", provider: "test", model: "test", type: "chat", enabled: true, context_window: 200000 }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "A", file: "a.md", model: "chat", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  const requests: any[] = [];
  app.llm.chat = async (input: any) => { requests.push(input); return { text: "模拟回复：主干仍然可用", toolCalls: [], usage: { prompt_tokens: 20, completion_tokens: 4 } }; };
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  const login = await fetch(url + "/api/login", { method: "POST", body: "{}", signal: AbortSignal.timeout(2500) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await app.tools.call("crash_now", {}, { permission: "full" })).ok, false);
  await until(() => app!.runtime.records.get("crash")?.status === "failed", "子进程退出故障");
  const status = await fetch(url + "/api/status", { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2500) });
  assert.equal(status.status, 200);
  const json = await status.json();
  assert.equal(json.plugins.find((p: any) => p.id === "crash")?.status, "failed");
  await app.memory.saveSessionMeta("after-plugin-fault", { name: "故障后会话" });
  await app.sessions.chat("after-plugin-fault", "故障后仍能聊天吗", () => {}, undefined, "a");
  assert.equal(requests.length, 1);
  const rows = await app.memory.readSession("after-plugin-fault");
  assert.equal(rows.findLast((row: any) => row.role === "assistant")?.text, "模拟回复：主干仍然可用");
  assert.equal((await app.memoryEngine.state("after-plugin-fault")).usage.chat.requests, 1);
  assert.equal(app.runtime.records.get("sessions")?.status, "active");
});

test("plugin heap exhaustion is isolated from a separate test host and its healthy plugin", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whale-isolation-oom-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  for (const [id, source] of [
    ["oom", `export function apply(ctx) {
      ${tool("exhaust_heap", 'const retained = []; while (true) retained.push(new Array(32768).fill("retained"));')}
    }`],
    ["healthy", `export function apply(ctx) { ${tool("healthy_ping", 'return "alive";')} }`],
  ]) {
    const dir = join(root, "plugins", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), JSON.stringify({ id, name: id, description: "isolated OOM fixture", version: "1.0.0" }));
    await writeFile(join(dir, "index.ts"), source);
  }
  // An additional limited child host keeps an OOM regression away from node:test itself.
  const source = `
    import assert from "node:assert/strict";
    import { setTimeout as delay } from "node:timers/promises";
    import { Runtime } from ${JSON.stringify(new URL("../core/runtime.ts", import.meta.url).href)};
    import { Tools } from ${JSON.stringify(new URL("../core/tools.ts", import.meta.url).href)};
    const logger = { secrets: [], log(){}, debug(){}, info(){}, warn(){}, error(){} };
    const runtime = new Runtime(${JSON.stringify(root)}, logger,
      { startupTimeoutMs: 2000, callTimeoutMs: 5000, heartbeatTimeoutMs: 5000, stopTimeoutMs: 250, maxOldGenerationSizeMb: 32 });
    const tools = new Tools(logger);
    try {
      await runtime.builtin("tools", tools); await runtime.bus.start(); await runtime.scan();
      assert.equal(runtime.records.get("oom").status, "active");
      assert.equal((await tools.call("exhaust_heap", {}, {permission: "full"})).ok, false);
      const end = Date.now() + 2000;
      while (runtime.records.get("oom").status !== "failed" && Date.now() < end) await delay(20);
      assert.equal(runtime.records.get("oom").status, "failed");
      assert.match(runtime.records.get("oom").error, /memory|heap|内存/i);
      assert.equal(runtime.list().find(p => p.id === "oom").enabled, true);
      assert.deepEqual(await tools.call("healthy_ping", {}, {permission: "full"}), {ok: true, result: "alive"});
      process.stdout.write("OOM_ISOLATION_OK");
    } finally { runtime.beginClose(); await runtime.bus.stop(); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--max-old-space-size=128", "--input-type=module", "--eval", source],
    { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  assert.match(stdout, /OOM_ISOLATION_OK/);
});

async function webFixture(t: TestContext, plugins: { id: string; source: string }[]) {
  const root = await mkdtemp(join(tmpdir(), "whale-isolation-callback-"));
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  t.after(async () => {
    await app?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config", "config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 }, plugin_runtime: limits,
    providers: [], models: [], model_bindings: {},
    personas: { a: { name: "A", file: "a.md", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  for (const { id, source } of [...plugins, { id: "healthy", source: `export function apply(ctx) {
    ctx.web.page("/plugins/healthy/ping", (_req, res) => res.end("healthy"), { title: "Healthy", navigation: true });
    ${tool("healthy_ping", 'return "alive";')}
  }` }]) {
    const dir = join(root, "plugins", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), JSON.stringify({ id, name: id, description: "callback isolation fixture", version: "1.0.0" }));
    await writeFile(join(dir, "index.ts"), source);
  }
  app = await boot(root);
  const running = app;
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  const login = await fetch(url + "/api/login", { method: "POST", body: "{}", signal: AbortSignal.timeout(2500) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const request = (path: string) => fetch(url + path, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3500) });
  const healthy = async () => {
    assert.equal((await request("/api/status")).status, 200);
    const response = await request("/plugins/healthy/ping");
    assert.equal(response.status, 200); assert.equal(await response.text(), "healthy");
    assert.deepEqual(await running.tools.call("healthy_ping", {}, { permission: "full" }), { ok: true, result: "alive" });
    assert.equal(running.runtime.records.get("healthy")?.status, "active");
  };
  return { root, app: running, request, healthy };
}

test("hung HTTP callbacks time out even after res.end and remove only the faulty plugin's entries", { timeout: 15000 }, async (t) => {
  const ids = ["http-open", "http-ended"];
  const f = await webFixture(t, ids.map((id) => ({ id, source: `export function apply(ctx) {
    ctx.web.page("/plugins/${id}/hang", async (_req, res) => {
      ${id === "http-ended" ? 'res.end("delivered");' : ""}
      await new Promise(() => {});
    }, { title: "Hung page", navigation: true });
    ${tool(id.replaceAll("-", "_") + "_ping", 'return "registered";')}
  }` })));
  for (const id of ids) {
    assert.equal(f.app.runtime.records.get(id)?.status, "active");
    const started = Date.now();
    const response = await f.request(`/plugins/${id}/hang`);
    if (id === "http-ended") {
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "delivered", "响应完成不能掩盖仍未返回的回调");
    } else {
      assert.ok(response.status >= 500, "未完成的页面必须结束请求");
      await response.text();
    }
    await until(() => f.app.runtime.records.get(id)?.status === "failed", "HTTP 回调超时切割");
    assert.ok(Date.now() - started < 4000);
    assert.equal((await f.request(`/plugins/${id}/hang`)).status, 404);
    assert.equal(f.app.tools.entries.has(id.replaceAll("-", "_") + "_ping"), false);
    assert.equal(f.app.runtime.list().find((p: any) => p.id === id)?.enabled, true);
    const status = await (await f.request("/api/status")).json();
    assert.equal(status.pluginPages.some((p: any) => p.owner === id), false);
    await f.healthy();
  }
});

test("a never-settling event callback times out without blocking event drain, Web or another plugin", { timeout: 12000 }, async (t) => {
  const f = await webFixture(t, [{ id: "event-stuck", source: `export function apply(ctx) {
    ctx.on("plugin:event-stuck:hang", async () => { await new Promise(() => {}); });
    ctx.web.page("/plugins/event-stuck/ping", (_req, res) => res.end("registered"), { title: "Event fixture", navigation: true });
    ${tool("event_stuck_ping", 'return "registered";')}
  }` }]);
  assert.equal(f.app.runtime.records.get("event-stuck")?.status, "active");
  assert.equal((await f.request("/plugins/event-stuck/ping")).status, 200);
  const started = Date.now();
  f.app.runtime.events.emit("plugin:event-stuck:hang", { synthetic: true });
  await until(() => f.app.runtime.records.get("event-stuck")?.status === "failed", "事件回调超时切割");
  await f.app.runtime.events.drain();
  assert.ok(Date.now() - started < 4000);
  assert.equal((await f.request("/plugins/event-stuck/ping")).status, 404);
  assert.equal(f.app.tools.entries.has("event_stuck_ping"), false);
  assert.equal(f.app.runtime.list().find((p: any) => p.id === "event-stuck")?.enabled, true);
  // The removed subscriber must not create another pending call on subsequent notifications.
  f.app.runtime.events.emit("plugin:event-stuck:hang", { synthetic: true });
  await f.app.runtime.events.drain();
  await f.healthy();
});
