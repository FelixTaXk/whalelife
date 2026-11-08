/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { Sessions } from "../core/session.ts";
import { shortContext, shortSummaryKey, compressShort, shouldDeferShortToLong } from "../core/memory-lifecycle.ts";
import { contextPolicy } from "../core/session-context.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const longKey = "p_" + createHash("sha256").update("one:session").digest("hex").slice(0, 40);
const shortKey = shortSummaryKey(longKey);
const reply = (text: string) => ({ text, toolCalls: [], finish_reason: "stop",
  usage: { prompt_tokens: 100, completion_tokens: 30 } });

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-summary-recovery-");
  let sessions: Sessions | undefined;
  const logs: any[] = [], requests: any[] = [];
  const logger: any = Object.fromEntries(["info", "warn", "error"].map(level => [level,
    (message: string, data?: any) => logs.push({ level, message, ...data })]));
  const memory = new Memory(join(root, "memory"), logger);
  t.after(async () => { await sessions?.close(); await memory.queue; });
  await memory.init();
  await writeFile(join(root, "persona.md"), "你是简洁的测试助手。");
  const provider = { id: "test", protocol: "openai-compatible", model: "test-chat", base_url: "https://unused.invalid/v1" };
  const config: any = {
    providers: [provider],
    models: [{ id: "chat", provider: "test", model: "test-chat", type: "chat", enabled: true, context_window: 200000 }],
    model_bindings: { chat: "chat" },
    personas: { test: { name: "测试", file: "persona.md", provider: "test" } },
    channels: { web: { persona: "test", permission: "off" } },
    memory: { budget_tokens: 1400, short_term_days: 7, short_term_min_messages: 10 },
  };
  let shortOutput = JSON.stringify({ summary: "当前讨论室内活动，人数两人。" });
  let longOutput = JSON.stringify({ summary: "过去讨论过活动安排。", cognition: [], reviews: [] });
  const engine = new MemoryEngine(memory);
  const services: any = { memory, memoryEngine: engine, tools: { list: () => [] }, logger,
    llm: { chat: async (request: any) => {
      requests.push(structuredClone({ messages: request.messages, max_tokens: request.max_tokens }));
      return reply(request.max_tokens === 1024 ? shortOutput : request.max_tokens === 4096 ? longOutput : "收到。");
    } } };
  sessions = new Sessions(root, config, services);
  const seed = async (count: number, days = 0, repetitions = 100) => {
    for (let i = 0; i < count; i++) await memory.appendEvent({ session: "one", type: "message",
      role: i % 2 ? "assistant" : "user", text: `合成记录${days}-${i}：` + "活动资料。".repeat(repetitions),
      ts: new Date(Date.now() - days * 86400000).toISOString() });
    return engine.contextRows("one");
  };
  const compress = async (rows: any[], overflow = rows, key = shortKey) => {
    const current = await shortContext(engine, "one", key, rows);
    return compressShort({ services, id: "one", key, rows, overflow,
      checkpoint: current.checkpoint, provider, limit: 200000 });
  };
  const chat = async () => {
    const start = requests.length;
    await sessions!.chat("one", "继续", () => {});
    const calls = requests.slice(start).filter(x => x.max_tokens);
    assert.ok(calls.length <= 1, "one conversation may spend at most one maintenance request");
    return calls.map(x => x.max_tokens);
  };
  return { memory, engine, config, services, requests, logs, seed, compress, chat,
    short: (value: string) => { shortOutput = value; }, long: (value: string) => { longOutput = value; } };
}

