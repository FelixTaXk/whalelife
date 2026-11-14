/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Channels, type OutgoingMessage } from "../core/channels.ts";
import { Sessions } from "../core/session.ts";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { shortContext } from "../core/memory-lifecycle.ts";
import { persona } from "../core/persona.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const answer = (text = "下一轮回答") => ({ text, toolCalls: [],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
const outgoing = (text = "已经发出的正文", messageId = "action-one") => ({ peer: "friend", messageId, text });
const messages = async (memory: Memory, id = "shared") => (await memory.readSession(id)).filter(row => row.type === "message");
const delivered = async (memory: Memory, id = "shared") => (await messages(memory, id))
  .filter(row => row.role === "assistant" && row.channel === "mock" && row.delivery_id);
const requestText = (rows: any[]) => rows.map(row => typeof row.content === "string" ? row.content : JSON.stringify(row.content)).join("\n");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-outgoing-history-");
  const config: any = {
    providers: [{ id: "demo", model: "chat", base_url: "https://unused.invalid/v1" }],
    personas: {
      a: { name: "A", file: "a.md", provider: "demo", permission: "off" },
      b: { name: "B", file: "b.md", provider: "demo", permission: "off" },
    },
    channels: { web: { persona: "a", permission: "off" }, mock: { persona: "a", permission: "off" } },
    memory: { diary_enabled: false, history_enabled: true, history_scope: "session", budget_tokens: 6000 },
    timezone: "Asia/Shanghai",
  };
  const requests: any[][] = [], sends: OutgoingMessage[] = [], warnings: any[] = [];
  const logger: any = { info() {}, error() {}, warn: (...args: any[]) => warnings.push(args) };
  let model: (request: any) => any = () => answer();
  let transport: (message: OutgoingMessage) => Promise<void> = async () => {};
  let memory!: Memory, engine!: MemoryEngine, sessions!: Sessions, channels!: Channels, services: any;
  let api!: ReturnType<Channels["plugin"]>, handle!: ReturnType<Channels["register"]>;
  const close = async () => { await channels?.close(); await sessions?.close(); await memory?.queue; };
  t.after(close);
  await writeFile(join(root, "a.md"), "虚构人格甲。根据实际提供的历史交流。");
  await writeFile(join(root, "b.md"), "虚构人格乙。根据实际提供的历史交流。");
  const open = async () => {
    memory = new Memory(join(root, "memory"), logger);
    await memory.init();
    engine = new MemoryEngine(memory);
    services = { memory, memoryEngine: engine, logger,
      llm: { chat: async (request: any) => { requests.push(structuredClone(request.messages)); return model(request); } },
      tools: { entries: new Map(),
        list: () => [{ type: "function", function: { name: "send_probe", parameters: { type: "object" } } }],
        call: async () => ({ ok: true, result: "工具完成" }),
      },
    };
    sessions = new Sessions(root, config, services);
    engine.maintenance = id => sessions.memoryMaintenance || !!(id && sessions.blockedSessions.has(id));
    channels = new Channels(memory, sessions, config);
    api = channels.plugin("adapter", () => {});
    handle = api.register({ id: "mock", name: "星港交流", account: "one", send: async message => {
      sends.push(structuredClone(message)); await transport(message);
    } });
  };
  await open();
  await memory.saveSessionMeta("shared", {});
  await handle.bind("friend", "shared");
  const state = await engine.state("shared");
  await engine.settings("shared", { ...state.settings, enabled: false }, state.memberships);
  return { root, config, requests, sends, warnings,
    get memory() { return memory; }, get engine() { return engine; }, get sessions() { return sessions; },
    get channels() { return channels; }, get services() { return services; }, get api() { return api; }, get handle() { return handle; },
    setModel: (value: typeof model) => { model = value; }, setTransport: (value: typeof transport) => { transport = value; },
    restart: async () => { await close(); await open(); },
    web: (text = "继续吧", id = "shared") => channels.web(id, text, () => {}),
  };
}

