import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Channels } from "../core/channels.ts";
import { Sessions } from "../core/session.ts";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { MemoryAdmin } from "../core/memory-admin.ts";
import { Runtime } from "../core/runtime.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "whale-channels-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  await writeFile(join(root, "a.md"), "我是A");
  await writeFile(join(root, "b.md"), "我是B");
  const config: any = {
    providers: [{ id: "demo", model: "chat", base_url: "https://unused.example/v1" }],
    personas: {
      a: { name: "A", file: "a.md", provider: "demo", permission: "off" },
      b: { name: "B", file: "b.md", provider: "demo", permission: "off" },
    },
    channels: { web: { persona: "a", permission: "off" }, mock: { persona: "a", permission: "off" } },
    memory: { recent_lines: 30, budget_tokens: 6000 },
  };
  const requests: any[] = [], calls: any[] = [];
  const engine = new MemoryEngine(memory);
  const llm: any = {
    chat: async (r: any) => {
      requests.push(structuredClone(r.messages));
      return { text: "已收到", toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } };
    },
  };
  const services: any = { memory, memoryEngine: engine, logger, llm, tools: {
    list: () => [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }],
    call: async (...args: any[]) => { calls.push(args); return { ok: true, result: "完成" }; },
  } };
  const sessions = new Sessions(root, config, services);
  engine.maintenance = (id) => sessions.memoryMaintenance || !!(id && sessions.blockedSessions.has(id));
  const channels = new Channels(memory, sessions, config);
  const admin = new MemoryAdmin(memory, sessions, logger);
  return { root, logger, memory, engine, config, requests, calls, llm, services, sessions, channels, admin };
}
const input = (messageId: string, peer = "friend") => ({ peer, sender: "sender", messageId, text: "你好" });

test("routes isolate channel/account/peer, persist across restart and retain normal memory and token accounting", async (t) => {
  const f = await fixture(t), deliveries: any[] = [];
  const one = f.channels.register({ id: "mock", account: "one", send: async (m) => { deliveries.push(m); } });
  const first = await one.receive(input("m1"));
  assert.equal(first.status, "sent");
  const two = f.channels.register({ id: "mock", account: "two", send: async () => {} });
  const other = f.channels.register({ id: "other", account: "one", persona: "b", send: async () => {} });
  const results = await Promise.all([one.receive(input("m2", "other-peer")), two.receive(input("m1")), other.receive(input("m1"))]);
  assert.equal(new Set([first.sessionId, ...results.map((x) => x.sessionId)]).size, 4);
  assert.ok(f.requests.some((request) => /我是B/.test(request[0].content)));
  const rows = (await f.memory.readSession(first.sessionId)).filter((r) => r.type === "message");
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].channel, rows[0].account, rows[0].peer, rows[0].sender, rows[0].external_message_id], ["mock", "one", "friend", "sender", "m1"]);
  assert.equal((await one.context("friend")).usage.used_tokens, 15);
  one.dispose();
  const next = new Channels(f.memory, f.sessions, f.config).register({ id: "mock", account: "one", send: async (m) => { deliveries.push(m); } });
  const repeated = await next.receive(input("m1"));
  assert.equal(repeated.sessionId, first.sessionId);
  assert.equal(repeated.duplicate, true);
  assert.equal(deliveries.filter((x) => x.peer === "friend").length, 1);
  assert.equal(f.requests.length, 4);
});

test("explicit initial binding shares an existing session and cannot silently remap or resurrect tombstones", async (t) => {
  const f = await fixture(t);
  await f.sessions.chat("shared", "共享暗号SEA", () => {});
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => {} });
  assert.equal(await handle.bind("friend", "shared"), "shared");
  assert.equal(await handle.bind("friend", "shared"), "shared");
  const result = await handle.receive(input("m1"));
  assert.equal(result.sessionId, "shared");
  assert.match(JSON.stringify(f.requests[1]), /共享暗号SEA/);
  await f.memory.saveSessionMeta("other", {});
  await assert.rejects(() => handle.bind("friend", "other"), /不支持迁移/);
  await assert.rejects(() => handle.bind("new", "missing"), /不存在/);
  await f.admin.deleteSession({ id: "shared" });
  await assert.rejects(() => handle.receive(input("m2")), /已删除/);
  await assert.rejects(() => handle.bind("friend", "other"), /已删除/);
  assert.equal((await f.memory.sessionMeta("shared"))?.deleted, true);
});

