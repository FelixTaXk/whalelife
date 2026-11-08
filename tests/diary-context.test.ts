/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { Sessions } from "../core/session.ts";
import { contextPolicy, validateContext } from "../core/session-context.ts";
import { temporaryDirectory } from "./temporary-directory.ts";
import { fittingDiaryPrefix } from "../core/context-material.ts";

test("maintenance capacity fits complete exchanges without splitting an oversized exchange", () => {
  const rows = ["user", "assistant", "user", "assistant", "user", "assistant"].map(role => ({ role }));
  assert.deepEqual(fittingDiaryPrefix(rows, candidate => candidate.length <= 5), rows.slice(0, 4));
  assert.deepEqual(fittingDiaryPrefix(rows, candidate => candidate.length < 2), []);
  assert.deepEqual(fittingDiaryPrefix(rows, () => true), rows);
});

async function fixture(t: TestContext, enabled = false, limit = 30000) {
  const root = await temporaryDirectory("whale-diary-context-");
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  const engine = new MemoryEngine(memory);
  let sessions: Sessions | undefined;
  t.after(async () => { await sessions?.close(); await memory.queue; });
  await memory.init();
  await writeFile(join(root, "persona.md"), "我是测试伙伴，称呼由当前人格决定。");
  const config: any = { providers: [{ id: "test", protocol: "openai-compatible", model: "chat", base_url: "https://unused.invalid/v1" }],
    models: [{ id: "chat", name: "Chat", provider: "test", model: "chat", type: "chat", enabled: true,
      context_window: limit || null, parameters: { max_tokens: 512 } }], model_bindings: { chat: "chat" },
    personas: { one: { name: "伙伴", file: "persona.md", provider: "test" }, two: { name: "第二人格", file: "persona.md", provider: "test" } },
    channels: { web: { persona: "one", permission: "off" } }, memory: { root: "memory", diary_enabled: enabled,
      compression_trigger_percent: 80, compression_target_percent: 50, budget_tokens: 100, short_term_days: 1, short_term_min_messages: 1 } };
  const calls: any[] = [];
  let diaryText = JSON.stringify({ diary: "记录中的用户明确要求记住约定暗号蓝帆5921；我们讨论了路线，各阶段细节以原文为准。" });
  const services: any = { memory, memoryEngine: engine, logger, tools: { list: () => [] }, llm: { chat: async (r: any) => {
    calls.push(structuredClone({ messages: r.messages, max_tokens: r.max_tokens }));
    return { text: r.max_tokens ? diaryText : "收到。", finish_reason: "stop", toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 25 } };
  } } };
  sessions = new Sessions(root, config, services);
  await memory.saveSessionMeta("one", { name: "合成测试" });
  await memory.currentSession({ id: "one" });
  await engine.settings("one", { ...(await engine.state("one")).settings, daily_memory_tokens: 200000 }, []);
  const seed = async (count: number, size = 500) => {
    for (let i = 0; i < count; i++) await memory.appendEvent({ session: "one", type: "message", role: i % 2 ? "assistant" : "user",
      text: `原文编号${i}：暗号蓝帆5921。` + "风".repeat(size), ts: new Date(Date.now() - 30 * 86400000 + i * 1000).toISOString() });
  };
  return { sessions, memory, engine, config, calls, seed, diaryText: (value: string) => { diaryText = value; } };
}

test("automatic diary defaults off; new switch overrides legacy fields while old clients remain compatible", () => {
  assert.equal(contextPolicy({}).memory_mode, "full");
  assert.equal(contextPolicy({}).diary_enabled, false);
  assert.equal(contextPolicy({ budget_tokens: 6000 }).memory_mode, "legacy");
  assert.equal(contextPolicy({ memory_mode: "diary" }).diary_enabled, true);
  assert.equal(contextPolicy({ memory_mode: "full" }).diary_enabled, false);
  const old = contextPolicy({ budget_tokens: 6000 });
  assert.equal(contextPolicy({}, old).memory_mode, "legacy", "old full-object round trips keep legacy behavior");
  assert.equal(contextPolicy({ memory_mode: "diary" }, { diary_enabled: false, budget_tokens: 100 }).memory_mode, "full");
  assert.equal(contextPolicy({ memory_mode: "legacy" }, { diary_enabled: true }).diary_enabled, true);
  assert.equal(contextPolicy({ memory_mode: "full", budget_tokens: 6000 }).memory_mode, "full");
  const next = { diary_enabled: true, compression_trigger_percent: 80, compression_target_percent: 50,
    history_enabled: true, history_scope: "session", include_facts: true };
  assert.equal(validateContext(next).diary_enabled, true);
  assert.equal(validateContext({ ...next, diary_enabled: false, memory_mode: "legacy" }).memory_mode, "full");
  for (const diary_enabled of [null, "false", 0, 1])
    assert.throws(() => validateContext({ ...next, diary_enabled }), /开关/);
  for (const [trigger, target] of [[96, 50], [80, 80], [80, 81], [80, 0], [NaN, 50]])
    assert.throws(() => validateContext({ ...next, compression_trigger_percent: trigger, compression_target_percent: target }), /比例/);
});