// Simulate an existing durable receipt from a previous host, without creating a
// successful transport or a conversational message in this test process.
async function replaceReceipt(f: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown>) {
  const rows = await f.memory.readSession("shared");
  const previous = rows.findLast(row => row.type === "channel_receipt");
  assert.ok(previous);
  await f.memory.channelRoute(previous.channel_key, async (route: any) => ({
    route: { ...route, receipts: Object.fromEntries(Object.entries(route.receipts).map(([key, value]: [string, any]) =>
      [key, value.receipt.external_message_id === previous.external_message_id && value.receipt.direction === previous.direction
        ? { ...value, receipt: { ...value.receipt, ...patch } } : value])) }, result: undefined,
  }));
  await f.memory.appendEvent({ ...previous, ...patch, id: undefined });
}

async function appendLegacySent(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const [key] = Object.keys((await f.memory.sessionMeta("shared"))!.channel_bindings);
  const receipt = { type: "channel_receipt", session: "shared", channel: "mock", account: "one", peer: "friend",
    channel_key: key, external_message_id: "legacy-one", direction: "out", fingerprint: "legacy-fingerprint",
    delivery_id: "delivery_legacy_one", status: "sent", text, ts: new Date().toISOString() };
  await f.memory.appendEvent(receipt);
  return receipt;
}

test("confirmed outbound text is complete shared history with source, even without recall or matching words", async t => {
  const f = await fixture(t);
  const text = "开头标记蓝帆。\n" + "这是已确认发出的完整段落，保留顺序和表情🐳。\n".repeat(420) + "末尾标记橙桥。";
  const result = await f.api.send({ channel: "mock", account: "one", ...outgoing(text) });
  assert.equal(result.status, "sent");
  assert.equal(f.requests.length, 0, "direct send must not invoke a model");
  const rows = await delivered(f.memory);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, text);
  assert.deepEqual([rows[0].session, rows[0].channel, rows[0].account, rows[0].peer, rows[0].external_message_id, rows[0].delivery_id],
    ["shared", "mock", "one", "friend", "action-one", result.deliveryId]);
  assert.deepEqual(rows[0].origin, { plugin: "adapter", channel: "mock", platform: "星港交流", action: "发送消息" });
  assert.equal(rows[0].persona_id, "a");
  assert.equal(rows[0].persona_revision, (await persona(f.root, f.config, "a")).revision);
  assert.equal((await f.engine.contextRows("shared")).filter(row => row.type === "message" && row.text === text).length, 1,
    "the materialized message and its sent receipt form one history entry");
  const state = await f.engine.state("shared");
  assert.equal(state.settings.enabled, false);
  assert.equal(state.records.filter(row => row.source === "channel:adapter" && row.outcome === "succeeded").length, 1,
    "keep the existing experience projection for compatible consumers");
  f.config.channels.web.persona = "b";
  await f.web();
  assert.ok(f.requests.at(-1)!.some(row => row.role === "assistant" && row.content.includes(text)), "the model receives full assistant history");
  assert.match(requestText(f.requests.at(-1)!), /星港交流/);
});

test("concurrent duplicates and a full service restart keep one delivery and one assistant message", async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t);
  f.setTransport(async () => { entered.resolve(); await release.promise; });
  const first = f.handle.send(outgoing());
  await entered.promise;
  const duplicate = f.handle.send(outgoing());
  release.resolve();
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a.status, "sent"); assert.equal(b.duplicate, true);
  const original = await delivered(f.memory);
  assert.equal(original.length, 1);
  await f.restart();
  assert.equal((await f.handle.send(outgoing())).duplicate, true);
  assert.equal((await f.handle.retry("friend", "action-one", { direction: "out" })).duplicate, true);
  assert.equal(f.sends.length, 1);
  assert.deepEqual(await delivered(f.memory), original);
  await f.web();
  assert.equal(requestText(f.requests.at(-1)!).split(outgoing().text).length - 1, 1);
});

test("failed transport creates no success history and explicit retry preserves delivery identity and original persona", async t => {
  const f = await fixture(t), revision = (await persona(f.root, f.config, "a")).revision;
  f.setTransport(async () => { throw Error("synthetic transport failure"); });
  const failed = await f.handle.send(outgoing());
  assert.equal(failed.status, "delivery_failed");
  assert.equal((await messages(f.memory)).length, 0);
  assert.equal((await f.engine.state("shared")).records.some(row => row.outcome === "succeeded"), false);
  await f.web();
  assert.equal(requestText(f.requests.at(-1)!).includes(outgoing().text), false);
  f.config.channels.mock.persona = "b";
  await writeFile(join(f.root, "a.md"), "已经修改的人格甲。");
  await f.restart();
  f.setTransport(async () => {});
  const retried = await f.handle.retry("friend", "action-one", { direction: "out" });
  assert.equal(retried.status, "sent");
  assert.equal(retried.deliveryId, failed.deliveryId);
  const rows = await delivered(f.memory);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].persona_id, "a"); assert.equal(rows[0].persona_revision, revision);
  assert.equal(rows[0].external_message_id, "action-one");
  assert.equal((await f.handle.retry("friend", "action-one", { direction: "out" })).duplicate, true);
  assert.equal(f.sends.length, 2);
});

