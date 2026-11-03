import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryEngine, validateMemoryState } from "../core/memory-engine.ts";
import { Sessions } from "../core/session.ts";
import { contextPolicy, memoryWindow, validateContext } from "../core/session-context.ts";
import { shortSummaryKey, shortContext, compressShort } from "../core/memory-lifecycle.ts";
import { createHash } from "node:crypto";

test("time and minimum retention must both be exceeded; message volume alone never ages memories", () => {
  const now = Date.parse("2026-10-29T00:00:00Z"), policy = contextPolicy({});
  const rows = (count: number, days: number) => Array.from({ length: count }, (_, i) => ({
    id: String(i), type: "message", text: "消息", ts: new Date(now - days * 86400000).toISOString(),
  }));
  assert.equal(memoryWindow(rows(20, 30), policy, now).short.length, 20);
  assert.equal(memoryWindow(rows(300, 0), policy, now).short.length, 300);
  assert.equal(memoryWindow(rows(110, 8), policy, now).long.length, 10);
  assert.equal(memoryWindow(rows(110, 7), policy, now).long.length, 0);
  const unknown = rows(110, 8); unknown[0].ts = "unknown";
  assert.equal(memoryWindow(unknown, policy, now).long.length, 0, "uncertain chronology must not skip a source cursor");
  assert.equal(contextPolicy({ recent_lines: 30 }).short_term_min_messages, 100);
  assert.equal(contextPolicy({ recent_lines: 0 }).history_enabled, false);
  const independent = validateContext({ ...policy, include_summary: false, long_term_enabled: true });
  assert.equal(independent.long_term_enabled, true);
  for (const patch of [{ short_term_days: 0 }, { short_term_min_messages: 0 }, { short_term_days: 1.5 }])
    assert.throws(() => validateContext({ ...policy, ...patch }));
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-memory-time-"));
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  await writeFile(join(root, "persona.md"), "你是简洁的测试助手。");
  const config: any = {
    providers: [{ id: "demo", protocol: "openai-compatible", model: "chat", base_url: "https://unused.example/v1" }],
    models: [{ id: "chat", provider: "demo", model: "chat", type: "chat", enabled: true, context_window: 200000 }],
    model_bindings: { chat: "chat" },
    personas: { a: { name: "A", file: "persona.md", provider: "demo" } },
    channels: { web: { persona: "a", permission: "off" } },
    memory: { budget_tokens: 6000 },
  };
  const engine = new MemoryEngine(memory), requests: any[] = [];
  const services: any = { memory, memoryEngine: engine, tools: {}, logger, llm: {
    chat: async (request: any) => {
      requests.push(request);
      if (request.max_tokens === 1024) return {
        text: JSON.stringify({ summary: "当前讨论旅行计划，用户希望简洁。" }), toolCalls: [],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      };
      if (request.max_tokens === 4096) {
        const input = JSON.parse(request.messages[1].content);
        return { text: JSON.stringify({ summary: "过去讨论过旅行。", cognition: [{
          text: "用户对旅行感兴趣。", evidence: [input.episodes[0].id], uncertain: true,
        }] }), toolCalls: [], usage: { prompt_tokens: 80, completion_tokens: 30 } };
      }
      return { text: "收到", toolCalls: [], usage: { prompt_tokens: 200, completion_tokens: 30 } };
    },
  } };
  const sessions = new Sessions(root, config, services);
  const seed = async (count: number, ageDays = 0, length = 8) => {
    for (let i = 0; i < count; i++) await memory.appendEvent({
      session: "one", type: "message", role: i % 2 ? "assistant" : "user",
      text: `旅行记录${i}：` + "内容".repeat(length),
      ts: new Date(Date.now() - ageDays * 86400000).toISOString(),
    });
  };
  t.after(async () => {
    await memory.queue;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, memory, engine, config, requests, services, sessions, seed };
}

test("sparse month-old chat stays short-term and needs no maintenance call", async (t) => {
  const f = await fixture(t);
  await f.seed(20, 30);
  await f.sessions.chat("one", "继续", () => {});
  assert.equal(f.requests.length, 1);
  assert.match(JSON.stringify(f.requests[0].messages), /旅行记录0：/);
  const status = await f.sessions.contextStatus("one");
  assert.equal(status.memory_window.short_term_messages, 22);
  assert.equal(status.memory_window.long_term_messages, 0);
  assert.equal((await f.engine.state("one")).records.length, 0);
});

test("300 fresh messages are not cut to 30 or classified long-term when budget permits", async (t) => {
  const f = await fixture(t);
  f.config.memory.budget_tokens = 100000;
  await f.seed(300);
  await f.sessions.chat("one", "继续", () => {});
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].messages.length, 302);
  assert.equal((await f.sessions.contextStatus("one")).memory_window.long_term_messages, 0);
});

