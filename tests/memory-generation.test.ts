import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.ts";
import { Memory } from "../core/memory.ts";
import { MemoryEngine, estimateTokens } from "../core/memory-engine.ts";
import { LLM } from "../core/llm.ts";
import { compressShort, consolidateLong } from "../core/memory-lifecycle.ts";
import { contextPolicy } from "../core/session-context.ts";

type Mode = "short" | "long";
async function fixture(t: TestContext, mode: Mode) {
  const root = await temporaryDirectory("whale-memory-generation-");
  const logs: any[] = [], requests: any[] = [];
  const logger: any = Object.fromEntries(["info", "warn", "error"].map(level => [level,
    (message: string, data: any) => logs.push({ level, message, ...data })]));
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  const engine = new MemoryEngine(memory);
  for (let i = 0; i < 12; i++) await memory.appendEvent({
    session: "one", type: "message", role: "user", text: `记录${i}：` + "待整理的测试材料。".repeat(25),
    ts: new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  const rows = await memory.readSession("one");
  const reply = { text: JSON.stringify({ summary: "已确认的简短摘要。", ...(mode === "long" ? { cognition: [], reviews: [] } : {}) }),
    finish: "stop", reasoning: "PRIVATE_THINKING", output: 120, separateUsage: mode === "short" };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const usage = { prompt_tokens: 77, completion_tokens: reply.output,
      completion_tokens_details: { reasoning_tokens: 30 } };
    const frames: any[] = [
      { choices: [{ delta: { reasoning_content: reply.reasoning }, finish_reason: null }] },
      { choices: [{ delta: { content: reply.text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: reply.finish }], ...(reply.separateUsage ? {} : { usage }) },
      ...(reply.separateUsage ? [{ choices: [], usage }] : []),
    ];
    const wire = Buffer.from(frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let i = 0; i < wire.length; i += 19) res.write(wire.subarray(i, i + 19));
    res.end();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await memory.queue;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider: any = { model: "deepseek-flash", base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    parameters: { thinking: { type: "enabled" }, reasoning_effort: "max", max_tokens: 99 } };
  const llm = new LLM(logger), services = { memory, memoryEngine: engine, llm, logger };
  const key = mode === "short" ? "s_test" : "p_test";
  const run = async (limit = 200000) => {
    const base = { services, id: "one", key, provider, rows, limit };
    if (mode === "short") return compressShort({ ...base, overflow: rows, checkpoint: await engine.summaryState("one", key) });
    return consolidateLong({ ...base, policy: contextPolicy({ short_term_min_messages: 1, short_term_days: 7 }), revision: "test" });
  };
  const logText = () => JSON.stringify(logs, (_key, value) => value instanceof Error ? value.message : value);
  return { provider, engine, memory, rows, llm, key, run, reply, requests, logText };
}

for (const mode of ["short", "long"] as const) {
  test(`${mode} memory HTTP request isolates thinking policy, budget, accounting and stored content`, async t => {
    const f = await fixture(t, mode), original = structuredClone(f.provider);
    await f.run();
    const body = f.requests[0], cap = mode === "short" ? 1024 : 4096;
    assert.equal(body.max_tokens, cap);
    assert.equal(body.thinking.type, mode === "short" ? "disabled" : "enabled");
    assert.equal(body.reasoning_effort, mode === "short" ? undefined : "low");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(f.provider, original);
    const state = await f.engine.state("one"), summary = await f.engine.summaryState("one", f.key);
    assert.equal(summary.text, "已确认的简短摘要。");
    assert.ok(summary.covered > 0);
    assert.equal(state.daily.reserved, estimateTokens(JSON.stringify(body.messages)) + cap);
    assert.equal(state.usage.memory.input_tokens, 77);
    assert.equal(state.usage.memory.output_tokens, 120);
    assert.equal(state.usage.memory.requests, 1);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_THINKING/);
    assert.doesNotMatch(f.logText(), /PRIVATE_THINKING/);
    assert.deepEqual(await f.memory.readSession("one"), f.rows);
    await f.llm.chat({ provider: f.provider, messages: [{ role: "user", content: "普通请求" }] });
    assert.equal(f.requests[1].max_tokens, 99);
    assert.equal(f.requests[1].thinking.type, "enabled");
    assert.equal(f.requests[1].reasoning_effort, "max");
    assert.equal(f.requests[1].response_format, undefined);
  });

  for (const failure of ["truncated", "valid-but-truncated", "invalid-json", "filtered"] as const)
    test(`${mode} ${failure} preserves source and cursor, records usage and backs off without retrying`, async t => {
      const f = await fixture(t, mode);
      if (failure === "truncated") f.reply.text = '{"summary":"PRIVATE_PARTIAL';
      if (failure.includes("truncated")) f.reply.finish = "length";
      if (failure === "invalid-json") f.reply.text = '{"summary":PRIVATE_INVALID}';
      if (failure === "filtered") f.reply.finish = "content_filter";
      f.reply.output = mode === "short" ? 1024 : 4096;
      await f.run();
      const saved = await f.engine.summaryState("one", f.key), state = await f.engine.state("one");
      assert.equal(saved.covered, 0);
      assert.equal(saved.last_id, undefined);
      assert.equal(saved.text, undefined);
      assert.ok(saved.retry_at! > Date.now());
      assert.equal(state.records.length, 0);
      assert.equal(state.usage.memory.requests, 1);
      assert.equal(state.usage.memory.output_tokens, f.reply.output);
      assert.deepEqual(await f.memory.readSession("one"), f.rows);
      assert.match(f.logText(), failure.includes("truncated") ? /token 上限而被截断/ : failure === "invalid-json" ? /完整有效的 JSON/ : /未正常完成/);
      assert.doesNotMatch(f.logText(), /PRIVATE_PARTIAL|PRIVATE_INVALID|PRIVATE_THINKING/);
      await f.run();
      assert.equal(f.requests.length, 1);
    });

  test(`${mode} enlarged output reservation still obeys context and daily limits`, async t => {
    const f = await fixture(t, mode);
    await f.run(mode === "short" ? 1024 : 4096);
    assert.equal(f.requests.length, 0);
    const settings = (await f.engine.state("one")).settings;
    await f.engine.settings("one", { ...settings, daily_memory_tokens: 500 }, []);
    await f.run();
    assert.equal(f.requests.length, 0);
    assert.equal((await f.engine.state("one")).daily.reserved, 0);
    assert.deepEqual(await f.engine.summaryState("one", f.key), { covered: 0 });
  });
}

test("unrecognized model protocol keeps its own controls and does not receive DeepSeek fields", async t => {
  const f = await fixture(t, "short");
  f.provider.model = "other-model";
  f.provider.parameters = { temperature: 0.2 };
  await f.run();
  assert.equal(f.requests[0].max_tokens, 1024);
  assert.equal(f.requests[0].temperature, 0.2);
  assert.equal(f.requests[0].thinking, undefined);
  assert.equal(f.requests[0].reasoning_effort, undefined);
  assert.equal(f.requests[0].response_format, undefined);
});

test("unknown finish labels are sanitized before logging or returning to a plugin", async t => {
  const f = await fixture(t, "short");
  f.reply.finish = "PRIVATE_PROVIDER_FINISH";
  const result = await f.llm.chat({ provider: f.provider, messages: [{ role: "user", content: "test" }] });
  assert.equal(result.finish_reason, "unknown");
  assert.doesNotMatch(f.logText(), /PRIVATE_PROVIDER_FINISH/);
});
