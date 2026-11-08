/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Memory } from "../core/memory.ts";
import { MemoryEngine, MAX_DAILY_MEMORY_TOKENS, validateMemoryState } from "../core/memory-engine.ts";
import { diaryContext, diaryRequestPlan, diarySourceRevision, writeDiary, type DiaryEntry } from "../core/memory-diary.ts";
import { collectTimes } from "../core/time.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext, count = 6) {
  const root = await temporaryDirectory("whale-diary-engine-");
  const warnings: any[] = [];
  const logger: any = { info() {}, warn(...args: any[]) { warnings.push(args); }, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  t.after(async () => { await memory.queue; });
  await memory.init();
  const engine = new MemoryEngine(memory), requests: any[] = [];
  for (let index = 0; index < count; index++) await memory.appendEvent({ session: "one", type: "message",
    role: index % 2 ? "assistant" : "user", text: `原始记录${index}：` + "需要保留来源与事实的完整经历。".repeat(35),
    ts: `2020-01-0${index % 6 + 1}T08:00:00.000Z`, persona_revision: "revision-a",
    timezone: "Asia/Shanghai", channel: "plugin", account: "diary-fixture", origin: { plugin: "diary-fixture" },
    ...(index === 0 ? { occurred_at: "2019-12-31T08:00:00.000Z" } : {}) });
  const services: any = { memory, memoryEngine: engine, logger, llm: { chat: async (request: any) => {
    requests.push(request);
    return { text: JSON.stringify({ diary: "2020年1月，我与用户交流了这些经历。用户提供的事实仍以原始陈述为准，我的理解尚需后续验证。" }),
      toolCalls: [], finish_reason: "stop", usage: { prompt_tokens: 50, completion_tokens: 30 } };
  } } };
  const rows = await memory.readSession("one");
  const options = { services, id: "one", scope: "session", rows, provider: { model: "fixture-chat" },
    limit: 200000, outputTokens: 8192 };
  return { root, memory, engine, rows, services, requests, options, warnings };
}
function entry(rows: any[], patch: Partial<DiaryEntry> = {}): DiaryEntry {
  return { version: 1, id: randomUUID(), session: "one", scope: "session", text: "我记下了用户提供的经历，相关理解仍有待核实。",
    source_ids: rows.map(row => row.id), source_revision: diarySourceRevision(rows),
    created_at: "2026-11-08T08:00:00.000Z", ...collectTimes(undefined, rows), ...patch };
}

test("diary preflight exactly matches generation messages and reservation without mutating state or sources", async t => {
  const f = await fixture(t), rows = structuredClone(f.rows), state = await f.engine.state("one");
  const input = { rows: f.rows, scope: "session", timezone: "Asia/Shanghai", outputTokens: 8192,
    writtenAt: "2026-11-08T12:34:56.000Z" };
  const planned = diaryRequestPlan(input);
  assert.deepEqual(diaryRequestPlan(input), planned);
  assert.deepEqual(f.rows, rows); assert.deepEqual(await f.engine.state("one"), state);
  assert.equal(f.requests.length, 0);
  let reserved = 0;
  const reserve = f.engine.reserveMemoryRequest.bind(f.engine);
  f.engine.reserveMemoryRequest = async (id, amount) => { reserved = amount; return reserve(id, amount); };
  assert.equal((await writeDiary({ ...f.options, timezone: "Asia/Shanghai" })).status, "written");
  const actualMessages = f.requests[0].messages;
  const expected = diaryRequestPlan({ ...input, writtenAt: JSON.parse(actualMessages[1].content).written_at });
  assert.deepEqual(actualMessages, expected.messages);
  assert.equal(reserved, expected.reserved); assert.equal(reserved, planned.reserved);
});