test("pressure creates only a short summary, reuses it after restart, and never advances long-term cognition", async (t) => {
  const f = await fixture(t);
  f.config.memory.budget_tokens = 1400;
  await f.seed(12, 0, 100);
  const original = await f.memory.readSession("one");
  await f.sessions.chat("one", "继续计划", () => {});
  assert.deepEqual(f.requests.map((x) => x.max_tokens ?? "chat"), [1024, "chat"]);
  assert.match(f.requests[1].messages[0].content, /当前讨论旅行计划/);
  const rows = await f.memory.readSession("one"), longKey = rows.at(-1).summary_id;
  const state = await f.engine.state("one");
  assert.equal(state.records.length, 0);
  assert.equal(state.summaries[longKey], undefined);
  const short = await f.engine.summaryState("one", shortSummaryKey(longKey));
  assert.equal(short.mode, "short");
  assert.ok(Array.from(short.text).length <= 200);
  assert.deepEqual(rows.slice(0, original.length), original);
  assert.equal(state.usage.memory.input_tokens, 50);
  assert.equal(state.usage.chat.input_tokens, 200);
  assert.equal((await f.sessions.contextStatus("one")).usage.used_tokens, 230);
  const restarted = new Sessions(f.root, f.config, { ...f.services, memoryEngine: new MemoryEngine(f.memory) });
  await restarted.chat("one", "接着说", () => {});
  assert.equal(f.requests.filter((x) => x.max_tokens === 1024).length, 1);
  assert.match(f.requests.at(-1).messages[0].content, /当前讨论旅行计划/);
});

test("long-term extraction uses age plus count and runs independently of short-summary switch", async (t) => {
  const f = await fixture(t);
  f.config.memory.include_summary = false;
  f.config.memory.long_term_enabled = true;
  await f.seed(110, 30);
  await f.sessions.chat("one", "继续", () => {});
  assert.deepEqual(f.requests.map((x) => x.max_tokens ?? "chat"), ["chat", 4096]);
  const batch = JSON.parse(f.requests[1].messages[1].content).episodes;
  assert.equal(batch.length, 12, "110 old + 2 new, most recent 100 are protected");
  const state = await f.engine.state("one");
  assert.equal(Object.values(state.summaries)[0].mode, "long");
  assert.ok(state.records.every((x) => Array.from(x.text).length <= 80));
  assert.equal(state.records[0].format_version, 2);
  const corrupted = structuredClone(state);
  corrupted.records[0].text = "字".repeat(81);
  assert.throws(() => validateMemoryState(corrupted), /80/);
});

test("short compression takes this turn's single maintenance call even when long-term backlog exists", async (t) => {
  const f = await fixture(t);
  f.config.memory.budget_tokens = 1200;
  f.config.memory.short_term_min_messages = 10;
  await f.seed(15, 30);
  await f.seed(15, 0, 100);
  await f.sessions.chat("one", "继续", () => {});
  assert.deepEqual(f.requests.map((x) => x.max_tokens ?? "chat"), [1024, "chat"]);
  assert.equal((await f.engine.state("one")).records.length, 0);
  assert.equal((await f.sessions.contextStatus("one")).memory_window.long_term_messages, 15);
});

test("short cache is not injected after its covered range has moved into long-term history", async (t) => {
  const f = await fixture(t);
  f.config.memory.budget_tokens = 1400;
  await f.seed(12, 30, 100);
  await f.sessions.chat("one", "第一次", () => {});
  f.config.memory.short_term_min_messages = 2;
  f.config.memory.long_term_enabled = false;
  await f.sessions.chat("one", "改保底后", () => {});
  assert.doesNotMatch(f.requests.at(-1).messages[0].content, /当前讨论旅行计划/);
  assert.equal((await f.sessions.contextStatus("one")).memory_window.short_summary_chars, 0);
});

test("overlong short summary is rejected without promoting cognition or consuming an extra retry this turn", async (t) => {
  const f = await fixture(t);
  f.config.memory.budget_tokens = 1400;
  await f.seed(12, 0, 100);
  const normal = f.services.llm.chat;
  f.services.llm.chat = async (request: any) => request.max_tokens === 1024
    ? (f.requests.push(request), { text: JSON.stringify({ summary: "字".repeat(201) }), toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: 220 } })
    : normal(request);
  await f.sessions.chat("one", "继续", () => {});
  const state = await f.engine.state("one");
  assert.equal(state.records.length, 0);
  const saved = Object.values(state.summaries)[0];
  assert.equal(saved.text, undefined);
  assert.ok(saved.retry_at > Date.now());
  assert.equal(state.usage.memory.requests, 1);
  await f.sessions.chat("one", "退避中", () => {});
  assert.equal((await f.engine.state("one")).usage.memory.requests, 1);
});

