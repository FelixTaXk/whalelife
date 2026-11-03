import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { boot } from "../core/index.ts";
import { compressShort, consolidateLong } from "../core/memory-lifecycle.ts";
import { contextPolicy } from "../core/session-context.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-transient-input-");
  let app: any;
  t.after(async () => { await app?.close(); });
  await mkdir(join(root, "config"));
  await mkdir(join(root, "plugins/input-probe"), { recursive: true });
  await writeFile(join(root, "plugins/input-probe/plugin.yaml"), 'id: input-probe\nname: Input probe\nversion: 1.0.0\ndescription: Isolated contract test\napiVersion: "1"\n');
  await writeFile(join(root, "plugins/input-probe/index.ts"), `export function apply(ctx) {
    let quiet;
    ctx.tools.register({ name: 'input_probe_record', description: 'Save a real decision', schema: { text: { type: 'string' } }, danger: 'safe',
      async run(args, session) {
        const result = await ctx.memory.recordExperience(session.id, { event_id: 'decision', outcome: 'succeeded', text: args.text,
          occurred_at: '2026-10-31T00:00:00+08:00', origin: { action: '判断完成' } });
        quiet?.abort(Error('explicit-decision-finished'));
        return result;
      } });
    ctx.provide('input-probe', {
      run: input => ctx.sessions.run(input),
      transient: input => ctx.sessions.runTransient(input),
      read: (id, limit, before) => ctx.memory.readSession(id, limit, before),
      exclude: (id, ids) => ctx.memory.excludeInputs(id, ids),
      async quiet(input) {
        quiet = new AbortController();
        try { return await ctx.sessions.runTransient({ ...input, signal: quiet.signal }); }
        catch (error) { return { cancelled: quiet.signal.aborted, error: error.message }; }
        finally { quiet = undefined; }
      },
    });
  }`);
  await writeFile(join(root, "a.md"), "你是人格甲，记住人格标记青柠。用简短中文回答。");
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "test", base_url: "https://unused.invalid/v1", api_key: "synthetic" }],
    models: [{ id: "chat", name: "Test", provider: "test", model: "test", type: "chat", enabled: true, context_window: 32000 }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "A", file: "a.md", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  const id = await app.sessions.current();
  const requests: any[] = [];
  const model = (reply: (input: any) => any) => { app.llm.chat = async (input: any) => {
    requests.push(JSON.parse(JSON.stringify(input)));
    return reply(input);
  }; };
  model(() => ({ text: "普通回答", toolCalls: [], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
  const api = () => app.runtime.services.get("input-probe").value;
  return { root, get app() { return app; }, id, api, model, requests,
    restart: async () => { await app.close(); app = await boot(root); },
  };
}

test("transient input survives tool rounds with persona/memory/usage, but never becomes a human message or recall trace", async t => {
  const f = await fixture(t), marker = "本轮技术标记3491";
  await f.app.memoryEngine.saveLocalFacts(f.id, "独立事实蓝莓");
  await f.api().run({ text: "之前的正常交流" });
  f.requests.length = 0;
  f.model(input => input.messages.some((x: any) => x.role === "tool")
    ? { text: "本次检查完成", toolCalls: [], usage: { prompt_tokens: 31, completion_tokens: 5 } }
    : { text: "", toolCalls: [{ id: "call1", name: "input_probe_record", arguments: JSON.stringify({ text: "已判断，暂不行动：暂无需要处理的事项。" }) }], usage: { prompt_tokens: 24, completion_tokens: 8 } });
  assert.equal(await f.api().transient({ text: marker, origin: { platform: "测试平台", action: "本轮检查" } }), "本次检查完成");
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.ok(request.messages.some((x: any) => x.role === "user" && x.content.includes(marker) && x.content.includes("不是真人发言")));
    assert.equal(request.messages.some((x: any) => x.role === "system" && x.content.includes(marker)), false);
    assert.match(JSON.stringify(request), /人格标记青柠/);
    assert.match(JSON.stringify(request), /独立事实蓝莓/);
    assert.match(JSON.stringify(request), /之前的正常交流/);
    assert.match(JSON.stringify(request), /测试平台/);
  }
  const rows = await f.app.memory.readSession(f.id), state = await f.app.memoryEngine.state(f.id);
  assert.equal(JSON.stringify(rows).includes(marker), false);
  assert.equal(JSON.stringify(state).includes(marker), false);
  assert.equal(rows.filter((x: any) => x.role === "user").length, 1);
  assert.ok(state.records.some((x: any) => x.text.includes("暂不行动") && x.origin.plugin === "input-probe" && x.occurred_at));
  assert.equal(state.usage.chat.requests, 3);
  assert.equal(state.usage.chat.input_tokens, 75);
  assert.equal((await f.app.sessions.contextStatus(f.id)).usage.used_tokens, 36);
  f.model(() => ({ text: "下一轮", toolCalls: [], usage: { prompt_tokens: 8, completion_tokens: 2 } }));
  await f.api().run({ text: "接着聊" });
  assert.equal(JSON.stringify(f.requests.at(-1)).includes(marker), false);
  const other = await f.app.sessions.create("其他会话");
  await f.api().transient({ sessionId: other, text: "另一个临时输入", permission: "off" });
  assert.equal(f.requests.at(-1).tools.length, 0);
  assert.equal(JSON.stringify(f.requests.at(-1)).includes("之前的正常交流"), false);
  assert.equal((await f.app.memory.readSession(other)).filter((x: any) => x.role === "user").length, 0);
});

test("plugin explicit-end cancellation keeps the real decision without persisting the trigger or inventing success text", async t => {
  const f = await fixture(t);
  f.model(() => ({ text: "", toolCalls: [{ id: "quiet", name: "input_probe_record", arguments: '{"text":"判断后决定暂不行动，原因是暂无待办。"}' }], usage: { prompt_tokens: 17, completion_tokens: 6 } }));
  const result = await f.api().quiet({ text: "技术控制信息quiet123" });
  assert.equal(result.cancelled, true);
  assert.match(result.error, /explicit-decision-finished/);
  const rows = await f.app.memory.readSession(f.id), state = await f.app.memoryEngine.state(f.id);
  assert.equal(rows.some((x: any) => x.type === "message"), false);
  assert.equal(JSON.stringify(rows).includes("quiet123"), false);
  assert.ok(state.records.some((x: any) => x.text === "判断后决定暂不行动，原因是暂无待办。"));
  assert.equal(state.usage.chat.requests, 1);
  assert.equal(f.app.sessions.locks.has(f.id), false);
});

test("transient calls preserve failure, context limits, cancellation and disabled-plugin behavior", async t => {
  const f = await fixture(t);
  f.model(() => { throw Error("synthetic model failure"); });
  await assert.rejects(f.api().transient({ text: "失败触发" }), /synthetic model failure/);
  assert.deepEqual(await f.app.memory.readSession(f.id), []);
  assert.equal((await f.app.memoryEngine.state(f.id)).records.length, 0);
  await assert.rejects(f.api().transient({ text: "" }), /请输入/);
  f.app.config.models[0].context_window = 1000;
  const count = f.requests.length;
  await assert.rejects(f.api().transient({ text: "甲".repeat(2000) }), /上下文预算/);
  assert.equal(f.requests.length, count);
  const old = f.api();
  await f.app.runtime.action("input-probe", "stop");
  await assert.rejects(async () => old.transient({ text: "停用后" }), /停用|停止|关闭|失效/);
});

test("exact owned input exclusions paginate, preserve original history and survive restart/backup", async t => {
  const f = await fixture(t), memory = f.app.memory;
  for (let i = 0; i < 105; i++) await memory.appendEvent({ session: f.id, id: `input_${i}`, type: "message", role: "user",
    channel: "plugin", account: "input-probe", origin: { plugin: "input-probe" }, text: `技术提示${i}` });
  await memory.appendEvent({ session: f.id, id: "human", type: "message", role: "user", channel: "web", text: "真实用户发言" });
  await memory.appendEvent({ session: f.id, id: "foreign", type: "message", role: "user", channel: "plugin", account: "other", origin: { plugin: "other" }, text: "别人的输入" });
  const original = await memory.readSession(f.id), latest = await f.api().read(f.id, 100);
  assert.equal(latest.length, 100);
  assert.equal((await f.api().read(f.id, 100, latest[0].id)).length, 7);
  await assert.rejects(f.api().exclude(f.id, ["input_0", "human"]), /只能排除/);
  assert.equal((await f.app.memoryEngine.contextRows(f.id)).length, original.length);
  await assert.rejects(f.api().exclude(f.id, ["foreign"]), /只能排除/);
  await assert.rejects(f.api().exclude(f.id, ["missing"]), /只能排除/);
  assert.deepEqual(await f.api().exclude(f.id, ["input_0", "input_104"]), { excluded: 2 });
  assert.deepEqual(await f.api().exclude(f.id, ["input_0"]), { excluded: 0 });
  assert.deepEqual(await memory.readSession(f.id), original);
  assert.equal((await f.app.memoryEngine.contextRows(f.id)).length, original.length - 2);
  assert.equal((await f.app.memoryEngine.inspect(f.id, "技术提示0", true)).items.some((x: any) => x.id === "input_0"), false);
  const backup = await f.app.memoryAdmin.backup();
  await f.api().exclude(f.id, ["input_1"]);
  await f.app.memoryAdmin.restore({ id: backup.id });
  assert.equal((await f.app.memoryEngine.contextRows(f.id)).length, original.length - 2);
  await f.restart();
  assert.equal((await f.app.memoryEngine.contextRows(f.id)).length, original.length - 2);
  const status = await f.app.sessions.contextStatus(f.id);
  assert.equal(status.stored_messages, original.length);
  assert.equal(status.available_messages, original.length - 2);
});

test("excluded inputs invalidate derived context, reject stale consolidation, and rebuild clean summaries", async t => {
  const f = await fixture(t), { memory, memoryEngine: engine } = f.app;
  const contaminated = "历史技术提示污染标记";
  await memory.appendEvent({ session: f.id, id: "trigger", type: "message", role: "user", text: contaminated,
    channel: "plugin", account: "input-probe", origin: { plugin: "input-probe" }, ts: "2020-01-01T00:00:00Z" });
  for (let i = 0; i < 12; i++) await memory.appendEvent({ session: f.id, id: `good${i}`, type: "message", role: "user",
    text: "用户喜欢蓝莓。".repeat(65), channel: "web", ts: "2020-01-02T00:00:00Z" });
  const key = "p_" + createHash("sha256").update(f.id + ":session").digest("hex").slice(0, 40);
  const stale = { covered: 13, last_id: "good11", last_offset: 0, text: contaminated, mode: "long" };
  await engine.commitSummary(f.id, key, stale, [{ text: contaminated, evidence: ["trigger"], uncertain: true }]);
  await memory.writeSummary(key, contaminated, f.id);
  await engine.summaryState(f.id, "s_" + key.slice(2), { ...stale, mode: "short", start_id: "trigger" });
  await engine.experience(f.id, "input-probe", { event_id: "actual", text: "已判断暂不行动，暂无需要处理的事项。", outcome: "succeeded" });
  const before = await memory.readSession(f.id);
  await f.api().exclude(f.id, ["trigger"]);
  assert.equal(await engine.readSummary(f.id, key), "");
  assert.equal((await engine.summaryState(f.id, "s_" + key.slice(2))).text, undefined);
  assert.equal((await engine.cognitionCandidates(f.id, contaminated)).length, 0);
  assert.ok((await engine.state(f.id)).records.some((x: any) => x.text === contaminated && x.context_excluded));
  assert.ok((await engine.inspect(f.id)).items.some((x: any) => x.text.includes("已判断暂不行动")));
  await assert.rejects(engine.commitSummary(f.id, key, stale), /来源范围已变更/);
  await engine.summaryState(f.id, key, { ...stale, retry_at: Date.now() });
  assert.equal(await engine.readSummary(f.id, key), "");
  const rows = await engine.contextRows(f.id);
  f.model(input => ({ text: JSON.stringify({ summary: "用户喜欢蓝莓", ...(input.max_tokens === 4096
    ? { cognition: [{ text: "用户喜欢蓝莓", evidence: ["good0"], uncertain: false }], reviews: [] } : {}) }),
    toolCalls: [], usage: { prompt_tokens: 15, completion_tokens: 5 } }));
  const options = { services: f.app, id: f.id, provider: {}, limit: 32000, timezone: "Asia/Shanghai" };
  await consolidateLong({ ...options, key, rows, policy: contextPolicy({ short_term_min_messages: 1, short_term_days: 1 }), revision: "test" });
  assert.equal(await engine.readSummary(f.id, key), "用户喜欢蓝莓");
  const sk = "s_" + key.slice(2);
  await compressShort({ ...options, key: sk, rows, overflow: rows.slice(0, 3), checkpoint: await engine.summaryState(f.id, sk) });
  assert.equal(await engine.readSummary(f.id, sk), "用户喜欢蓝莓");
  assert.equal(JSON.stringify(f.requests).includes(contaminated), false);
  assert.deepEqual(await memory.readSession(f.id), before);
  assert.ok((await engine.cognitionCandidates(f.id, "蓝莓")).length > 0);
  f.model(() => ({ text: "正常回答", toolCalls: [], usage: { prompt_tokens: 20, completion_tokens: 3 } }));
  await f.api().run({ text: "继续交流" });
  assert.equal(JSON.stringify(f.requests.at(-1)).includes(contaminated), false);
  assert.ok(f.requests.at(-1).messages.some((x: any) => x.role === "user" && x.content.includes("继续交流")));
});

test("migration refuses an active conversation instead of changing its in-flight context", async t => {
  const f = await fixture(t);
  await f.api().run({ text: "旧触发" });
  const id = (await f.app.memory.readSession(f.id)).find((x: any) => x.role === "user").id;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
  f.model(async () => { enter(); await gate; return { text: "完成", toolCalls: [] }; });
  const running = f.api().transient({ text: "在途" });
  await entered;
  try { await assert.rejects(f.api().exclude(f.id, [id]), /会话正在处理/); }
  finally { release(); await running; }
  assert.deepEqual(await f.api().exclude(f.id, [id]), { excluded: 1 });
});
