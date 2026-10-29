import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Channels } from "../core/channels.ts";
import { Sessions } from "../core/session.ts";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { MemoryAdmin } from "../core/memory-admin.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "whale-rebinding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  await writeFile(join(root, "a.md"), "我是A");
  await writeFile(join(root, "b.md"), "我是B");
  const config: any = {
    providers: [{ id: "fake", model: "test", base_url: "https://unused.example/v1" }],
    personas: {
      a: { name: "A", file: "a.md", provider: "fake", permission: "off" },
      b: { name: "B", file: "b.md", provider: "fake", permission: "off" },
    },
    channels: { mock: { persona: "a" }, web: { persona: "a" } },
    memory: { recent_lines: 30, budget_tokens: 6000 },
  };
  let models = 0;
  const llm: any = { chat: async () => { models++; return { text: "reply", toolCalls: [] }; } };
  const engine = new MemoryEngine(memory);
  const services: any = { memory, memoryEngine: engine, logger, llm, tools: {
    list: () => [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }],
    call: async () => ({ ok: true, result: "done" }),
  } };
  const sessions = new Sessions(root, config, services);
  engine.maintenance = (id) => sessions.memoryMaintenance || !!(id && sessions.blockedSessions.has(id));
  const channels = new Channels(memory, sessions, config);
  t.after(() => channels.close());
  return { root, memory, config, llm, services, sessions, channels,
    admin: new MemoryAdmin(memory, sessions, logger), modelCount: () => models };
}
const input = (messageId: string) => ({ peer: "friend", sender: "sender", messageId, text: "hello" });
const outgoing = (messageId: string) => ({ peer: "friend", messageId, text: "outgoing" });

test("explicit CAS rebinding retains original receipts through repeated moves and restart", async (t) => {
  const f = await fixture(t), sent: any[] = [];
  const adapter = { id: "mock", account: "one", send: async (message: any) => { sent.push(message); } };
  const handle = f.channels.register(adapter, "adapter");
  const original = await handle.receive(input("in1"));
  await handle.send(outgoing("out1"));
  f.config.channels.mock.persona = "b";
  assert.equal((await handle.receive(input("persona"))).sessionId, original.sessionId);
  await f.memory.saveSessionMeta("existing", { name: "existing conversation" });
  await assert.rejects(() => handle.rebind("friend", { expectedSessionId: "stale", sessionId: "existing" }), /前一会话/);
  await assert.rejects(() => handle.rebind("friend", {} as any), /expectedSessionId/);
  assert.equal(await handle.rebind("friend", { expectedSessionId: original.sessionId, sessionId: "existing" }), "existing");
  assert.deepEqual(await handle.receive(input("in1")), { ...original, duplicate: true });
  assert.equal((await handle.send(outgoing("out1"))).sessionId, original.sessionId);
  await assert.rejects(() => handle.receive({ ...input("in1"), text: "changed" }), /不一致/);
  assert.equal((await handle.receive(input("new"))).sessionId, "existing");
  const fresh = await handle.rebind("friend", { expectedSessionId: "existing" });
  assert.notEqual(fresh, "existing");
  assert.equal((await handle.receive(input("new"))).sessionId, "existing");
  handle.dispose();
  const restarted = new Channels(f.memory, f.sessions, f.config);
  t.after(() => restarted.close());
  const next = restarted.register(adapter, "adapter");
  assert.deepEqual(await next.receive(input("in1")), { ...original, duplicate: true });
  assert.equal((await next.retry("friend", "in1")).sessionId, original.sessionId);
  assert.equal(f.modelCount(), 3);
  assert.equal(sent.length, 4);
  const index = JSON.parse(await readFile(join(f.memory.root, "index.json"), "utf8"));
  assert.equal(Object.values(index.sessions).filter((meta: any) => Object.keys(meta.channel_bindings ?? {}).length).length, 1);
  assert.equal(Object.values(index.channel_routes)[0] && (Object.values(index.channel_routes)[0] as any).sessionId, fresh);
});

