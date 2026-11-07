import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { temporaryDirectory } from "./temporary-directory.ts";
import { TRANSIENT_REPLY } from "../core/tool-retention.ts";
import { compressShort, consolidateLong } from "../core/memory-lifecycle.ts";
import { contextPolicy } from "../core/session-context.ts";

const foreign = "SYNTHETIC_FOREIGN_TEXT_DO_NOT_KEEP";
const media = "SYNTHETIC_FOREIGN_IMAGE_DESCRIPTION";
async function diskText(root: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    text += entry.isDirectory() ? await diskText(path) : await readFile(path, "utf8");
  }
  return text;
}
async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-transient-tools-");
  let app: any;
  t.after(async () => { await app?.close(); });
  await mkdir(join(root, "config"));
  await mkdir(join(root, "plugins/probe"), { recursive: true });
  await writeFile(join(root, "plugins/probe/plugin.yaml"), 'id: probe\nname: Temporary tools\nversion: 1.0.0\ndescription: Isolated contract fixture\napiVersion: "1"\n');
  await writeFile(join(root, "plugins/probe/index.ts"), `export function apply(ctx) {
    const foreign = ${JSON.stringify(foreign)}, media = ${JSON.stringify(media)};
    let waiting = false;
    ctx.tools.registerTransient({ name: 'temporary_read', description: 'Temporary external material', schema: { mode: { type: 'string' } }, danger: 'safe',
      async run(args, session) {
        if (args.mode === 'throw') throw Error(foreign);
        if (args.mode === 'wait') { waiting = true; await new Promise((resolve) => session.signal.addEventListener('abort', resolve, { once: true })); }
        if (args.mode === 'invalid') return { content: foreign };
        if (args.mode === 'binary') return { content: foreign, receipt: new Uint8Array([1, 2]) };
        if (args.mode === 'oversize') return { content: foreign, receipt: 'x'.repeat(70000) };
        return { content: { text: foreign, image: { description: media, bytes: [1, 2, 3] } }, receipt: args.mode === 'null' ? null : { action: 'read', count: 1 } };
      } });
    ctx.tools.registerTransient({ name: 'temporary_action', description: 'Confirmed own action', schema: { text: { type: 'string' } }, danger: 'safe',
      async run(args, session) {
        await ctx.memory.recordExperience(session.id, { event_id: 'actual-receipt-17', outcome: 'succeeded',
          text: '已发表自己的评论，平台回执 actual-receipt-17。', origin: { platform: '测试平台', action: '发表评论' } });
        return { content: 'done', receipt: { status: 'sent', id: 'actual-receipt-17', ownText: '自己的评论' } };
      } });
    ctx.tools.register({ name: 'ordinary_echo', description: 'Legacy echo', schema: { text: { type: 'string' } }, danger: 'safe', run: args => args });
    ctx.provide('probe', {
      supported: () => typeof ctx.tools.registerTransient === 'function',
      waiting: () => waiting,
      call: (name, args, id) => ctx.tools.call(name, args, { id, permission: 'full' }),
      run: input => ctx.sessions.run(input),
      async transient(input) {
        let streamed = '';
        const text = await ctx.sessions.enqueueTransient({ ...input, onChunk: text => { streamed += text; } });
        return { text, streamed };
      },
    });
  }`);
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "info" }, web: { port: 0 },
    providers: [{ id: "test", base_url: "https://unused.invalid/v1", api_key: "synthetic" }],
    models: [{ id: "chat", provider: "test", model: "test", type: "chat", enabled: true, context_window: 32000 }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "A", file: "a.md", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  const id = await app.sessions.current();
  const requests: any[] = [], events: any[] = [];
  app.runtime.events.on("tool/called", (event: any) => events.push(event));
  const model = (fn: (request: any) => any) => { app.llm.chat = async (request: any) => {
    requests.push(JSON.parse(JSON.stringify(request)));
    const result = fn(request);
    if (result.text) request.onChunk?.(result.text);
    return { usage: { prompt_tokens: 20, completion_tokens: 4 }, ...result };
  }; };
  model(() => ({ text: "normal reply", toolCalls: [] }));
  const clean = async () => {
    for (const dir of ["memory", "logs"]) {
      const text = await diskText(join(root, dir));
      assert.ok(!text.includes(foreign), `${dir} must not retain temporary text`);
      assert.ok(!text.includes(media), `${dir} must not retain image descriptions`);
    }
  };
  return { root, id, get app() { return app; }, api: () => app.runtime.services.get("probe").value,
    requests, events, model, clean, restart: async () => { await app.close(); app = await boot(root); } };
}
const call = (name: string, args: any = {}, id = name) => ({ id, name, arguments: JSON.stringify(args) });