test("in-flight duplicate inputs generate once, while independent messages on a shared session run in order", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  let models = 0, sent = 0;
  f.llm.chat = async () => { if (++models === 1) { entered.resolve(); await release.promise; } return { text: "reply", toolCalls: [] }; };
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { sent++; } });
  const first = handle.receive(input("m1"));
  await entered.promise;
  const duplicate = handle.receive(input("m1"));
  await assert.rejects(() => handle.receive({ ...input("m1"), text: "不同内容" }), /不一致/);
  const second = handle.receive(input("m2"));
  release.resolve();
  const [a, b, c] = await Promise.all([first, duplicate, second]);
  assert.equal(a.status, "sent"); assert.equal(b.duplicate, true); assert.equal(c.status, "sent");
  assert.equal(models, 2); assert.equal(sent, 2);
});

test("failed delivery retries cached output with stable delivery ID without replaying model or tools", async (t) => {
  const f = await fixture(t), deliveries: any[] = [];
  let models = 0, fail = true;
  f.llm.chat = async () => ++models === 1
    ? { text: "", toolCalls: [{ id: "t1", name: "inspect", arguments: "{}" }] }
    : { text: "已执行", toolCalls: [] };
  const handle = f.channels.register({ id: "mock", account: "one", permission: "full", send: async (m) => { deliveries.push(m); if (fail) throw Error("transport timeout"); } });
  const result = await handle.receive(input("m1"));
  assert.equal(result.status, "delivery_failed");
  assert.match(result.error!, /可能不确定/);
  assert.equal(f.calls[0][2].channel, "mock"); assert.equal(f.calls[0][2].permission, "full");
  assert.equal((await handle.receive(input("m1"))).status, "delivery_failed");
  assert.equal(deliveries.length, 1);
  fail = false;
  handle.dispose();
  const replacement = new Channels(f.memory, f.sessions, f.config).register({ id: "mock", account: "one", send: async (m) => { deliveries.push(m); } });
  assert.equal((await replacement.retry("friend", "m1")).status, "sent");
  assert.equal(models, 2); assert.equal(f.calls.length, 1);
  assert.equal(deliveries[0].deliveryId, deliveries[1].deliveryId);
  assert.equal((await replacement.retry("friend", "m1")).duplicate, true);
  assert.equal(deliveries.length, 2);
});

test("generation failures and pending crash receipts never replay tools on duplicate receive or delivery retry", async (t) => {
  const f = await fixture(t);
  let models = 0;
  f.llm.chat = async () => { models++; throw Error("model unavailable"); };
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { throw Error("must not send"); } });
  const result = await handle.receive(input("m1"));
  assert.equal(result.status, "generation_failed");
  assert.equal((await handle.receive(input("m1"))).duplicate, true);
  await assert.rejects(() => handle.retry("friend", "m1"), /不能重放/);
  const row = (await f.memory.readSession(result.sessionId)).find((r) => r.type === "channel_receipt");
  await f.memory.appendEvent({ ...row, id: undefined, status: "pending" });
  assert.equal((await handle.receive(input("m1"))).status, "uncertain");
  await assert.rejects(() => handle.retry("friend", "m1"), /不能重放/);
  assert.equal(models, 1);
});