test("deleted routes require explicit rebind and retain deduplication after source files are removed", async (t) => {
  const f = await fixture(t);
  let sends = 0;
  const adapter = { id: "mock", account: "one", send: async () => { sends++; } };
  const handle = f.channels.register(adapter);
  const first = await handle.receive(input("old"));
  const out = await handle.send(outgoing("old-out"));
  await f.admin.deleteSession({ id: first.sessionId });
  assert.equal((await f.memory.readSession(first.sessionId)).length, 0);
  await assert.rejects(() => handle.receive(input("new")), /已删除/);
  await assert.rejects(() => handle.send(outgoing("new")), /已删除/);
  await assert.rejects(() => handle.context("friend"), /已删除/);
  const fresh = await handle.rebind("friend", { expectedSessionId: first.sessionId });
  assert.notEqual(fresh, first.sessionId);
  assert.equal((await f.memory.sessionMeta(first.sessionId)).deleted, true);
  assert.deepEqual(await handle.receive(input("old")), { ...first, duplicate: true });
  assert.deepEqual(await handle.send(outgoing("old-out")), { ...out, duplicate: true });
  assert.equal((await handle.receive(input("new"))).sessionId, fresh);
  handle.dispose();
  const nextChannels = new Channels(f.memory, f.sessions, f.config);
  t.after(() => nextChannels.close());
  const next = nextChannels.register(adapter);
  assert.equal((await next.receive(input("old"))).duplicate, true);
  assert.equal(sends, 3);
  assert.equal(f.modelCount(), 2);
});

test("rebinding rejects active generation and transport; concurrent CAS has one winner", async (t) => {
  const f = await fixture(t), generated = deferred(), generate = deferred(), delivered = deferred(), deliver = deferred();
  f.llm.chat = async () => { generated.resolve(); await generate.promise; return { text: "reply", toolCalls: [] }; };
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { delivered.resolve(); await deliver.promise; } });
  await f.memory.saveSessionMeta("first", {});
  await f.memory.saveSessionMeta("second", {});
  await handle.bind("friend", "first");
  const running = handle.receive(input("m1"));
  await generated.promise;
  await assert.rejects(() => handle.rebind("friend", { expectedSessionId: "first", sessionId: "second" }), /收发|处理/);
  generate.resolve();
  await delivered.promise;
  await assert.rejects(() => handle.rebind("friend", { expectedSessionId: "first" }), /收发|处理/);
  deliver.resolve();
  assert.equal((await running).status, "sent");
  const results = await Promise.allSettled([
    handle.rebind("friend", { expectedSessionId: "first", sessionId: "second" }),
    handle.rebind("friend", { expectedSessionId: "first" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message, /前一会话/);
  assert.equal((await handle.receive(input("m1"))).sessionId, "first");
  assert.equal(f.sessions.channelOperations.size, 0);
});

test("tool reentry refuses route migration without deadlocking an awaited outbound send", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  let models = 0, sends = 0;
  f.llm.chat = async () => ++models === 1
    ? { text: "", toolCalls: [{ id: "inspect1", name: "inspect", arguments: "{}" }] }
    : { text: "done", toolCalls: [] };
  const handle = f.channels.register({ id: "mock", account: "one", permission: "full", send: async () => { sends++; } });
  await f.memory.saveSessionMeta("existing", {});
  await handle.bind("friend", "existing");
  f.services.tools.call = async () => {
    await assert.rejects(() => handle.rebind("friend", { expectedSessionId: "existing" }), /收发|处理/);
    assert.equal((await handle.send(outgoing("tool"))).status, "sent");
    return { ok: true, result: "sent" };
  };
  assert.equal((await handle.receive(input("model"))).status, "sent");
  assert.equal(models, 2);
  assert.equal(sends, 2);
});

test("route ownership cannot be taken over while explicit session sharing remains available", async (t) => {
  const f = await fixture(t);
  const adapter = { id: "mock", account: "one", send: async () => {} };
  const handle = f.channels.register(adapter, "first");
  const original = await handle.receive(input("original"));
  handle.dispose();
  const takeover = f.channels.register(adapter, "other");
  await assert.rejects(() => takeover.rebind("friend", { expectedSessionId: original.sessionId }), /其他插件/);
  await assert.rejects(() => takeover.receive(input("other")), /其他插件/);
  assert.equal(await takeover.rebind("new-peer", { expectedSessionId: null, sessionId: original.sessionId }), original.sessionId);
});

test("explicit fresh binding checks absence and target existence without reviving tombstones", async (t) => {
  const f = await fixture(t);
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => {} });
  const id = await handle.rebind("friend", { expectedSessionId: null });
  await assert.rejects(() => handle.rebind("friend", { expectedSessionId: null }), /前一会话/);
  await assert.rejects(() => handle.rebind("friend", { expectedSessionId: id, sessionId: "missing" }), /不存在/);
  await f.memory.saveSessionMeta("deleted", {});
  await f.admin.deleteSession({ id: "deleted" });
  await assert.rejects(() => handle.rebind("friend", { expectedSessionId: id, sessionId: "deleted" }), /已删除/);
  assert.equal((await handle.receive(input("m1"))).sessionId, id);
});