test("window movement followed by failed rebuilding preserves the last successful summary without injecting it", async t => {
  const f = await fixture(t), rows = await f.seed(9);
  const saved = { covered: 3, last_id: rows[2].id, last_offset: 0, mode: "short", start_id: rows[0].id,
    text: "旧窗口有效的成功摘要。" };
  await f.engine.commitSummary("one", shortKey, saved);
  await f.memory.writeSummary(shortKey, saved.text, "one");
  const originals = await f.memory.readSession("one");
  f.short('{"summary":"PRIVATE_BROKEN');
  await f.compress(rows.slice(1));
  const failed = await f.engine.summaryState("one", shortKey);
  for (const key of ["text", "covered", "last_id", "last_offset", "start_id"])
    assert.equal(failed[key], (saved as any)[key], `failed rebuilding must retain successful ${key}`);
  assert.equal(failed.failure_count, 1);
  assert.ok(failed.retry_at > Date.now());
  assert.equal(failed.retry_start_id, rows[1].id);
  const current = await shortContext(f.engine, "one", shortKey, rows.slice(1));
  assert.equal(current.text, "", "an outdated window is not claimed as current context");
  assert.deepEqual(current.remaining, rows.slice(1));
  assert.deepEqual(await f.memory.readSession("one"), originals);
  assert.doesNotMatch(JSON.stringify(f.logs, (_key, x) => x instanceof Error ? x.message : x), /PRIVATE_BROKEN/);
});

test("moving the short window again does not bypass cooldown; consecutive failures back off", async t => {
  const f = await fixture(t), rows = await f.seed(9);
  f.short('{"summary":INVALID');
  await f.compress(rows.slice(1));
  const first = await f.engine.summaryState("one", shortKey);
  await f.compress(rows.slice(2));
  assert.equal(f.requests.length, 1, "a new start ID cannot force repeated paid requests during cooldown");
  await f.engine.summaryState("one", shortKey, { ...first, retry_at: 0 });
  await f.compress(rows.slice(2));
  const second = await f.engine.summaryState("one", shortKey);
  assert.equal(second.failure_count, 2);
  assert.ok(second.retry_at - Date.now() > 115000, "the second failure waits at least about two minutes");
  assert.equal(f.requests.length, 2);
});

test("rebuilding after excluded technical input retains the source revision and commits a new short summary", async t => {
  const f = await fixture(t);
  await f.memory.appendEvent({ session: "one", type: "message", role: "user", text: "PRIVATE_TECHNICAL_INPUT",
    channel: "plugin", account: "probe", origin: { plugin: "probe", action: "测试技术输入" } });
  const all = await f.seed(9), technical = all[0];
  await f.engine.plugin("probe", () => {}).excludeInputs("one", [technical.id]);
  const initial = await f.engine.summaryState("one", shortKey);
  assert.match(initial.input_revision, /^[a-f0-9]{64}$/);
  const rows = await f.engine.contextRows("one");
  assert.ok(rows.every(row => row.id !== technical.id));
  await f.compress(rows);
  const saved = await f.engine.summaryState("one", shortKey);
  assert.equal(saved.input_revision, initial.input_revision);
  assert.ok(saved.last_id && saved.covered > 0);
  assert.equal(saved.text, "当前讨论室内活动，人数两人。");
  assert.doesNotMatch(JSON.stringify(f.requests), /PRIVATE_TECHNICAL_INPUT/);
});

test("a complete overlong summary is shortened at a sentence boundary in the same single request", async t => {
  const f = await fixture(t), rows = await f.seed(9);
  const text = "已确认周六在室内碰面。" + "参与者还提到需要事先核实开放时间。".repeat(15);
  f.short(JSON.stringify({ summary: text }));
  await f.compress(rows);
  const saved = await f.engine.summaryState("one", shortKey);
  assert.ok(Array.from(saved.text).length <= 200);
  assert.ok(saved.text.startsWith("已确认周六在室内碰面。"));
  assert.ok(text.startsWith(saved.text), "normalization only drops a suffix, never invents prose");
  assert.match(saved.text, /。$/);
  assert.ok(saved.covered > 0);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.engine.state("one")).records.length, 0);
});