test("an interrupted delivering receipt stays uncertain without inventing history or resending", async t => {
  const f = await fixture(t);
  f.setTransport(async () => { throw Error("synthetic interruption"); });
  await f.handle.send(outgoing());
  await replaceReceipt(f, { status: "delivering", error: undefined });
  await f.restart();
  const repeated = await f.handle.send(outgoing());
  assert.equal(repeated.status, "uncertain"); assert.equal(repeated.duplicate, true);
  await assert.rejects(() => f.handle.retry("friend", "action-one", { direction: "out" }), /不能重放/);
  assert.equal((await messages(f.memory)).length, 0); assert.equal(f.sends.length, 1);
  await f.web();
  assert.equal(requestText(f.requests.at(-1)!).includes(outgoing().text), false);
});

test("outbound history preserves measured model usage and incoming replies are not recorded twice", async t => {
  const f = await fixture(t);
  const input = { peer: "friend", sender: "reader", messageId: "incoming-one", text: "真实入站问题" };
  assert.equal((await f.handle.receive(input)).status, "sent");
  const before = await f.handle.context("friend");
  assert.equal(before.usage.used_tokens, 15);
  await f.handle.send(outgoing());
  const after = await f.handle.context("friend");
  assert.equal(after.usage.used_tokens, before.usage.used_tokens);
  assert.deepEqual(after.consumption, before.consumption, "direct send must not fabricate a model request");
  assert.equal(after.available_messages, 3);
  assert.equal((await f.handle.receive(input)).duplicate, true);
  const rows = await messages(f.memory);
  assert.equal(rows.filter(row => row.text === "下一轮回答").length, 1);
  assert.equal(rows.filter(row => row.text === outgoing().text).length, 1);
  assert.equal(f.requests.length, 1);
});

test("outbound messages honor persona history scope and stay isolated from other sessions", async t => {
  const f = await fixture(t);
  await f.memory.saveSessionMeta("shared", { context: { history_scope: "persona" } });
  await f.web("旧人格共同暗号");
  await f.handle.send(outgoing("人格甲已发正文"));
  assert.equal((await f.handle.context("friend")).available_messages, 3);
  await f.web();
  assert.match(requestText(f.requests.at(-1)!), /旧人格共同暗号/);
  assert.match(requestText(f.requests.at(-1)!), /人格甲已发正文/);
  f.config.channels.web.persona = "b";
  await f.web();
  assert.equal(requestText(f.requests.at(-1)!).includes("人格甲已发正文"), false);
  await f.memory.saveSessionMeta("unrelated", {});
  await f.web("继续吧", "unrelated");
  assert.equal(requestText(f.requests.at(-1)!).includes("人格甲已发正文"), false);
});

test("legacy sent receipts expose full text without rewriting archives or cutting off known persona history", async t => {
  const f = await fixture(t);
  await f.memory.saveSessionMeta("shared", { context: { history_scope: "persona" } });
  await f.web("已知人格历史暗号");
  const text = "旧已送达正文开头。" + "超过经历预览长度的完整内容。".repeat(100) + "旧正文尾部。";
  const receipt = await appendLegacySent(f, text);
  await f.memory.appendEvent(receipt);
  const archived = await f.memory.readSession("shared");
  assert.equal(archived.some(row => row.type === "message" && row.text === text), false);
  const visible = (await f.engine.contextRows("shared")).filter(row => row.type === "message" && row.text === text);
  assert.equal(visible.length, 1); assert.equal(visible[0].role, "assistant");
  assert.equal(visible[0].persona_revision, undefined, "old receipts cannot establish a persona version");
  assert.deepEqual(await f.memory.readSession("shared"), archived, "compatibility projection is read-only");
  await f.web();
  assert.match(requestText(f.requests.at(-1)!), /已知人格历史暗号/);
  assert.equal(requestText(f.requests.at(-1)!).includes(text), false);
  await f.memory.saveSessionMeta("shared", { context: { history_scope: "session" } });
  await f.restart();
  await f.web();
  assert.ok(f.requests.at(-1)!.some(row => row.role === "assistant" && row.content.includes(text)));
  assert.equal(requestText(f.requests.at(-1)!).split(text).length - 1, 1);
  assert.equal(f.sends.length, 0);
});