test("new summary and cognition hard caps are validated at storage and restore boundaries", async (t) => {
  const f = await fixture(t);
  await f.seed(1);
  const row = (await f.memory.readSession("one"))[0];
  const value = { covered: 1, last_id: row.id, last_offset: 0, mode: "long", text: "概要" };
  await assert.rejects(f.engine.commitSummary("one", "p_test", value, [{ text: "字".repeat(81), evidence: [row.id] }]), /80/);
  await assert.rejects(f.engine.commitSummary("one", "p_test", { ...value, text: "字".repeat(201) }), /200/);
  await assert.rejects(f.engine.commitSummary("one", "s_test", { ...value, mode: "short", start_id: row.id }, [{ text: "理解", evidence: [row.id] }]), /短期压缩/);
  const state = await f.engine.state("one");
  state.summaries.s_test = { ...value, mode: "short", start_id: row.id, text: "字".repeat(201) };
  assert.throws(() => validateMemoryState(state), /200/);
  delete state.summaries.s_test;
  state.summaries.p_legacy = { ...value, mode: undefined, text: "字".repeat(500) };
  assert.doesNotThrow(() => validateMemoryState(state), "legacy text is preserved rather than silently truncated on disk");
});

test("identical short summary text and end still updates a changed coverage start", async (t) => {
  const f = await fixture(t);
  await f.seed(3);
  const rows = await f.memory.readSession("one");
  const first = { mode: "short", start_id: rows[0].id, last_id: rows[2].id,
    last_offset: 0, covered: 3, text: "同样的压缩结果" };
  await f.engine.commitSummary("one", "s_range", first);
  await f.engine.commitSummary("one", "s_range", { ...first, start_id: rows[1].id, covered: 2 });
  const next = await f.engine.summaryState("one", "s_range");
  assert.equal(next.start_id, rows[1].id);
  assert.equal(next.covered, 2);
});

test("long consolidation sees the complete legacy overview before producing a compact replacement", async (t) => {
  const f = await fixture(t);
  await f.seed(110, 30);
  const key = "p_" + createHash("sha256").update("one:session").digest("hex").slice(0, 40);
  const legacy = "旧资料".repeat(90) + "尾部重要约定";
  await f.memory.writeSummary(key, legacy, "one");
  await f.sessions.chat("one", "继续", () => {});
  const extraction = f.requests.find((x) => x.max_tokens === 4096);
  assert.equal(JSON.parse(extraction.messages[1].content).previous, legacy);
  assert.ok(Array.from(await f.engine.readSummary("one", key)).length <= 200);
});

test("cancellation during budget reservation cannot start a new compression model call", async (t) => {
  const f = await fixture(t);
  await f.seed(3, 0, 200);
  const rows = await f.memory.readSession("one"), controller = new AbortController();
  f.engine.reserveConsolidation = async () => { controller.abort(Error("已停用")); return true; };
  await compressShort({ services: f.services, id: "one", key: "s_cancel", provider: {}, limit: 100000,
    signal: controller.signal, rows, overflow: rows.slice(0, 2), checkpoint: { covered: 0 } });
  assert.equal(f.requests.length, 0);
  assert.equal((await f.engine.state("one")).usage.memory.requests, 0);
});

test("short compression resumes Unicode fragments across a cold reopen without skipping or replaying text", async (t) => {
  const f = await fixture(t), key = "s_fragments";
  const original = "🐋短期原文。".repeat(750) + "末尾唯一约定Tail7392";
  await f.memory.appendEvent({ session: "one", type: "message", role: "user", text: original });
  await f.memory.appendEvent({ session: "one", type: "message", role: "assistant", text: "继续交流" });
  const rows = await f.memory.readSession("one");
  let services = f.services;
  for (let turn = 0; turn < 5; turn++) {
    const current = await shortContext(services.memoryEngine, "one", key, rows);
    if (current.remaining[0]?.id !== rows[0].id) break;
    assert.equal(await compressShort({ services, id: "one", key, provider: {}, limit: 200000,
      rows, overflow: current.remaining.slice(0, 1), checkpoint: current.checkpoint }), true);
    if (!turn) {
      const saved = await f.engine.summaryState("one", key);
      assert.ok(saved.last_offset > 0 && saved.last_offset < Array.from(original).length);
      const reopened = new Memory(f.memory.root, f.services.logger);
      await reopened.init();
      services = { ...f.services, memory: reopened, memoryEngine: new MemoryEngine(reopened) };
      await services.memoryEngine.recoverSummaries();
    }
  }
  const fragments = f.requests.flatMap((r) => JSON.parse(r.messages[1].content).episodes);
  assert.equal(fragments.map((x: any) => x.text).join(""), original);
  let offset = 0;
  for (const part of fragments) { assert.equal(part.offset, offset); offset += Array.from(part.text).length; }
  const remaining = (await shortContext(services.memoryEngine, "one", key, rows)).remaining;
  assert.deepEqual(remaining, rows.slice(1));
  assert.equal((await services.memoryEngine.state("one")).records.length, 0);
  assert.deepEqual(await services.memory.readSession("one"), rows);
  assert.equal(memoryWindow(rows, contextPolicy({})).long.length, 0);
});