test("isolated transient tools expose content only to this round; receipts, usage and old user history survive", async t => {
  const f = await fixture(t);
  assert.equal(await f.api().supported(), true);
  await f.api().run({ text: "原来的用户交流" });
  f.requests.length = 0;
  let round = 0;
  f.model(() => ++round === 1 ? { text: "", toolCalls: [call("temporary_read")] }
    : round === 2 ? { text: "", toolCalls: [
      call("ordinary_echo", { text: foreign }), call(foreign), call("recall_memory", { query: foreign }),
      call("temporary_action", { text: "自己的评论" }), call("remember_fact", { text: foreign }),
    ] } : { text: foreign + media, toolCalls: [] });
  const reply = await f.api().transient({ text: "检查外部资料" });
  assert.equal(reply.text, foreign + media);
  assert.equal(reply.streamed, foreign + media);
  await f.app.runtime.events.drain();
  assert.match(JSON.stringify(f.requests[1]), new RegExp(foreign));
  assert.match(JSON.stringify(f.requests[1]), new RegExp(media));
  assert.ok(!JSON.stringify(f.events).includes(foreign));
  assert.deepEqual(f.events.find(e => e.name === "temporary_action").result, { status: "sent", id: "actual-receipt-17", ownText: "自己的评论" });
  const rows = await f.app.memory.readSession(f.id), state = await f.app.memoryEngine.state(f.id);
  assert.ok(rows.some((r: any) => r.text === "原来的用户交流"));
  assert.equal(rows.at(-1).text, TRANSIENT_REPLY);
  assert.equal(rows.at(-1).transient, true);
  assert.ok(rows.filter((r: any) => r.type === "tool").every((r: any) => r.args === undefined));
  assert.ok(JSON.stringify(state.records).includes("actual-receipt-17"));
  assert.equal((await f.app.memoryEngine.localFacts(f.id)).text, "");
  assert.equal(state.usage.chat.requests, 4);
  assert.equal((await f.app.sessions.contextStatus(f.id, { persona: "a" })).usage.used_tokens, 24);
  await f.clean();
  f.model(() => ({ text: "下一轮", toolCalls: [] }));
  await f.api().run({ text: "自己的评论" });
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes(foreign));
  assert.ok(JSON.stringify(f.requests.at(-1)).includes("actual-receipt-17"));
  await f.restart();
  await f.clean();
  assert.equal((await f.app.memory.readSession(f.id)).at(-1).text, "下一轮");
});

test("ordinary results keep their old shape and persistence; transient direct calls use sanitized observation", async t => {
  const f = await fixture(t);
  const old = { content: "ordinary", receipt: { preserved: true } };
  assert.deepEqual(await f.api().call("ordinary_echo", old, f.id), { ok: true, result: old });
  assert.deepEqual(f.events.at(-1).result, old);
  assert.equal(f.events.at(-1).transient, undefined);
  const result = await f.api().call("temporary_read", { mode: "null" }, f.id);
  await f.app.runtime.events.drain();
  assert.equal(result.result.text, foreign);
  assert.equal(f.events.at(-1).result, null);
  const records = (await f.app.memoryEngine.state(f.id)).records;
  assert.ok(JSON.stringify(records).includes("ordinary"));
  assert.ok(!records.some((r: any) => r.text.includes("temporary_read")), "null receipt does not invent an experience");
  assert.deepEqual(await f.api().call("ordinary_echo", old, f.id), { ok: true, result: old });
  await f.app.runtime.events.drain();
  assert.equal(f.events.at(-1).transient, undefined, "a direct temporary call cannot taint unrelated later calls");
  await f.clean();
});

test("normal dialogue keeps its question across restart; explicit outcomes survive and tool internals never become recall", async t => {
  const f = await fixture(t), reply = "已发表自己的评论。还要继续查看吗？";
  f.model(request => request.messages.some((m: any) => m.role === "tool")
    ? { text: reply, toolCalls: [] } : { text: "", toolCalls: [call("temporary_read"), call("temporary_action")] });
  assert.equal(await f.api().run({ text: "帮我查看并评论" }), reply);
  const row = (await f.app.memory.readSession(f.id)).at(-1);
  assert.equal(row.text, reply);
  assert.equal(row.transient, undefined);
  const listed = await f.app.memoryEngine.inspect(f.id);
  assert.ok(listed.items.some((r: any) => r.text.includes("平台回执 actual-receipt-17")), "explicit confirmed experience remains");
  assert.ok(!listed.items.some((r: any) => r.text.startsWith("工具 ")), "automatic execution traces are not everyday memory");
  await f.clean();
  await f.restart();
  f.model(request => {
    assert.ok(request.messages.some((m: any) => m.role === "assistant" && m.content?.includes(reply)), "可以 must retain the preceding question");
    assert.ok(!JSON.stringify(request.messages).includes(foreign));
    assert.ok(!JSON.stringify(request.messages).includes("工具 temporary_read 调用完成"));
    return { text: "按刚才说的继续查看。", toolCalls: [] };
  });
  assert.equal(await f.api().run({ text: "可以" }), "按刚才说的继续查看。");
  await f.clean();
});