test("with automatic diary disabled and none saved, complete history ignores legacy token/day limits", async t => {
  const f = await fixture(t);
  await f.seed(12);
  const before = await f.memory.readSession("one");
  await f.sessions.chat("one", "继续", () => {});
  assert.equal(f.calls.length, 1);
  const prompt = JSON.stringify(f.calls[0].messages);
  assert.match(prompt, /原文编号0/); assert.match(prompt, /原文编号11/);
  assert.equal((await f.engine.state("one")).usage.memory.requests, 0);
  assert.deepEqual((await f.memory.readSession("one")).slice(0, before.length), before);
  const status = await f.sessions.contextStatus("one");
  assert.equal(status.policy.memory_mode, "full");
  assert.equal(status.diary.enabled, false);
  assert.equal(status.memory_window.long_term_messages, 0);
  assert.equal(status.context_estimate.percent, status.context_estimate.total_tokens / 30000 * 100);
  assert.equal(await f.memory.currentSession(), "one");
});

test("disabled automatic diary rejects overflow without deleting history or changing current session", async t => {
  const f = await fixture(t, false, 2200);
  await f.seed(6);
  await assert.rejects(f.sessions.chat("one", "这条输入也应保存", () => {}), /当前上下文已达到/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.memory.readSession("one")).length, 7);
  assert.equal(await f.memory.currentSession(), "one");
});

test("diary triggers by occupation and stays in context after automatic generation is disabled", async t => {
  const f = await fixture(t, true, 10000);
  await f.seed(12);
  await f.sessions.chat("one", "继续", () => {});
  assert.equal(f.calls.filter(c => c.max_tokens).length, 1);
  const state = await f.engine.state("one");
  assert.equal(state.diaries?.length, 1);
  const original = await f.memory.readSession("one"), ids = new Set(state.diaries![0].source_ids);
  const chat = JSON.stringify(f.calls.find(c => !c.max_tokens).messages);
  assert.match(chat, /长期日记/);
  for (const row of original.filter(r => ids.has(r.id))) assert.ok(!chat.includes(row.text), "covered text is replaced, not duplicated");
  assert.match(chat, /原文编号11/);
  const firstDiary = structuredClone(state.diaries![0]);
  f.config.channels.web.persona = "two";
  await f.sessions.chat("one", "换人格继续", () => {});
  assert.equal(f.calls.filter(c => c.max_tokens).length, 1);
  const before = await f.sessions.contextStatus("one");
  await f.sessions.updateContext("one", { ...before.policy, diary_enabled: false });
  f.config.models[0].context_window = Math.ceil(before.context_estimate.total_tokens / 0.85);
  const disabled = await f.sessions.contextStatus("one");
  assert.equal(disabled.diary.enabled, false);
  assert.ok(disabled.context_estimate.percent! >= 80, "the next turn would be eligible for automatic generation if enabled");
  assert.equal(disabled.diary.count, 1); assert.equal(disabled.diary.covered_messages, ids.size);
  await f.sessions.chat("one", "关闭自动生成后继续", () => {});
  assert.match(JSON.stringify(f.calls.at(-1).messages), /【长期日记/);
  for (const row of original.filter(r => ids.has(r.id)))
    assert.ok(!JSON.stringify(f.calls.at(-1).messages).includes(row.text), "switching off cannot restore already covered raw history");
  assert.equal(f.calls.filter(c => c.max_tokens).length, 1);
  assert.deepEqual((await f.engine.state("one")).diaries![0], firstDiary);
  await assert.rejects(f.sessions.retryDiary("one"), /先启用/);
  await f.sessions.updateContext("one", { ...(await f.sessions.contextStatus("one")).policy, history_enabled: false });
  const hidden = await f.sessions.contextStatus("one");
  assert.equal(hidden.diary.count, 0); assert.equal(hidden.diary.covered_messages, 0);
});

test("failed diary pauses across subsequent chats and resumes only explicitly, with source retained", async t => {
  const f = await fixture(t, true, 15000);
  await f.seed(18, 400);
  f.diaryText("INVALID JSON");
  await f.sessions.chat("one", "继续", () => {});
  await f.sessions.chat("one", "再继续", () => {});
  assert.equal(f.calls.filter(c => c.max_tokens).length, 1);
  assert.ok((await f.sessions.contextStatus("one")).diary.paused);
  f.diaryText(JSON.stringify({ diary: "用户约定的暗号是蓝帆5921；本次讨论过多个路线阶段，未形成其他新约定。" }));
  await f.sessions.retryDiary("one");
  await f.sessions.chat("one", "明确恢复以后继续", () => {});
  assert.equal(f.calls.filter(c => c.max_tokens).length, 2);
  assert.equal((await f.engine.state("one")).diaries?.length, 1);
});

test("unknown model capacity is shown as unknown and does not guess or silently compress", async t => {
  const f = await fixture(t, true, 0);
  await f.seed(8);
  await f.sessions.chat("one", "继续", () => {});
  assert.equal(f.calls.length, 1);
  const status = await f.sessions.contextStatus("one");
  assert.equal(status.model.context_window, null);
  assert.equal(status.context_estimate.percent, null);
  assert.match(status.diary.notice!, /填写上限/);
});

test("a single completed large exchange can become a diary while current input remains verbatim", async t => {
  const f = await fixture(t, true, 20000);
  await f.seed(2, 5200);
  await f.sessions.chat("one", "这一条新问题绝不归档", () => {});
  assert.equal(f.calls.filter(c => c.max_tokens).length, 1);
  assert.equal((await f.engine.state("one")).diaries?.[0].source_ids.length, 2);
  const maintenance = JSON.stringify(f.calls.find(c => c.max_tokens).messages);
  const chat = JSON.stringify(f.calls.find(c => !c.max_tokens).messages);
  assert.doesNotMatch(maintenance, /这一条新问题绝不归档/);
  assert.match(chat, /这一条新问题绝不归档/);
  assert.doesNotMatch(chat, /原文编号0/);
});