test("diaries append original source ranges atomically, survive restart, and do not write cognitions", async t => {
  const f = await fixture(t), original = await f.memory.readSession("one");
  const first = await writeDiary({ ...f.options, rows: f.rows.slice(0, 3) });
  assert.equal(first.status, "written"); assert.ok(first.entry);
  const second = await writeDiary({ ...f.options, rows: f.rows.slice(3) });
  assert.equal(second.status, "written");
  const restarted = new MemoryEngine(f.memory), state = await restarted.state("one");
  const context = await diaryContext(restarted, "one", "session", f.rows);
  assert.equal(context.entries.length, 2); assert.equal(context.remaining.length, 0); assert.equal(context.invalid, 0);
  assert.equal(state.records.length, 0); assert.deepEqual(state.summaries, {});
  assert.equal(state.usage.memory.requests, 2); assert.equal(state.daily.reserved, 160);
  assert.deepEqual(await f.memory.readSession("one"), original);
  const request = JSON.parse(f.requests[1].messages[1].content);
  assert.deepEqual(request.records.map((row: any) => row.id), f.rows.slice(3).map(row => row.id));
  assert.equal(request.previous, undefined); assert.doesNotMatch(JSON.stringify(request), /2020年1月，我与用户交流/);
  assert.match(f.requests[0].messages[0].content, /第一人称/);
  assert.match(f.requests[0].messages[0].content, /我的推测/);
  assert.match(f.requests[0].messages[0].content, /日记写作日期当作事件日期/);
  assert.equal(JSON.parse(f.requests[0].messages[1].content).records[0].occurred_at, "2019-12-31T08:00:00.000Z");
  assert.match(first.entry.created_at, /^2026-/); assert.match(first.entry.time_range.start!, /^2020-/);
});

test("a single diary accepts more than twenty whole messages and more than two hundred characters", async t => {
  const f = await fixture(t, 31);
  await f.engine.settings("one", { ...(await f.engine.state("one")).settings, daily_memory_tokens: 200000 }, []);
  const prose = "我记得用户逐步解释了事情的经过；明确陈述与我的推测分别保留。".repeat(14);
  f.services.llm.chat = async (request: any) => {
    f.requests.push(request);
    return { text: JSON.stringify({ diary: prose, cognition: [1, 2, 3, 4] }), usage: { prompt_tokens: 500, completion_tokens: 500 } };
  };
  const result = await writeDiary(f.options);
  assert.equal(result.status, "written"); assert.equal(result.entry?.text, prose);
  assert.equal(JSON.parse(f.requests[0].messages[1].content).records.length, 31);
  assert.equal(JSON.parse(f.requests[0].messages[1].content).records[0].text, f.rows[0].text);
  assert.equal((await f.engine.state("one")).records.length, 0);
});

test("filtering or editing invalidates only the diary that covers that source", async t => {
  const f = await fixture(t), a = entry(f.rows.slice(0, 2)), b = entry(f.rows.slice(2, 4));
  await f.engine.commitDiary("one", a); await f.engine.commitDiary("one", b);
  const filtered = await diaryContext(f.engine, "one", "session", f.rows.slice(1));
  assert.equal(filtered.invalid, 1); assert.deepEqual(filtered.entries.map(x => x.id), [b.id]);
  assert.ok(filtered.remaining.some(row => row.id === f.rows[1].id));
  const edited = structuredClone(f.rows); edited[0].text += "新更正";
  const changed = await diaryContext(f.engine, "one", "session", edited);
  assert.equal(changed.invalid, 1); assert.deepEqual(changed.entries.map(x => x.id), [b.id]);
  const plugin = f.engine.plugin("diary-fixture", () => {});
  await plugin.excludeInputs("one", [f.rows[0].id]);
  const excluded = await diaryContext(f.engine, "one", "session", f.rows);
  assert.equal(excluded.invalid, 1); assert.deepEqual(excluded.entries.map(x => x.id), [b.id]);
  assert.ok(!excluded.remaining.some(row => row.id === f.rows[0].id));
  assert.equal((await f.engine.state("one")).diaries.length, 2, "invalid prose remains in the audit archive");
  assert.deepEqual(await f.memory.readSession("one"), f.rows);
});