test("material actually quoted in a user-facing reply is conversation; unquoted tool material stays temporary", async t => {
  const f = await fixture(t), visible = "对你说的引用：SYNTHETIC_VISIBLE_QUOTE。要继续吗？";
  f.model(request => request.messages.some((m: any) => m.role === "tool")
    ? { text: visible, toolCalls: [] } : { text: "", toolCalls: [call("temporary_read")] });
  await f.api().run({ text: "说给我听" });
  assert.equal((await f.app.memory.readSession(f.id)).at(-1).text, visible);
  assert.ok((await f.app.memoryEngine.search(f.id, "SYNTHETIC_VISIBLE_QUOTE", { manual: true })).items.some((r: any) => r.text === visible));
  await f.clean();
});

test("legacy tool projections are excluded only with matching archived evidence; explicit business records remain", async t => {
  const f = await fixture(t), marker = "LEGACY_EXECUTION_PARAMETER", origin = { plugin: "probe", platform: "测试平台", action: "工作查询" };
  const result = { cursor: marker }, text = "工具 legacy_work 调用完成：" + JSON.stringify(result);
  await f.app.memory.appendEvent({ session: f.id, type: "tool", name: "legacy_work", origin, ok: true, result });
  const legacy = await f.app.memoryEngine.experience(f.id, "probe", { event_id: "legacy", outcome: "succeeded", origin, text });
  await f.app.memoryEngine.update(f.id, (state: any) => { delete state.records.find((r: any) => r.id === legacy.id).tool_trace; });
  await f.app.memoryEngine.experience(f.id, "probe", { event_id: "explicit", outcome: "succeeded", origin,
    text: "已完成检查并确认成功。" });
  const explicit = await f.app.memoryEngine.experience(f.id, "probe", { event_id: "explicit-same-format", outcome: "succeeded", origin, text });
  const found = await f.app.memoryEngine.search(f.id, marker, { manual: true });
  assert.deepEqual(found.items.map((r: any) => r.id), [explicit.id], "new explicitly recorded experiences must not be guessed from their wording");
  assert.ok((await f.app.memoryEngine.state(f.id)).records.some((r: any) => r.id === legacy.id), "audit is preserved, not deleted");
  assert.ok((await f.app.memoryEngine.inspect(f.id)).items.some((r: any) => r.text === "已完成检查并确认成功。"));
  await f.clean();
});

test("old temporary placeholders remain in the audit archive but are not conversation or recall", async t => {
  const f = await fixture(t);
  await f.app.memory.appendEvent({ session: f.id, type: "message", role: "assistant", text: TRANSIENT_REPLY, transient: true });
  await f.app.memory.appendEvent({ session: f.id, type: "message", role: "user", text: TRANSIENT_REPLY });
  const raw = await f.app.memory.readSession(f.id);
  assert.equal(raw.length, 2, "do not rewrite old files");
  const active = await f.app.memoryEngine.contextRows(f.id);
  assert.equal(active.length, 1);
  assert.equal(active[0].role, "user", "a user's actual quote must not be guessed away");
  assert.ok((await f.app.memoryEngine.inspect(f.id)).items.every((r: any) => r.source !== "assistant"));
});

test("invalid projections and worker exceptions cannot leak content into logs or durable errors", async t => {
  const f = await fixture(t);
  for (const mode of ["invalid", "binary", "oversize"]) {
    const malformed = await f.api().call("temporary_read", { mode }, f.id);
    assert.equal(malformed.ok, false);
    assert.ok(!JSON.stringify(malformed).includes(foreign));
  }
  try { await f.api().call("temporary_read", { mode: "throw" }, f.id); } catch { /* worker fault can close its caller */ }
  await new Promise<void>(resolve => setTimeout(resolve, 80));
  await f.clean();
});