test("failed persisted rebind keeps the old route and all receipts intact", async (t) => {
  const f = await fixture(t);
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => {} });
  const first = await handle.receive(input("saved"));
  await f.memory.saveSessionMeta("target", {});
  const before = await readFile(join(f.memory.root, "index.json"), "utf8");
  const fs = createRequire(import.meta.url)("node:fs/promises"), rename = fs.rename;
  fs.rename = async (from: any, to: any) => {
    if (String(to) === join(f.memory.root, "index.json"))
      throw Object.assign(Error("simulated commit failure"), { code: "EIO" });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => handle.rebind("friend", { expectedSessionId: first.sessionId, sessionId: "target" }), /commit failure/);
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(join(f.memory.root, "index.json"), "utf8"), before);
  assert.equal((await handle.receive(input("saved"))).duplicate, true);
  assert.equal(await handle.rebind("friend", { expectedSessionId: first.sessionId, sessionId: "target" }), "target");
});

test("shutdown aborts transports, refuses new work, drains queued operations and preserves confirmed delivery", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  let sendSignal!: AbortSignal, sends = 0, closed = false;
  const handle = f.channels.register({ id: "mock", account: "one", send: async (_message, { signal }) => {
    sends++; sendSignal = signal; entered.resolve(); await release.promise;
  } });
  const first = handle.send(outgoing("one"));
  await entered.promise;
  const queued = handle.send(outgoing("two"));
  const queuedSettled = Promise.allSettled([queued]);
  const closing = f.channels.close().then(() => { closed = true; });
  assert.equal(sendSignal.aborted, true);
  assert.throws(() => handle.send(outgoing("three")), /已关闭/);
  assert.throws(() => f.channels.register({ id: "mock", account: "two", send: async () => {} }), /已关闭/);
  assert.throws(() => f.channels.web("web", "hello", () => {}), /已关闭/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  assert.equal((await first).status, "sent");
  await queuedSettled;
  await closing;
  await f.channels.close();
  assert.equal(sends, 1);
  assert.equal(f.sessions.channelOperations.size, 0);
  assert.equal(f.sessions.blockedSessions.size, 0);
  const next = new Channels(f.memory, f.sessions, f.config);
  t.after(() => next.close());
  assert.equal((await next.register({ id: "mock", account: "one", send: async () => { sends++; } }).send(outgoing("one"))).duplicate, true);
  assert.equal(sends, 1);
});

test("confirmed transport success remains sent if its receipt commit fails and duplicates never resend", async (t) => {
  const f = await fixture(t);
  let sends = 0;
  const real = f.memory.channelRoute.bind(f.memory);
  f.memory.channelRoute = ((key: string, update: any) => real(key, async (route: any, sessions: any) => {
    const changed = await update(route, sessions);
    if (changed.route && Object.values(changed.route.receipts).some((entry: any) => entry.receipt.status === "sent"))
      throw Error("receipt unavailable");
    return changed;
  })) as typeof f.memory.channelRoute;
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { sends++; } });
  const sent = await handle.send(outgoing("one"));
  assert.equal(sent.status, "sent");
  assert.match(sent.error!, /发送已确认/);
  assert.equal((await handle.send(outgoing("one"))).status, "uncertain");
  await assert.rejects(() => handle.retry("friend", "one", { direction: "out" }), /不能重放/);
  assert.equal(sends, 1);
});

test("restoring an older backup restores its route but never rolls back newer external receipts", async (t) => {
  const f = await fixture(t);
  let sends = 0;
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { sends++; } });
  const first = await handle.receive(input("before"));
  const backup = await f.admin.backup();
  const fresh = await handle.rebind("friend", { expectedSessionId: first.sessionId });
  const recent = await handle.receive(input("after"));
  const outbound = await handle.send(outgoing("after-out"));
  await f.admin.deleteSession({ id: fresh });
  await f.admin.restore({ id: backup.id });
  assert.deepEqual(await handle.receive(input("after")), { ...recent, duplicate: true });
  assert.deepEqual(await handle.send(outgoing("after-out")), { ...outbound, duplicate: true });
  assert.equal((await handle.receive(input("new"))).sessionId, first.sessionId);
  assert.equal(f.modelCount(), 3);
  assert.equal(sends, 4);
});

test("restoring a backup from before a route existed retains receipts behind an explicit rebind tombstone", async (t) => {
  const f = await fixture(t);
  const backup = await f.admin.backup();
  let sends = 0;
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { sends++; } });
  const sent = await handle.receive(input("sent"));
  await f.admin.restore({ id: backup.id });
  await assert.rejects(() => handle.receive(input("sent")), /已删除/);
  assert.equal((await f.memory.sessionMeta(sent.sessionId)).deleted, true);
  await handle.rebind("friend", { expectedSessionId: sent.sessionId });
  assert.deepEqual(await handle.receive(input("sent")), { ...sent, duplicate: true });
  assert.equal(sends, 1);
  assert.equal(f.modelCount(), 1);
});