test("commit rechecks current persisted source, enforces scope, overlap and immutable IDs", async t => {
  const f = await fixture(t), a = entry(f.rows.slice(0, 2));
  await f.engine.commitDiary("one", a); await f.engine.commitDiary("one", structuredClone(a));
  assert.equal((await f.engine.state("one")).diaries.length, 1);
  await assert.rejects(f.engine.commitDiary("one", { ...a, text: "不能覆盖" }), /不能覆盖/);
  await assert.rejects(f.engine.commitDiary("one", entry(f.rows.slice(1, 3))), /重叠/);
  await assert.rejects(f.engine.commitDiary("other", a), /不属于/);
  await assert.rejects(f.engine.commitDiary("one", entry(f.rows.slice(2), { scope: "persona:revision-b" })), /来源已变更/);
  await assert.rejects(f.engine.commitDiary("one", entry([...f.rows.slice(2)].reverse())), /来源已变更/);
  const second = entry(f.rows.slice(2, 4)), stale = entry(f.rows.slice(4));
  const results = await Promise.allSettled([f.engine.commitDiary("one", second), f.engine.commitDiary("one", entry(f.rows.slice(2, 4)))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const files = await f.memory.episodePaths("one");
  const edited = structuredClone(f.rows); edited[4].text += "原文已编辑";
  await writeFile(files[0], edited.map(row => JSON.stringify(row)).join("\n") + "\n");
  await assert.rejects(f.engine.commitDiary("one", stale), /来源已变更/);
  assert.equal((await f.engine.state("one")).diaries.length, 2);
  await f.engine.commitDiary("one", entry(edited.slice(4)));
  assert.equal((await f.engine.state("one")).diaries.length, 3);
});

test("semantic scopes and sessions reuse only their own diary entries", async t => {
  const f = await fixture(t), scoped = entry(f.rows.slice(0, 2), { scope: "persona:revision-a" });
  await f.engine.commitDiary("one", scoped);
  assert.equal((await diaryContext(f.engine, "one", "session", f.rows)).entries.length, 0);
  assert.equal((await diaryContext(f.engine, "one", "persona:revision-b", f.rows)).entries.length, 0);
  assert.equal((await diaryContext(f.engine, "one", "persona:revision-a", f.rows)).entries.length, 1);
  assert.equal((await diaryContext(f.engine, "other", "persona:revision-a", f.rows)).entries.length, 0);
  await f.engine.commitDiary("one", entry(f.rows.slice(0, 2)));
  assert.equal((await f.engine.state("one")).diaries.length, 2, "separate explicit history scopes own independent projections");
});

test("imported tool messages retain role and fingerprint while independent tool work records stay outside diaries", async t => {
  const f = await fixture(t, 2);
  await f.memory.appendEvent({ session: "one", type: "message", role: "tool", text: "已核实的历史工具结果。".repeat(80),
    ts: "2020-01-03T08:00:00.000Z", persona_revision: "revision-a", origin: { action: "历史工具返回" } });
  await f.memory.appendEvent({ session: "one", type: "tool", role: "tool", name: "archive-only",
    text: "WORK_ARCHIVE_MUST_NOT_BECOME_DIARY", result: { internal: "WORK_PRIVATE_RESULT" },
    ts: "2020-01-04T08:00:00.000Z" });
  const all = await f.memory.readSession("one"), messages = all.filter(row => row.type === "message");
  const result = await writeDiary({ ...f.options, rows: messages });
  assert.equal(result.status, "written");
  assert.deepEqual(result.entry?.source_ids, messages.map(row => row.id));
  assert.equal(result.entry?.source_revision, diarySourceRevision(messages));
  const request = JSON.parse(f.requests[0].messages[1].content);
  assert.equal(request.records.at(-1).role, "tool");
  assert.equal(request.records.at(-1).text, messages.at(-1).text);
  assert.doesNotMatch(JSON.stringify(f.requests), /WORK_ARCHIVE_MUST_NOT_BECOME_DIARY|WORK_PRIVATE_RESULT/);
  assert.match(f.requests[0].messages[0].content, /不把发起调用当作成功/);
  assert.equal((await diaryContext(f.engine, "one", "session", messages)).entries.length, 1);
  const edited = structuredClone(messages); edited.at(-1).text += "工具结果已更正";
  assert.equal((await diaryContext(f.engine, "one", "session", edited)).invalid, 1);
  await assert.rejects(f.engine.commitDiary("one", entry(all.slice(-1))), /来源已变更/);
  assert.deepEqual(await f.memory.readSession("one"), all);
});

test("bad output pauses persistently, preserves earlier diary and original rows, and requires explicit retry", async t => {
  const f = await fixture(t), preserved = entry(f.rows.slice(0, 2));
  await f.engine.commitDiary("one", preserved);
  f.services.llm.chat = async (request: any) => { f.requests.push(request); return {
    text: '{"diary":"PRIVATE_MODEL_OUTPUT', finish_reason: "stop", usage: { prompt_tokens: 70, completion_tokens: 15 } };
  };
  const options = { ...f.options, rows: f.rows.slice(2) };
  const failed = await writeDiary(options);
  assert.equal(failed.status, "failed");
  const state = await f.engine.state("one");
  assert.equal(state.usage.memory.requests, 1); assert.equal(state.daily.reserved, 85);
  assert.equal(state.diaries.length, 1); assert.deepEqual(await f.memory.readSession("one"), f.rows);
  assert.doesNotMatch(JSON.stringify(f.warnings), /PRIVATE_MODEL_OUTPUT/);
  const restarted = new MemoryEngine(f.memory); f.services.memoryEngine = restarted;
  assert.equal((await writeDiary(options)).status, "paused"); assert.equal(f.requests.length, 1);
  assert.ok((await diaryContext(restarted, "one", "session", f.rows)).paused);
  await restarted.retryDiary("one", "persona:revision-a");
  assert.equal((await writeDiary(options)).status, "paused", "reset does not cross scopes");
  await restarted.retryDiary("one", "session");
  f.services.llm.chat = async (request: any) => { f.requests.push(request); return { text: '{"diary":"我与用户继续交流，保留来源及不确定性。"}',
    usage: { prompt_tokens: 20, completion_tokens: 10 } }; };
  assert.equal((await writeDiary(options)).status, "written"); assert.equal(f.requests.length, 2);
  assert.equal((await restarted.state("one")).diaries[0].text, preserved.text);
});

test("truncated, empty, abnormal and non-saving responses do not advance source coverage", async t => {
  for (const output of [
    { text: '{"diary":"完整JSON也不能接受截断。"}', finish_reason: "length" },
    { text: '{"diary":""}' }, { text: '{"diary":"未正常结束。"}', finish_reason: "content_filter" },
    { text: JSON.stringify({ diary: "原".repeat(3000) }) },
  ]) await t.test(JSON.stringify(output).slice(0, 80), async child => {
    const f = await fixture(child, 2);
    f.services.llm.chat = async () => ({ ...output, usage: { prompt_tokens: 10, completion_tokens: 20 } });
    const result = await writeDiary(f.options);
    assert.equal(result.status, "failed");
    const context = await diaryContext(f.engine, "one", "session", f.rows);
    assert.equal(context.entries.length, 0); assert.equal(context.remaining.length, 2); assert.ok(context.paused);
    assert.equal((await f.engine.state("one")).daily.reserved, 30);
  });
});

test("cancellation before send refunds reservation and creates neither request usage nor pause", async t => {
  const f = await fixture(t), controller = new AbortController(), reserve = f.engine.reserveMemoryRequest.bind(f.engine);
  f.engine.reserveMemoryRequest = async (...args) => { const ticket = await reserve(...args); controller.abort(); return ticket; };
  const result = await writeDiary({ ...f.options, signal: controller.signal });
  assert.equal(result.status, "failed"); assert.equal(f.requests.length, 0);
  const state = await f.engine.state("one");
  assert.equal(state.daily.reserved, 0); assert.equal(state.usage.memory.requests, 0); assert.deepEqual(state.diary_failures, {});
});

test("cancellation after response charges observed usage without saving or pausing", async t => {
  const f = await fixture(t), controller = new AbortController();
  f.services.llm.chat = async () => { controller.abort(); return { text: '{"diary":"我记下了经历。"}',
    usage: { prompt_tokens: 10, completion_tokens: 20 } }; };
  assert.equal((await writeDiary({ ...f.options, signal: controller.signal })).status, "failed");
  const state = await f.engine.state("one");
  assert.equal(state.daily.reserved, 30); assert.equal(state.usage.memory.requests, 1);
  assert.equal(state.diaries.length, 0); assert.deepEqual(state.diary_failures, {});
});

test("failed transport records one unknown request and retains conservative reservation", async t => {
  const f = await fixture(t);
  f.services.llm.chat = async () => { throw Error("PRIVATE_TRANSPORT_DETAILS"); };
  assert.equal((await writeDiary(f.options)).status, "failed");
  const state = await f.engine.state("one");
  assert.equal(state.usage.memory.requests, 1); assert.equal(state.usage.memory.unknown_requests, 1);
  assert.ok(state.daily.reserved > f.options.outputTokens); assert.ok(state.diary_failures.session);
  assert.doesNotMatch(JSON.stringify(f.warnings), /PRIVATE_TRANSPORT_DETAILS/);
});

test("source exclusion during generation rejects the entire commit and preserves the old diary", async t => {
  const f = await fixture(t), existing = entry(f.rows.slice(0, 2));
  await f.engine.commitDiary("one", existing);
  const plugin = f.engine.plugin("diary-fixture", () => {});
  f.services.llm.chat = async () => {
    await plugin.excludeInputs("one", [f.rows[2].id]);
    return { text: '{"diary":"我曾与用户交流这些经历。"}', usage: { prompt_tokens: 100, completion_tokens: 30 } };
  };
  assert.equal((await writeDiary({ ...f.options, rows: f.rows.slice(2) })).status, "failed");
  const state = await f.engine.state("one");
  assert.deepEqual(state.diaries, [existing]); assert.equal(state.daily.reserved, 130);
  const context = await diaryContext(f.engine, "one", "session", f.rows);
  assert.deepEqual(context.entries, [existing]); assert.equal(context.remaining.length, 3);
  assert.ok(context.paused);
});

test("completed output uses provider usage, not an approximate local output-token veto", async t => {
  const f = await fixture(t, 6), prose = "我记得用户的说明，我的理解仍有不确定之处。".repeat(15);
  f.services.llm.chat = async () => ({ text: JSON.stringify({ diary: prose }), finish_reason: "stop",
    usage: { prompt_tokens: 100, completion_tokens: 250 } });
  const result = await writeDiary({ ...f.options, outputTokens: 256 });
  assert.equal(result.status, "written"); assert.equal(result.entry?.text, prose);
  assert.equal((await f.engine.state("one")).daily.reserved, 350);
});

test("diary output reservation overrides max_completion_tokens without sending conflicting limits", async t => {
  const f = await fixture(t), provider = { model: "fixture-chat", parameters: { max_completion_tokens: 16000, max_tokens: 2000 } };
  f.services.llm.chat = async (request: any) => {
    f.requests.push(request);
    assert.equal(request.max_tokens, undefined);
    assert.equal(request.provider.parameters.max_tokens, undefined);
    assert.equal(request.provider.parameters.max_completion_tokens, 512);
    return { text: '{"diary":"我记下了用户的经历，尚未确定的理解仍待核实。"}', finish_reason: "stop",
      usage: { prompt_tokens: 50, completion_tokens: 30 } };
  };
  assert.equal((await writeDiary({ ...f.options, provider, outputTokens: 512 })).status, "written");
  assert.equal((await f.engine.state("one")).daily.reserved, 80);
  assert.deepEqual(provider.parameters, { max_completion_tokens: 16000, max_tokens: 2000 });
});

test("cancellation while waiting to commit is checked inside the atomic write queue", async t => {
  const f = await fixture(t), controller = new AbortController(), commit = f.engine.commitDiary.bind(f.engine);
  f.engine.commitDiary = async (...args) => {
    controller.abort();
    return commit(...args);
  };
  assert.equal((await writeDiary({ ...f.options, signal: controller.signal })).status, "failed");
  const state = await f.engine.state("one");
  assert.equal(state.diaries.length, 0); assert.deepEqual(state.diary_failures, {});
  assert.equal(state.daily.reserved, 80); assert.equal(state.usage.memory.requests, 1);
});

test("insufficient budget and capacity do not send requests or auto-pause", async t => {
  const f = await fixture(t);
  assert.equal((await writeDiary({ ...f.options, limit: 100 })).status, "capacity");
  await f.engine.settings("one", { ...(await f.engine.state("one")).settings, daily_memory_tokens: 0 }, []);
  assert.equal((await writeDiary(f.options)).status, "budget");
  assert.equal(f.requests.length, 0);
  const state = await f.engine.state("one");
  assert.equal(state.usage.memory.requests, 0); assert.deepEqual(state.diary_failures, {}); assert.equal(state.daily.reserved, 0);
});

test("large context diary budgets are explicitly configurable without raising the default", async t => {
  const f = await fixture(t);
  assert.equal((await f.engine.state("one")).settings.daily_memory_tokens, 20000);
  assert.equal(await f.engine.reserveMemoryRequest("one", 300000), null);
  const settings = { ...(await f.engine.state("one")).settings, daily_memory_tokens: MAX_DAILY_MEMORY_TOKENS };
  await f.engine.settings("one", settings, []);
  const restarted = new MemoryEngine(f.memory);
  assert.equal((await restarted.state("one")).settings.daily_memory_tokens, 10000000);
  const ticket = await restarted.reserveMemoryRequest("one", 300000);
  assert.ok(ticket);
  await restarted.settleMemoryRequest("one", ticket, { prompt_tokens: 280000, completion_tokens: 8000 });
  assert.equal((await restarted.state("one")).daily.reserved, 288000);
  for (const daily of [MAX_DAILY_MEMORY_TOKENS + 1, -1, 1.5, Infinity]) {
    await assert.rejects(restarted.settings("one", { ...settings, daily_memory_tokens: daily }, []), /每日整理预算/);
    const corrupt = structuredClone(await restarted.state("one"));
    corrupt.settings.daily_memory_tokens = daily;
    assert.throws(() => validateMemoryState(corrupt), /整理预算损坏/);
  }
  assert.equal((await restarted.state("one")).settings.daily_memory_tokens, MAX_DAILY_MEMORY_TOKENS);
});

test("optional diary state preserves old fixtures and validates new fields at restore boundaries", async t => {
  const f = await fixture(t), legacy: any = await f.engine.state("one");
  delete legacy.diaries; delete legacy.diary_failures;
  assert.doesNotThrow(() => validateMemoryState(legacy));
  const file = join(f.memory.root, "sessions", "one", "knowledge", "state.json");
  await f.engine.pauseDiary("one", "session", "测试暂停");
  await writeFile(file, JSON.stringify(legacy));
  assert.equal((await diaryContext(new MemoryEngine(f.memory), "one", "session", f.rows)).entries.length, 0);
  const fresh = entry(f.rows);
  await f.engine.commitDiary("one", fresh);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.diaries.length, 1); assert.equal(saved.summaries && Object.keys(saved.summaries).length, 0);
  for (const patch of [{ source_ids: [] }, { source_ids: ["bad:id"] }, { source_revision: "bad" },
    { session: "../escape" }, { scope: "unknown" }, { created_at: "yesterday" }, { text: "字".repeat(32001) }]) {
    const broken = structuredClone(saved); Object.assign(broken.diaries[0], patch);
    assert.throws(() => validateMemoryState(broken));
  }
});