for (const written of [false, true]) test(`a ${written ? "post-append" : "pre-append"} history failure cannot turn confirmed transport into a resend`, async t => {
  const f = await fixture(t), append = f.memory.appendEvent.bind(f.memory);
  let injected = 0;
  f.memory.appendEvent = async (...args: Parameters<Memory["appendEvent"]>) => {
    const [row] = args;
    if (row.type === "message" && row.role === "assistant" && row.text === outgoing().text && injected++ === 0) {
      if (written) await append(...args);
      throw Error("synthetic history storage failure");
    }
    return append(...args);
  };
  const result = await f.handle.send(outgoing());
  assert.equal(injected, 1, "inject the failure into the confirmed history write");
  assert.equal(result.status, "sent");
  assert.ok(f.warnings.length > 0);
  assert.equal((await delivered(f.memory)).length, written ? 1 : 0);
  f.memory.appendEvent = append;
  assert.equal((await f.handle.send(outgoing())).status, "sent");
  assert.equal((await f.handle.retry("friend", "action-one", { direction: "out" })).status, "sent");
  await f.restart();
  assert.equal((await f.handle.send(outgoing())).status, "sent");
  assert.equal(f.sends.length, 1);
  const rows = await delivered(f.memory);
  assert.ok(rows.length <= 1, "projection repair, if supported, must be idempotent");
  if (written) assert.equal(rows.length, 1);
});

test("a confirmed transport survives failed sent-receipt commit without allowing a later resend", async t => {
  const f = await fixture(t), mutate = f.memory.channelRoute.bind(f.memory);
  let injected = false;
  f.memory.channelRoute = ((key: string, transaction: any) => mutate(key, async (route: any, entries: any) => {
    const next = await transaction(route, entries);
    if (!injected && next.route && Object.values(next.route.receipts).some((value: any) => value.receipt.status === "sent")) {
      injected = true;
      throw Error("synthetic receipt commit failure");
    }
    return next;
  })) as typeof f.memory.channelRoute;
  const result = await f.handle.send(outgoing());
  assert.equal(injected, true); assert.equal(result.status, "sent");
  assert.match(result.error!, /回执保存失败/);
  assert.equal((await delivered(f.memory)).length, 1, "the adapter's actual confirmation still establishes history");
  f.memory.channelRoute = mutate;
  await f.restart();
  assert.equal((await f.handle.send(outgoing())).status, "uncertain");
  await assert.rejects(() => f.handle.retry("friend", "action-one", { direction: "out" }), /不能重放/);
  assert.equal(f.sends.length, 1); assert.equal((await delivered(f.memory)).length, 1);
});

test("a real send inside a technical transient turn remains history without retaining temporary input or output", { timeout: 5000 }, async t => {
  const f = await fixture(t), text = "技术任务中实际发给用户的正文";
  const trigger = "本轮临时技术触发文本", temporary = "临时工具原始材料", final = "本轮临时结论";
  f.services.tools.entries.set("send_probe", { transientResult: true, origin: { plugin: "adapter", action: "工具调用" } });
  f.services.tools.call = async () => {
    assert.equal((await f.handle.send(outgoing(text))).status, "sent");
    return { ok: true, result: temporary };
  };
  let models = 0;
  f.setModel(() => ++models === 1
    ? { text: "", toolCalls: [{ id: "send-call", name: "send_probe", arguments: "{}" }] }
    : answer(final));
  await f.sessions.chat("shared", trigger, () => {}, undefined, undefined,
    { channel: "plugin", account: "adapter", peer: "shared", persona: "b", permission: "full", origin: { plugin: "adapter" } }, true);
  assert.equal(models, 2); assert.equal(f.sends.length, 1);
  const sent = (await delivered(f.memory))[0];
  assert.equal(sent?.text, text);
  assert.equal(sent.persona_id, "b", "a tool's actual calling persona takes priority over the adapter default");
  assert.equal(sent.persona_revision, (await persona(f.root, f.config, "b")).revision);
  const archived = JSON.stringify(await f.memory.readSession("shared"));
  for (const secret of [trigger, temporary, final]) assert.equal(archived.includes(secret), false);
  f.setModel(() => answer());
  await f.web();
  assert.ok(requestText(f.requests.at(-1)!).includes(text));
  for (const secret of [trigger, temporary, final]) assert.equal(requestText(f.requests.at(-1)!).includes(secret), false);
  assert.equal(f.sessions.locks.size, 0); assert.equal(f.sessions.channelOperations.size, 0);
});