test("restore validates channel receipt contents even when the backup manifest hashes match", async (t) => {
  const f = await fixture(t);
  let sends = 0;
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { sends++; } });
  const first = await handle.receive(input("saved"));
  const backup = await f.admin.backup();
  const folder = join(f.admin.backupRoot, backup.id), path = join(folder, "data", "index.json");
  const index = JSON.parse(await readFile(path, "utf8"));
  const route: any = Object.values(index.channel_routes)[0];
  const stored: any = Object.values(route.receipts)[0];
  stored.receipt.delivery_id = "forged";
  const raw = JSON.stringify(index, null, 2);
  await writeFile(path, raw);
  const manifestPath = join(folder, "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest.files.find((file: any) => file.path === "index.json");
  entry.bytes = Buffer.byteLength(raw);
  entry.sha256 = createHash("sha256").update(raw).digest("hex");
  manifest.bytes = manifest.files.reduce((total: number, file: any) => total + file.bytes, 0);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => f.admin.restore({ id: backup.id }), /渠道消息回执损坏/);
  assert.equal(f.sessions.memoryMaintenance, false);
  assert.deepEqual(await handle.receive(input("saved")), { ...first, duplicate: true });
  assert.equal(sends, 1);
});

test("legacy channel receipts migrate before rebinding and deleted legacy receipts fail closed", async (t) => {
  const f = await fixture(t);
  let sends = 0;
  const handle = f.channels.register({ id: "mock", account: "one", send: async () => { sends++; } });
  const first = await handle.receive(input("legacy"));
  const path = join(f.memory.root, "index.json");
  const index = JSON.parse(await readFile(path, "utf8"));
  delete index.channel_routes;
  await writeFile(path, JSON.stringify(index));
  const fresh = await handle.rebind("friend", { expectedSessionId: first.sessionId });
  assert.deepEqual(await handle.receive(input("legacy")), { ...first, duplicate: true });
  await f.admin.deleteSession({ id: fresh });
  const deleted = JSON.parse(await readFile(path, "utf8"));
  delete deleted.channel_routes;
  await writeFile(path, JSON.stringify(deleted));
  await assert.rejects(() => handle.rebind("friend", { expectedSessionId: fresh }), /缺少独立回执/);
  assert.equal(sends, 1);
  assert.equal(f.modelCount(), 1);
});

test("shutdown waits for a model which ignores abort and does not execute its late tools", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  let tools = 0, sends = 0, closed = false;
  f.llm.chat = async () => {
    entered.resolve(); await release.promise;
    return { text: "", toolCalls: [{ id: "late", name: "inspect", arguments: "{}" }] };
  };
  f.services.tools.call = async () => { tools++; return { ok: true, result: "done" }; };
  const handle = f.channels.register({ id: "mock", account: "one", permission: "full", send: async () => { sends++; } });
  const pending = handle.receive(input("late"));
  await entered.promise;
  const closing = f.channels.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  assert.equal((await pending).status, "generation_failed");
  await closing;
  assert.equal(sends, 0);
  assert.equal(tools, 0);
  assert.equal(f.sessions.channelOperations.size, 0);
  assert.equal(f.sessions.blockedSessions.size, 0);
});

test("a replacement plugin cannot join another owner's still-running duplicate flight", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const adapter = { id: "mock", account: "one", send: async () => { entered.resolve(); await release.promise; } };
  const old = f.channels.register(adapter, "old-owner");
  const pending = old.send(outgoing("same"));
  await entered.promise;
  old.dispose();
  const next = f.channels.register(adapter, "new-owner");
  await assert.rejects(() => next.send(outgoing("same")), /其他插件/);
  release.resolve();
  assert.equal((await pending).status, "sent");
});

test("persistent delivery claims prevent concurrent replacement instances from sending twice", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  let sends = 0, fail = true;
  const adapter = { id: "mock", account: "one", send: async () => {
    sends++;
    if (fail) throw Error("transport failed");
    entered.resolve(); await release.promise;
  } };
  const first = f.channels.register(adapter);
  assert.equal((await first.send(outgoing("retry"))).status, "delivery_failed");
  fail = false;
  const another = new Channels(f.memory, f.sessions, f.config);
  t.after(() => another.close());
  const next = another.register(adapter);
  const retry = first.retry("friend", "retry", { direction: "out" });
  await entered.promise;
  await assert.rejects(() => next.retry("friend", "retry", { direction: "out" }), /不能重放/);
  assert.equal((await next.send(outgoing("retry"))).status, "uncertain");
  release.resolve();
  assert.equal((await retry).status, "sent");
  assert.equal((await next.retry("friend", "retry", { direction: "out" })).status, "sent");
  assert.equal(sends, 2);
});
