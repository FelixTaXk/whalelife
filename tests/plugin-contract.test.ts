import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { boot } from "../core/index.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-plugin-contract-"));
  await mkdir(join(root, "config")); await mkdir(join(root, "plugins"));
  await cp(resolve("examples/plugins/contract-check"), join(root, "plugins/contract-check"), { recursive: true });
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 }, providers: [{ id: "test", name: "Test", base_url: "https://unused.example/v1", api_key: "synthetic-secret" }],
    models: [{ id: "chat", name: "测试模型", provider: "test", model: "test", type: "chat", enabled: true, context_window: 200000 }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "A", file: "a.md", model: "chat", permission: "full" }, b: { name: "B", file: "b.md", model: "chat", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  const app = await boot(root), requests: any[] = [];
  app.llm.chat = async (input: any) => { requests.push(input); return { text: "模拟回复", toolCalls: [], usage: { prompt_tokens: 20, completion_tokens: 4 } }; };
  t.after(async () => { await app.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  const login = await fetch(url + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const request = (path: string, body?: any) => fetch(url + path, { method: body ? "POST" : "GET", headers: { Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const plugin = () => app.runtime.services.get("contract-check")!.value;
  assert.equal(app.runtime.records.get("contract-check")?.status, "active");
  return { root, app, url, request, plugin, requests };
}

test("plugin-only installation provides settings, navigation, authenticated routes and persistent configuration", async (t) => {
  const { root, app, url, request, plugin } = await fixture(t);
  const status = await (await request("/api/status")).json();
  assert.deepEqual(status.pluginPages, [{ owner: "contract-check", path: "/plugins/contract-check/settings", title: "插件契约验收", settings: true, navigation: true }]);
  assert.equal((await fetch(url + "/plugins/contract-check/settings")).status, 401);
  assert.equal((await fetch(url + "/ui/app.js", { headers: { Origin: url } })).status, 200, "browser module requests use actual ephemeral port origin");
  assert.match(await (await request("/plugins/contract-check/settings?from=test")).text(), /插件设置示例/);
  assert.equal((await request("/plugins/contract-check/config", { action: "save", label: "自定义", model: "chat" })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(root, "plugins/contract-check/data/config.json"), "utf8")), { label: "自定义", model: "chat" });
  const data = await (await request("/plugins/contract-check/config", { action: "read" })).json();
  assert.equal(data.models[0].id, "chat"); assert.ok(!JSON.stringify(data).includes("synthetic-secret"));
  const old = plugin().ctx;
  assert.equal(old.web, old.get("web")); assert.equal(old.tools, old.get("tools"));
  assert.throws(() => old.web.page("/plugins/another/settings", () => {}), /本插件/);
  assert.throws(() => old.web.page("/plugins/contract-check/../bad", () => {}), /路径/);
  await app.runtime.action("contract-check", "stop");
  assert.deepEqual((await (await request("/api/status")).json()).pluginPages, []);
  assert.equal((await request("/plugins/contract-check/settings")).status, 404);
  assert.ok(old.signal.aborted);
  assert.throws(() => old.models.list(), /停用/);
  assert.throws(() => old.web.page("/plugins/contract-check/late", () => {}), /停用/);
  await assert.rejects(old.config.save("config.json", { label: "stale" }), /停用/);
  await app.runtime.action("contract-check", "start");
  assert.equal((await plugin().ctx.config.read()).label, "自定义");
  assert.equal((await (await request("/api/status")).json()).pluginPages.length, 1);
});

test("plugin sessions preserve persona, context, sources, token accounting and memory notifications", async (t) => {
  const { app, plugin, requests } = await fixture(t);
  const { ctx, notices } = plugin();
  await app.runtime.events.drain();
  assert.equal(notices.filter((n: any) => n.event === "whalelife/ready").length, 1, "late subscriptions get ready once");
  assert.deepEqual(ctx.personas.list().map((p: any) => p.id), ["a", "b"]);
  const id = await ctx.sessions.create("同一段经历");
  await ctx.sessions.run({ sessionId: id, persona: "a", text: "第一条", origin: { platform: "虚构平台", action: "接收请求" } });
  await ctx.sessions.run({ sessionId: id, persona: "b", text: "继续", origin: { platform: "虚构平台", action: "接收请求" } });
  assert.equal((await ctx.sessions.list()).length, 1);
  assert.ok(requests.at(-1).messages.some((m: any) => m.content.includes("第一条")));
  const rows = await app.memory.readSession(id);
  assert.equal(rows.filter((r: any) => r.type === "message").length, 4);
  assert.equal(rows[0].origin.plugin, "contract-check");
  assert.equal(rows.at(-1).persona_id, "b");
  assert.equal((await app.memoryEngine.state(id)).usage.chat.requests, 2);
  await app.memoryEngine.saveLocalFacts(id, "独立事实");
  await ctx.tools.call("contract_echo", { text: "内容" }, { id, permission: "full" });
  await app.runtime.events.drain();
  for (const kind of ["channel/message", "channel/reply", "tool/called", "memory/updated"]) assert.ok(notices.some((n: any) => n.event === kind), kind);
  assert.throws(() => ctx.emit("channel/message", {}), /自身ID/);
  let own: any; ctx.on("plugin:contract-check:custom", (p: any) => { own = p; });
  ctx.emit("plugin:contract-check:custom", { value: 1 }); await app.runtime.events.drain(); assert.equal(own.value, 1);
  await assert.rejects(ctx.sessions.run({ sessionId: "missing", persona: "a", text: "不应自动建会话" }), /创建或选择/);
});

test("notification failures and unload remove plugin entry points without breaking memory commit", async (t) => {
  const { app, plugin } = await fixture(t);
  await app.runtime.events.drain();
  const { ctx } = plugin();
  let received = 0;
  ctx.on("memory/recorded", async () => { received++; throw Error("synthetic listener failure"); });
  await app.memory.appendEvent({ session: "test", type: "message", role: "user", text: "已落盘" });
  await app.runtime.events.drain();
  assert.equal(received, 1);
  assert.equal((await app.memory.readSession("test"))[0].text, "已落盘");
  assert.equal(app.runtime.records.get("contract-check").status, "failed");
  assert.equal(app.web.pages().length, 0);
  await app.memory.appendEvent({ session: "test", type: "message", role: "user", text: "继续落盘" });
  await app.runtime.events.drain(); assert.equal(received, 1);
});

test("console renders registered entries safely and removes stopped plugin navigation", async () => {
  const ui = await import(new URL("../core/ui/extensions.js", import.meta.url).href);
  const status = { plugins: [{ id: "one", status: "active" }], pluginPages: [{ owner: "one", path: "/plugins/one/settings", title: "<unsafe>", navigation: true, settings: true }] };
  assert.match(ui.extensionNavigation(status), /&lt;unsafe&gt;/);
  assert.match(ui.extensionSettings(status, "one"), /设置/);
  const app = { state: { status, page: ui.extensionKey("/plugins/one/settings") } };
  assert.match(ui.extensionPage(app).render(), /iframe/);
  app.state.page = "extension:" + encodeURIComponent("https://outside.example");
  assert.doesNotMatch(ui.extensionPage(app).render(), /iframe/);
  status.plugins[0].status = "stopped"; assert.equal(ui.extensionNavigation(status), "");
});

test("stale listeners cannot unload a replacement plugin or remove another subscription", async (t) => {
  const { app, plugin } = await fixture(t);
  const old = plugin().ctx;
  let reject!: (reason: Error) => void, started!: () => void;
  const entered = new Promise<void>((r) => { started = r; });
  old.on("synthetic/late", () => { started(); return new Promise((_r, j) => { reject = j; }); });
  const dispose = old.on("synthetic/shared", () => {}); dispose();
  let delivered = 0;
  app.runtime.events.on("synthetic/shared", () => { delivered++; });
  app.runtime.events.emit("synthetic/late", {}); await entered;
  await app.runtime.action("contract-check", "reload");
  reject(Error("old generation failed after reload"));
  app.runtime.events.emit("synthetic/shared", {}); await app.runtime.events.drain();
  assert.equal(app.runtime.records.get("contract-check").status, "active");
  assert.equal(delivered, 1);
});

test("core shutdown cancels plugin model work and HTTP handlers before waiting for server close", async (t) => {
  const { app, plugin, request } = await fixture(t);
  const { ctx } = plugin();
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  app.llm.chat = ({ signal }: any) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }); entered();
  });
  ctx.web.api("/plugins/contract-check/wait", async (_req: any, res: any, { signal }: any) => {
    await ctx.llm.chat({ model: "chat", messages: [], signal }); res.end("unexpected");
  });
  const waiting = request("/plugins/contract-check/wait", {});
  await started;
  const closing = app.close(); assert.equal(app.close(), closing);
  const response = await waiting;
  assert.equal(response.status, 503);
  await closing;
  assert.ok(ctx.signal.aborted);
});

test("plugin session creation is excluded from memory restore, including queued admission", async (t) => {
  const { app, plugin } = await fixture(t);
  const { ctx } = plugin();
  app.sessions.memoryMaintenance = true;
  await assert.rejects(ctx.sessions.create("blocked"), /记忆恢复/);
  app.sessions.memoryMaintenance = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const lock = app.memory.serial(() => gate);
  const creation = ctx.sessions.create("queued");
  const rejected = assert.rejects(creation, /记忆恢复/);
  try {
    await new Promise<void>((r) => setImmediate(r));
    app.sessions.memoryMaintenance = true;
  } finally { release(); }
  await lock; await rejected;
  app.sessions.memoryMaintenance = false;
  assert.deepEqual(await ctx.sessions.list(), []);
  const id = await ctx.sessions.create("normal");
  assert.equal((await ctx.sessions.list())[0].id, id);
});

test("shutdown waits for admitted plugin handlers and event cleanup after cancellation", async (t) => {
  const { app, plugin, request } = await fixture(t);
  const { ctx } = plugin();
  let enterWeb!: () => void, enterEvent!: () => void, release!: () => void;
  const enteredWeb = new Promise<void>((r) => { enterWeb = r; });
  const enteredEvent = new Promise<void>((r) => { enterEvent = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let webDone = false, eventDone = false, closed = false;
  ctx.web.api("/plugins/contract-check/cleanup", async (_req: any, res: any) => {
    enterWeb(); await gate; webDone = true; if (!res.writableEnded) res.end("done");
  });
  ctx.on("plugin:contract-check:cleanup", async () => { enterEvent(); await gate; eventDone = true; });
  ctx.emit("plugin:contract-check:cleanup", {});
  const response = request("/plugins/contract-check/cleanup", {});
  await Promise.all([enteredWeb, enteredEvent]);
  const closing = app.close().then(() => { closed = true; });
  try {
    assert.equal((await response).status, 503);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(closed, false, "closing the HTTP response must not discard running handler cleanup");
  } finally { release(); }
  await closing;
  assert.ok(webDone && eventDone && closed);
});