test("failed short-summary commit preserves the previous bridge and retries exactly the uncommitted material", async (t) => {
  const f = await fixture(t), key = "s_failure";
  await f.seed(6, 0, 200);
  const rows = await f.memory.readSession("one"), base = { services: f.services, id: "one", key, provider: {}, limit: 200000, rows };
  await compressShort({ ...base, overflow: rows.slice(0, 2), checkpoint: { covered: 0 } });
  const previous = await f.engine.summaryState("one", key);
  const commit = f.engine.commitSummary.bind(f.engine);
  f.engine.commitSummary = async () => { throw Error("simulated atomic write failure"); };
  await compressShort({ ...base, overflow: rows.slice(2, 4), checkpoint: previous });
  const failed = await f.engine.summaryState("one", key);
  assert.equal(failed.last_id, previous.last_id);
  assert.equal(failed.text, previous.text);
  assert.equal(failed.covered, previous.covered);
  assert.ok(failed.retry_at > Date.now());
  assert.equal(await compressShort({ ...base, overflow: rows.slice(2, 4), checkpoint: failed }), false);
  assert.equal(f.requests.length, 2);
  f.engine.commitSummary = commit;
  await compressShort({ ...base, overflow: rows.slice(2, 4), checkpoint: { ...failed, retry_at: 0 } });
  const batches = f.requests.slice(1).map((r) => JSON.parse(r.messages[1].content).episodes);
  assert.deepEqual(batches[1], batches[0]);
  assert.equal((await f.engine.summaryState("one", key)).last_id, rows[3].id);
  assert.deepEqual(await f.memory.readSession("one"), rows);
});

test("short-summary display write failure is repaired on cold reopen without losing the committed cursor", async (t) => {
  const f = await fixture(t), key = "s_projection";
  await f.seed(4, 0, 200);
  const rows = await f.memory.readSession("one");
  f.memory.writeSummary = async () => { throw Error("simulated display write failure"); };
  await compressShort({ services: f.services, id: "one", key, provider: {}, limit: 200000,
    rows, overflow: rows.slice(0, 2), checkpoint: { covered: 0 } });
  const committed = await f.engine.summaryState("one", key);
  assert.equal(committed.last_id, rows[1].id);
  assert.equal(committed.retry_at, undefined);
  const reopened = new Memory(f.memory.root, f.services.logger);
  await reopened.init();
  const engine = new MemoryEngine(reopened);
  await engine.recoverSummaries();
  assert.deepEqual(await engine.summaryState("one", key), committed);
  assert.equal(await reopened.readSummary(key), committed.text);
  assert.deepEqual((await shortContext(engine, "one", key, rows)).remaining, rows.slice(2));
});

test("no model call or cursor advance occurs when the short-summary quota or model window is insufficient", async (t) => {
  const f = await fixture(t), key = "s_budget";
  await f.seed(4, 0, 200);
  const rows = await f.memory.readSession("one"), settings = (await f.engine.state("one")).settings;
  const args = { services: f.services, id: "one", key, provider: {}, limit: 200000,
    rows, overflow: rows.slice(0, 2), checkpoint: { covered: 0 } };
  await f.engine.settings("one", { ...settings, daily_memory_tokens: 0 }, []);
  assert.equal(await compressShort(args), false);
  await f.engine.settings("one", settings, []);
  assert.equal(await compressShort({ ...args, limit: 100 }), false);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.engine.summaryState("one", key), { covered: 0 });
  assert.equal((await f.engine.state("one")).daily.reserved, 0);
  assert.deepEqual(await f.memory.readSession("one"), rows);
});

test("expanding the short window invalidates a bridge whose source starts later without discarding raw history", async (t) => {
  const f = await fixture(t), key = "s_expand";
  await f.seed(6, 0, 200);
  const rows = await f.memory.readSession("one"), narrowed = rows.slice(2);
  await compressShort({ services: f.services, id: "one", key, provider: {}, limit: 200000,
    rows: narrowed, overflow: narrowed.slice(0, 2), checkpoint: { covered: 0 } });
  const saved = await f.engine.summaryState("one", key);
  assert.ok((await shortContext(f.engine, "one", key, narrowed)).text);
  const expanded = await shortContext(f.engine, "one", key, rows);
  assert.equal(expanded.text, "");
  assert.deepEqual(expanded.remaining, rows);
  assert.deepEqual(await f.engine.summaryState("one", key), saved);
});