test("legacy transient sent receipts cannot be promoted into ordinary assistant history", async t => {
  const f = await fixture(t), secret = "旧临时正文禁止回填";
  f.setTransport(async () => { throw Error("synthetic old receipt fixture"); });
  await f.handle.send(outgoing(secret));
  await replaceReceipt(f, { status: "sent", transient: true, text: undefined, error: undefined });
  await f.restart();
  const result = await f.handle.send(outgoing(secret));
  assert.equal(result.status, "sent"); assert.equal(result.transient, true); assert.equal(result.duplicate, true);
  assert.equal((await f.handle.retry("friend", "action-one", { direction: "out" })).duplicate, true);
  assert.equal((await messages(f.memory)).length, 0); assert.equal(f.sends.length, 1);
  await f.web();
  assert.equal(requestText(f.requests.at(-1)!).includes(secret), false);
});

test("short summaries cannot cover newly projected outgoing text without matching outgoing IDs", async () => {
  const first = { id: "first", role: "user", text: "原有开头" };
  const last = { id: "last", role: "assistant", text: "原有结尾" };
  const tail = { id: "tail", role: "user", text: "未覆盖的新输入" };
  const sent = { id: "sent-one", role: "assistant", text: "旧摘要未见的实际出站正文", delivery_id: "delivery-one" };
  let saved: any = { mode: "short", start_id: first.id, last_id: last.id, covered: 2, text: "原有有效摘要" };
  const engine = { summaryState: async () => saved };
  const original = await shortContext(engine, "shared", "summary", [first, last, tail]);
  assert.equal(original.text, saved.text);
  assert.deepEqual(original.remaining, [tail], "ordinary old checkpoints remain valid");
  const rows = [first, sent, last, tail];
  const invalid = await shortContext(engine, "shared", "summary", rows);
  assert.equal(invalid.text, "");
  assert.deepEqual(invalid.remaining, rows, "matching start/last IDs cannot hide an unaccounted outgoing message");
  saved = { ...saved, covered: 3, text: "已包含出站正文的新摘要", outgoing_ids: [sent.id] };
  const refreshed = await shortContext(engine, "shared", "summary", rows);
  assert.equal(refreshed.text, saved.text);
  assert.deepEqual(refreshed.remaining, [tail]);
});

test("legacy receipts without plugin origin replace their experience preview and remain excluded from persona recall", async t => {
  const f = await fixture(t), query = "远洋鲸歌";
  const receipt = await appendLegacySent(f, query + "：这是当时实际发送的完整正文。".repeat(50));
  const preview = await f.engine.experience("shared", "channel:adapter", {
    event_id: receipt.delivery_id, outcome: "succeeded", text: query + "：已通过 mock 发送的旧经历预览。",
    origin: { plugin: "adapter", channel: "mock", platform: "星港交流", action: "发送消息" },
  });
  const candidates = (await f.engine.inspect("shared")).items;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, "assistant"); assert.notEqual(candidates[0].id, preview.id);
  const recalled = await f.engine.search("shared", query, { manual: true, budget: 4000, persistTrace: false });
  assert.equal(recalled.items.length, 1); assert.equal(recalled.items[0].id, candidates[0].id);
  assert.ok((await f.engine.state("shared")).records.some(row => row.id === preview.id), "the old experience remains archived");
  const revision = (await persona(f.root, f.config, "a")).revision;
  const scoped = await f.engine.search("shared", query, { manual: true, revision, persistTrace: false });
  assert.deepEqual(scoped.items, [], "neither unknown-persona full text nor its old preview may bypass persona scope");
});