test("cancellation drops temporary bodies but preserves a confirmed receipt without continuing the model", async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  f.app.tools.registerTransient({ name: "cancel_after_action", schema: {}, danger: "safe", run() {
    abort.abort(Error("finished-real-action"));
    return { content: foreign, receipt: { status: "sent", id: "confirmed-before-cancel" } };
  } });
  f.model(() => ({ text: "", toolCalls: [call("cancel_after_action")] }));
  await assert.rejects(f.app.sessions.chat(f.id, "开始", () => {}, undefined, "a", { channel: "web", account: "local", peer: f.id, persona: "a", permission: "full", signal: abort.signal }), /finished-real-action/);
  assert.equal(f.requests.length, 1);
  assert.ok(JSON.stringify(await f.app.memoryEngine.state(f.id)).includes("confirmed-before-cancel"));
  await f.clean();
});

test("stopping an isolated temporary tool cancels its run and leaves no resumable body", async t => {
  const f = await fixture(t);
  f.model(() => ({ text: "", toolCalls: [call("temporary_read", { mode: "wait" })] }));
  const pending = assert.rejects(f.api().run({ text: "临时检查" }), /停用|停止|关闭|失效/);
  const deadline = Date.now() + 3000;
  while (!await f.api().waiting()) {
    assert.ok(Date.now() < deadline, "tool must start");
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  await f.app.runtime.action("probe", "stop");
  await pending;
  assert.equal(f.requests.length, 1);
  await f.app.sessions.close();
  await f.clean();
  await f.restart();
  await f.clean();
  assert.ok(!(await f.app.memory.readSession(f.id)).some((r: any) => r.role === "assistant"));
});

test("user-facing channel replies survive temporary tools, deduplication, explicit delivery retry and restart", async t => {
  const f = await fixture(t), sent: any[] = [];
  const replyText = "看完了，要继续吗？";
  let failOnce = true;
  const handle = f.app.channels.register({ id: "temporary", account: "test", persona: "a", permission: "full",
    async send(message: any) { sent.push(message); if (message.peer === "fail" && failOnce) { failOnce = false; throw Error(foreign); } } }, "test-owner");
  f.model(request => request.messages.some((m: any) => m.role === "tool")
    ? { text: replyText, toolCalls: [] } : { text: "", toolCalls: [call("temporary_read")] });
  const input = { peer: "ok", sender: "user", messageId: "1", text: "查看资料" };
  const result = await handle.receive(input);
  assert.equal(result.status, "sent");
  assert.equal(result.text, replyText);
  assert.equal(result.transient, undefined);
  assert.equal(sent[0].text, replyText);
  assert.equal(sent[0].transient, undefined);
  const duplicate = await handle.receive(input);
  assert.equal(duplicate.text, replyText);
  assert.equal(duplicate.duplicate, true);
  assert.equal(sent.length, 1);
  assert.equal((await handle.receive({ ...input, peer: "fail" })).status, "delivery_failed");
  const generated = f.requests.length;
  assert.equal((await handle.retry("fail", "1")).status, "sent");
  assert.equal(f.requests.length, generated, "explicit delivery retry must not rerun tools/model");
  assert.ok((await f.app.memory.readSession(result.sessionId)).some((r: any) => r.role === "assistant" && r.text === replyText));
  await f.clean();
  await f.restart();
  assert.ok((await f.app.memory.readSession(result.sessionId)).some((r: any) => r.role === "assistant" && r.text === replyText));
  await f.clean();
});

test("short and long memory consolidation only receives durable projections", async t => {
  const f = await fixture(t);
  f.model(request => request.messages.some((m: any) => m.role === "tool")
    ? { text: foreign, toolCalls: [] } : { text: "", toolCalls: [call("temporary_read")] });
  await f.api().transient({ text: "查看资料" });
  const rows = await f.app.memoryEngine.contextRows(f.id);
  for (const row of rows) row.ts = "2020-01-01T00:00:00Z";
  // Supply enough ordinary evidence to exercise both summarizers rather than a threshold no-op.
  for (let i = 0; i < 12; i++) rows.push({ id: `ordinary${i}`, type: "message", role: "user", text: "用户喜欢蓝莓。".repeat(40), ts: "2020-01-02T00:00:00Z" });
  f.requests.length = 0;
  f.model(request => ({ text: JSON.stringify({ summary: "用户喜欢蓝莓", ...(request.max_tokens === 4096 ? { cognition: [], reviews: [] } : {}) }), toolCalls: [] }));
  const options = { services: f.app, id: f.id, provider: {}, limit: 32000, timezone: "Asia/Shanghai", rows };
  await compressShort({ ...options, key: "s_test", overflow: rows.slice(0, 4), checkpoint: {} });
  await consolidateLong({ ...options, key: "p_test", policy: contextPolicy({ short_term_min_messages: 1, short_term_days: 1 }), revision: "test" });
  assert.equal(f.requests.length, 2);
  assert.ok(!JSON.stringify(f.requests).includes(foreign));
  await f.clean();
});