test("extra fields in short-summary JSON do not reject valid prose or become long-term cognition", async t => {
  const f = await fixture(t), rows = await f.seed(9);
  f.short(JSON.stringify({ summary: "用户决定周六继续讨论。",
    cognition: [{ text: "PRIVATE_EXTRA_COGNITION", evidence: [rows[0].id] }], notes: "PRIVATE_EXTRA_NOTES" }));
  await f.compress(rows);
  const state = await f.engine.state("one");
  assert.equal(state.summaries[shortKey].text, "用户决定周六继续讨论。");
  assert.equal(state.records.length, 0);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_EXTRA_COGNITION|PRIVATE_EXTRA_NOTES/);
  assert.equal(f.requests.length, 1);
});

test("constant short-term pressure and long-term backlog alternate maintenance across turns and a cold reopen", async t => {
  const f = await fixture(t);
  await f.seed(45, 30, 30); await f.seed(45, 0, 100);
  const rounds = [await f.chat(), await f.chat()];
  // Reconstructing the engine must not reset which kind received the previous opportunity.
  const recovered = new MemoryEngine(f.memory);
  f.services.memoryEngine = recovered;
  rounds.push(await f.chat(), await f.chat());
  assert.deepEqual(rounds, [[1024], [4096], [1024], [4096]]);
  const state = await recovered.state("one");
  assert.ok(state.summaries[longKey].covered > 0);
  assert.ok(state.summaries[shortKey].covered > 0);
});

test("a failed long-term attempt retains progress and does not prevent either kind from later receiving an opportunity", async t => {
  const f = await fixture(t);
  await f.seed(45, 30, 30); await f.seed(45, 0, 100);
  assert.deepEqual(await f.chat(), [1024]);
  f.long('{"summary":PRIVATE_INVALID_LONG');
  assert.deepEqual(await f.chat(), [4096]);
  const failed = await f.engine.summaryState("one", longKey);
  assert.equal(failed.covered, 0); assert.equal(failed.last_id, undefined);
  assert.ok(failed.retry_at > Date.now());
  await f.engine.summaryState("one", longKey, { ...failed, retry_at: 0 });
  f.long(JSON.stringify({ summary: "过去讨论过活动安排。", cognition: [], reviews: [] }));
  assert.deepEqual(await f.chat(), [1024]);
  assert.deepEqual(await f.chat(), [4096]);
  const recovered = await f.engine.summaryState("one", longKey);
  assert.ok(recovered.covered > 0);
  assert.equal(recovered.retry_at, undefined);
  assert.equal(recovered.last_error, undefined);
  assert.equal(recovered.failure_count ?? 0, 0);
  assert.doesNotMatch(JSON.stringify(f.logs, (_key, x) => x instanceof Error ? x.message : x), /PRIVATE_INVALID_LONG/);
});

test("long-term preflight failure does not block the chat or leak details, while cancellation still propagates", async t => {
  const f = await fixture(t);
  await f.seed(45, 30, 30); await f.seed(45, 0, 100);
  assert.deepEqual(await f.chat(), [1024]);
  const before = f.requests.length;
  f.engine.cognitionCandidates = async () => { throw Error("PRIVATE_CANDIDATE_STORAGE_ERROR"); };
  assert.deepEqual(await f.chat(), [1024]);
  assert.equal(f.requests.slice(before).filter(x => x.max_tokens === undefined).length, 1);
  assert.equal((await f.memory.readSession("one")).at(-1).text, "收到。");
  assert.equal((await f.engine.summaryState("one", longKey)).covered, 0);
  assert.ok(f.logs.some(x => x.message === "长期整理预检失败，继续当前对话"));
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_CANDIDATE_STORAGE_ERROR/);

  const controller = new AbortController();
  f.engine.cognitionCandidates = async () => { controller.abort(Error("test cancellation")); throw Error("PRIVATE_CANCELLED_READ"); };
  await assert.rejects(shouldDeferShortToLong({ services: f.services, id: "one", key: longKey,
    provider: f.config.providers[0], limit: 200000, signal: controller.signal,
    rows: await f.engine.contextRows("one"), policy: contextPolicy(f.config.memory), revision: "test" }), /test cancellation/);
});