test("adapter disposal and caller cancellation prevent stale sends and subsequent tool calls", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  let sent = 0;
  f.llm.chat = async () => { entered.resolve(); await release.promise; return { text: "", toolCalls: [{ id: "t1", name: "inspect", arguments: "{}" }] }; };
  const handle = f.channels.register({ id: "mock", account: "one", permission: "full", send: async () => { sent++; } });
  const pending = handle.receive(input("m1"));
  await entered.promise;
  handle.dispose(); release.resolve();
  assert.equal((await pending).status, "generation_failed");
  assert.equal(sent, 0); assert.equal(f.calls.length, 0);
  assert.throws(() => handle.receive(input("m2")), /已停用/);
  const next = f.channels.register({ id: "mock", account: "one", send: async () => { sent++; } });
  const signal = AbortSignal.abort(Error("cancelled"));
  assert.throws(() => next.receive(input("m3"), { signal }), /cancelled/);
  assert.equal(sent, 0);
});

test("runtime binds ownership and lifecycle consistently through channels and get('channels')", async (t) => {
  const f = await fixture(t), runtime = new Runtime(f.root, f.logger);
  await runtime.builtin("channels", f.channels);
  await runtime.bus.start();
  t.after(() => runtime.bus.stop());
  let api: any, handle: any;
  await runtime.load("adapter", { id: "adapter" }, (ctx: any) => {
    assert.equal(ctx.channels, ctx.get("channels"));
    api = ctx.channels;
    handle = api.register({ id: "mock", account: "one", send: async () => {} });
  });
  await handle.receive(input("m1"));
  await runtime.load("other", { id: "other" }, (ctx: any) => {
    assert.throws(() => ctx.channels.send({ channel: "mock", account: "one", peer: "friend", messageId: "out1", text: "hi" }), /本插件/);
  });
  await runtime.stop("adapter");
  assert.throws(() => api.register({ id: "mock", account: "two", send: async () => {} }), /已停用/);
  assert.throws(() => handle.receive(input("m2")), /已停用/);
  const takeover = f.channels.plugin("other", () => {}).register({ id: "mock", account: "one", send: async () => {} });
  await assert.rejects(() => takeover.receive(input("m2")), /其他插件/);
});

test("trusted registration validates policy, rejects message policy injection, and outbound send never invokes model", async (t) => {
  const f = await fixture(t), sent: any[] = [];
  assert.throws(() => f.channels.register({ id: "mock", account: "one", persona: "missing", send: async () => {} }), /有效人格/);
  assert.throws(() => f.channels.register({ id: "mock", account: "one", permission: "super" as any, send: async () => {} }), /权限/);
  assert.throws(() => f.channels.register({ id: "web", account: "one", send: async () => {} }), /保留/);
  const api = f.channels.plugin("adapter", () => {});
  const handle = api.register({ id: "mock", account: "one", send: async (m) => { sent.push(m); } });
  await assert.rejects(() => handle.bind("friend", "../invalid"), /ID 无效/);
  await assert.rejects(() => handle.bind("", "valid"), /peer 无效/);
  assert.equal(f.sessions.blockedSessions.size, 0, "invalid bindings must release the restore guard");
  assert.throws(() => handle.receive({ ...input("m1"), persona: "b" } as any), /路由策略/);
  assert.throws(() => handle.receive({ ...input("m1"), permission: "full" } as any), /路由策略/);
  const outgoing = { channel: "mock", account: "one", peer: "friend", messageId: "out1", text: "主动文本" };
  assert.equal((await api.send(outgoing)).status, "sent");
  assert.equal((await api.send(outgoing)).duplicate, true);
  assert.equal(f.requests.length, 0); assert.equal(sent.length, 1); assert.equal(sent[0].replyTo, undefined);
});

test("Web unified entry preserves explicit session, streaming callbacks, expectedPersona and persona switching history", async (t) => {
  const f = await fixture(t), chunks: string[] = [], contexts: any[] = [];
  f.llm.chat = async (request: any) => { f.requests.push(request.messages); request.onChunk("流式"); return { text: "流式", toolCalls: [] }; };
  await f.channels.web("web_same", "共同暗号WEB", (s) => chunks.push(s), (c) => contexts.push(c), "a");
  f.config.channels.web.persona = "b";
  await assert.rejects(() => f.channels.web("web_same", "stale", () => {}, undefined, "a"), /其他窗口切换/);
  await f.channels.web("web_same", "继续", (s) => chunks.push(s), (c) => contexts.push(c), "b");
  assert.deepEqual(chunks, ["流式", "流式"]);
  assert.deepEqual(contexts.map((c) => c.personaId), ["a", "b"]);
  assert.match(JSON.stringify(f.requests[1]), /共同暗号WEB/);
  assert.equal((await f.memory.readSession("web_same")).filter((x) => x.type === "message").length, 4);
});

test("delivery receipts do not reset explicit persona-scoped history or usage status", async (t) => {
  const f = await fixture(t);
  await f.memory.saveSessionMeta("persona_shared", { context: { history_scope: "persona" } });
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => {} });
  await handle.bind("friend", "persona_shared");
  await handle.receive({ ...input("m1"), text: "人格暗号PERSONA" });
  await handle.receive(input("m2"));
  assert.match(JSON.stringify(f.requests[1]), /人格暗号PERSONA/);
  const status = await handle.context("friend");
  assert.equal(status.available_messages, 4);
  assert.equal(status.usage.used_tokens, 15);
});

test("a tool can await outbound send on its current session without replaying generation or deadlocking", { timeout: 5000 }, async (t) => {
  const f = await fixture(t), sent: any[] = [];
  let models = 0;
  f.llm.chat = async () => ++models === 1
    ? { text: "", toolCalls: [{ id: "t1", name: "inspect", arguments: "{}" }] }
    : { text: "最终回复", toolCalls: [] };
  const handle = f.channels.register({ id: "mock", account: "one", permission: "full", send: async (m) => { sent.push(m); } });
  f.services.tools.call = async () => {
    const result = await handle.send({ peer: "friend", messageId: "action1", text: "工具发出的文本" });
    assert.equal(result.status, "sent");
    return { ok: true, result: "sent" };
  };
  const result = await handle.receive(input("m1"));
  assert.equal(result.status, "sent"); assert.equal(models, 2); assert.equal(sent.length, 2);
  assert.equal(f.sessions.locks.size, 0); assert.equal(f.sessions.channelOperations.size, 0);
  const state = await f.engine.state(result.sessionId);
  assert.ok(state.records.some((r: any) => r.kind === "episode" && r.outcome === "succeeded" && /工具发出的文本/.test(r.text)));
});

test("active transport protects session deletion and backup restore while preserving normal chat locks", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { entered.resolve(); await release.promise; } });
  await f.memory.saveSessionMeta("busy", {});
  await handle.bind("friend", "busy");
  f.sessions.locks.add("busy");
  const sending = handle.send({ peer: "friend", messageId: "out1", text: "outbound" });
  await entered.promise;
  assert.equal(f.sessions.channelOperations.has("busy"), true);
  f.sessions.locks.delete("busy");
  await assert.rejects(() => f.admin.deleteSession({ id: "busy" }), /正在|稍候|等待/);
  await assert.rejects(() => f.admin.restore({ id: "unused" } as any), /对话正在/);
  f.sessions.locks.add("busy");
  release.resolve(); await sending;
  assert.equal(f.sessions.locks.has("busy"), true, "outbound transport never releases the enclosing chat lock");
  f.sessions.locks.delete("busy");
});

test("backup restore carries channel bindings and successful receipts without cached-route drift", async (t) => {
  const f = await fixture(t);
  let sent = 0;
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { sent++; } });
  const result = await handle.receive(input("m1"));
  const backup = await f.admin.backup();
  await f.admin.deleteSession({ id: result.sessionId });
  await assert.rejects(() => handle.receive(input("m1")), /已删除/);
  await f.admin.restore({ id: backup.id });
  const repeated = await handle.receive(input("m1"));
  assert.equal(repeated.status, "sent"); assert.equal(repeated.duplicate, true);
  assert.equal(repeated.sessionId, result.sessionId); assert.equal(sent, 1); assert.equal(f.requests.length, 1);
});
