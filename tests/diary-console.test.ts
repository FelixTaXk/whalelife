/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { MemoryAdmin } from "../core/memory-admin.ts";
import { diarySourceRevision, type DiaryEntry } from "../core/memory-diary.ts";
import { collectTimes } from "../core/time.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const { renderContextMeter, renderContextPanel, bindContextSettings } =
  await import(new URL("../core/ui/context.js", import.meta.url).href);
const { renderMemory } = await import(new URL("../core/ui/memory.js", import.meta.url).href);

function context(policy: Record<string, unknown> = {}) {
  return { model: { name: "合成模型", context_window: 10000 },
    policy: { diary_enabled: false, history_enabled: true, include_facts: true,
      history_scope: "session", compression_trigger_percent: 80, compression_target_percent: 50, ...policy },
    context_estimate: { input_tokens: 6500, reserved_output_tokens: 1500, total_tokens: 8000,
      percent: 80, source: "estimate" },
    usage: { input_tokens: 3000, output_tokens: 500, used_tokens: 3500,
      percent: 35, measured_at: "2026-11-08T00:00:00Z" },
    available_messages: 25, stored_messages: 30,
    diary: { count: 2, covered_messages: 20, remaining_messages: 5, chars: 500, enabled: false,
      budget_remaining: 1000, notice: "今日记忆整理额度不足，原文保留" } };
}
function ui(policy: Record<string, unknown> = {}): any {
  return { state: { session: "one", memorySession: "two", memoryLoadedSession: "two",
    memoryContext: context(policy) } };
}

test("unified context defaults automatic diaries off while keeping existing diary usage and recommended percentages", () => {
  const app = ui(), full = renderContextPanel(app);
  assert.match(full, /name="diary_enabled" >自动整理为日记/);
  assert.match(full, /默认关闭/);
  assert.match(full, /已有有效日记仍按历史范围用于上下文/);
  assert.match(full, /没有日记时带入完整有效历史/);
  assert.doesNotMatch(full, /name="(?:memory_mode|short_term_days|short_term_min_messages|budget_tokens|include_summary|long_term_enabled)"|普通模式|日记模式|兼容模式|仅供查看/);
  assert.match(full, /name="compression_trigger_percent"[^>]*value="80"/);
  assert.match(full, /name="compression_target_percent"[^>]*value="50"/);
  assert.match(full, /恢复推荐值 80% \/ 50%/);
  app.state.memoryContext.policy = {};
  assert.doesNotMatch(renderContextPanel(app), /name="diary_enabled" checked/);
  app.state.memoryContext = context({ diary_enabled: true });
  app.state.memoryContext.diary.enabled = true;
  app.state.memoryContext.diary.paused = { reason: "合成失败", at: "2026-11-08T00:00:00Z" };
  const diary = renderContextPanel(app);
  assert.match(diary, /已有日记按篇追加，不重新总结/);
  assert.match(diary, /日记 2 篇 · 覆盖 20 条原文 · 剩余 5 条原文 · 500 字符/);
  assert.match(diary, /今日整理剩余额度 1,000 tokens/);
  assert.match(diary, /今日记忆整理额度不足，原文保留/);
  assert.match(diary, /data-diary-retry/);
});

test("context percentage leads with its estimate source while measured usage remains separately labeled", () => {
  const value = context(), detail = renderContextMeter(value), compact = renderContextMeter(value, true);
  assert.match(detail, /<strong>80.00% · 当前估算<\/strong>/);
  assert.match(detail, /输入 6,500 \+ 预留输出 1,500 = 8,000 tokens/);
  assert.match(detail, /最近请求实测：输入 3,000 \+ 输出 500 = 3,500 tokens/);
  assert.match(compact, />上下文 80.00% · 当前估算<\/span>/);
  assert.doesNotMatch(compact, /<progress|<form|<p>|<details/);
  value.model.context_window = null as any;
  const unknown = renderContextMeter(value), compactUnknown = renderContextMeter(value, true);
  assert.doesNotMatch(unknown, /80.00%|35.00%|<progress/);
  assert.match(unknown, /href="#models"/);
  assert.match(compactUnknown, /上下文 容量未知/);
  assert.match(compactUnknown, /href="#models">填写模型容量/);
});

test("diary switch and recommended reset are local; explicit save sends the flag and percentages to the viewed archive", async t => {
  const app = ui(), error = { textContent: "" }, submit = { disabled: false };
  const trigger = { value: "90" }, target = { value: "70" }, diarySwitch = { checked: false, onchange: undefined as any };
  const defaults = { onclick: undefined as any }, diarySettings = { hidden: true };
  const controls: Record<string, any> = { '#context-error': error, 'button[type=submit]': submit,
    '[name="compression_trigger_percent"]': trigger, '[name="compression_target_percent"]': target,
    '[data-diary-settings]': diarySettings };
  const form: any = { querySelector: (key: string) => controls[key] ?? null };
  app.content = { querySelector: (key: string) => ({ '#context-form': form, '#context-diary-enabled': diarySwitch,
    '[data-diary-defaults]': defaults } as any)[key] ?? null };
  const posts: any[] = [], notices: any[] = [];
  let reloads = 0;
  app.toast = (...args: any[]) => notices.push(args);
  t.mock.method(globalThis, "FormData", function () {
    const values: Record<string, string> = { ...(diarySwitch.checked ? { diary_enabled: "on" } : {}), compression_trigger_percent: trigger.value,
      compression_target_percent: target.value, history_enabled: "on", include_facts: "on", history_scope: "session" };
    return { get: (key: string) => values[key], has: (key: string) => Object.hasOwn(values, key) } as any;
  });
  t.mock.method(globalThis, "fetch", async (path: any, init: any) => {
    posts.push({ path, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(context({ diary_enabled: diarySwitch.checked })));
  });
  bindContextSettings(app, async () => { reloads++; });
  diarySwitch.checked = true; diarySwitch.onchange();
  assert.equal(diarySettings.hidden, false);
  assert.equal(app.state.memoryContext.policy.diary_enabled, false, "the saved switch remains unchanged until submit");
  diarySwitch.checked = false; diarySwitch.onchange();
  assert.equal(diarySettings.hidden, true);
  assert.deepEqual([trigger.value, target.value], ["90", "70"], "toggling preserves unsaved percentages");
  diarySwitch.checked = true; diarySwitch.onchange(); defaults.onclick();
  assert.deepEqual([trigger.value, target.value], ["80", "50"]);
  assert.equal(posts.length, 0); assert.equal(notices.length, 0);
  assert.equal(app.state.session, "one");
  target.value = "85";
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts.length, 0); assert.match(error.textContent, /目标/);
  target.value = "4";
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts.length, 0);
  target.value = "50"; trigger.value = "99";
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts.length, 0); assert.match(error.textContent, /95/);
  trigger.value = "80";
  target.value = "50";
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(posts, [{ path: "/api/session/context", body: { id: "two", context: {
    diary_enabled: true, history_enabled: true, include_facts: true, history_scope: "session",
    compression_trigger_percent: 80, compression_target_percent: 50,
  } } }]);
  assert.equal(reloads, 1); assert.equal(notices.length, 1);
  assert.equal(app.state.session, "one"); assert.equal(app.state.sessionContext, undefined);
  diarySwitch.checked = false; diarySwitch.onchange();
  assert.equal(posts.length, 1, "turning automatic diaries off only edits the draft");
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts[1].body.context.diary_enabled, false);
  assert.equal("memory_mode" in posts[1].body.context, false);
  assert.equal(posts[1].body.context.compression_trigger_percent, 80);
  assert.equal(posts[1].body.context.compression_target_percent, 50);
});

test("browse selection never changes the active session and explicit diary resume is guarded by the loaded archive", async t => {
  const app = ui(), select: any = { value: "three" }, retry: any = { disabled: false };
  const error = { textContent: "" }, form = { querySelector: () => error };
  app.content = { querySelector: (key: string) => ({ '#context-session': select, '#context-form': form,
    '[data-diary-retry]': retry } as any)[key] ?? null };
  const posts: any[] = [], notices: any[] = [];
  let reloads = 0;
  app.toast = (...args: any[]) => notices.push(args);
  t.mock.method(globalThis, "fetch", async (path: any, init: any) => {
    posts.push({ path, body: JSON.parse(init.body) });
    return new Response('{"reset":true}');
  });
  bindContextSettings(app, async () => { reloads++; });
  await retry.onclick();
  assert.deepEqual(posts, [{ path: "/api/memory/diary/retry", body: { id: "two" } }]);
  await select.onchange();
  assert.equal(app.state.memorySession, "three"); assert.equal(app.state.session, "one");
  assert.equal(posts.length, 1); assert.equal(notices.length, 0); assert.equal(reloads, 2);
  await retry.onclick();
  assert.equal(posts.length, 1); assert.match(error.textContent, /档案已改变/);
});

async function archive(t: TestContext) {
  const root = await temporaryDirectory("whale-diary-console-");
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  t.after(async () => { await memory.queue; });
  await memory.init();
  await memory.saveSessionMeta("one", { name: "合成会话", context: { diary_enabled: true } });
  for (let i = 0; i < 3; i++) await memory.appendEvent({ session: "one", type: "message", role: "user",
    text: "合成原文" + i, ts: `2026-10-0${i + 1}T00:00:00Z`, persona_revision: "old",
    channel: "plugin", account: "synthetic", origin: { plugin: "synthetic", action: "fixture" } });
  const engine = new MemoryEngine(memory), rows = await engine.contextRows("one");
  const entry: DiaryEntry = { version: 1, id: "shared-entry", session: "one", scope: "session",
    text: "合成日记正文", source_ids: rows.slice(0, 2).map(row => row.id),
    source_revision: diarySourceRevision(rows.slice(0, 2)), created_at: "2026-11-08T00:00:00Z",
    ...collectTimes(undefined, rows.slice(0, 2)), model: "synthetic-model" };
  await engine.commitDiary("one", entry);
  const admin = new MemoryAdmin(memory, { root, locks: new Set(), config: { memory: {} } }, logger);
  return { root, memory, engine, rows, entry, admin };
}

test("diary admin exposes stable source metadata without a markdown projection or mutating state", async t => {
  const f = await archive(t), stateFile = join(f.memory.sessionDir("one"), "knowledge", "state.json");
  const before = await readFile(stateFile, "utf8"), list = await f.admin.summaries();
  const item = list.items[0], detail: any = await f.admin.summary(item.id);
  assert.match(item.id, /^d_[a-f0-9]{40}$/); assert.equal(item.mode, "diary");
  assert.equal(item.status, "ready"); assert.equal(item.available, true); assert.equal("text" in item, false);
  assert.equal(detail.text, f.entry.text); assert.equal(detail.diary_id, f.entry.id);
  assert.equal(detail.session_id, "one"); assert.equal(detail.session_name, "合成会话");
  assert.deepEqual(detail.source_ids, f.entry.source_ids); assert.equal(detail.covered_messages, 2);
  assert.equal(detail.source_revision, f.entry.source_revision); assert.equal(detail.model, "synthetic-model");
  assert.deepEqual(detail.time_range, { start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z" });
  assert.equal(detail.created_at, f.entry.created_at);
  assert.equal((await f.admin.catalog()).summaries.count, 1);
  assert.equal(await readFile(stateFile, "utf8"), before);
  const html = renderMemory({ state: { session: "one", memoryLoadedSession: "one", memoryLoadedTab: "summaries",
    memoryTab: "summaries", memoryDetails: list } });
  assert.match(html, /日记与摘要/); assert.match(html, /覆盖 2 条原文/); assert.match(html, /原始记录时间/);
  assert.match(html, /关闭自动整理只停止新生成，已有有效日记仍用于上下文/);
  assert.doesNotMatch(html, /普通模式|日记模式|兼容模式/);
});

test("disabling automatic diary generation keeps valid diaries available while excluded sources need rebuilding", async t => {
  const f = await archive(t), item = (await f.admin.summaries()).items[0];
  await f.memory.saveSessionMeta("one", { context: { diary_enabled: false } });
  let detail = await f.admin.summary(item.id);
  assert.equal(detail.status, "ready"); assert.equal(detail.available, true); assert.equal(detail.text, f.entry.text);
  assert.doesNotMatch(detail.status_message, /模式|仅供查看/);
  await f.engine.plugin("synthetic", () => {}).excludeInputs("one", [f.rows[0].id]);
  detail = await f.admin.summary(item.id);
  assert.equal(detail.status, "needs_rebuild"); assert.equal(detail.available, false);
  assert.match(detail.status_message, /来源已被排除/); assert.equal(detail.text, f.entry.text);
});

test("other persona diaries are isolated and legacy summaries stay viewable without new-mode injection", async t => {
  const f = await archive(t);
  await f.engine.commitDiary("one", { ...f.entry, id: "old-persona", scope: "persona:old" });
  const legacy = "p_" + createHash("sha256").update("one:session").digest("hex").slice(0, 40);
  await f.engine.summaryState("one", legacy, { mode: "long", covered: 1, last_id: f.rows[0].id, text: "合成旧版概览" });
  const items = (await f.admin.summaries()).items;
  const other = items.find((item: any) => item.diary_id === "old-persona")!;
  assert.equal(other.status, "other_scope"); assert.equal(other.available, false);
  const old = await f.admin.summary(legacy);
  assert.equal(old.mode, "long"); assert.equal(old.text, "合成旧版概览");
  assert.equal(old.status, "legacy"); assert.equal(old.available, false);
  assert.match(old.status_message, /不带入/);
});

test("matching persisted diary IDs in separate sessions produce distinct admin identifiers", async t => {
  const f = await archive(t);
  await f.memory.saveSessionMeta("two", { context: { diary_enabled: true } });
  await f.memory.appendEvent({ session: "two", type: "message", role: "user", text: "另一合成会话", ts: "2026-10-05T00:00:00Z" });
  const rows = await f.engine.contextRows("two");
  await f.engine.commitDiary("two", { ...f.entry, session: "two", text: "另一合成日记",
    source_ids: rows.map(row => row.id), source_revision: diarySourceRevision(rows), ...collectTimes(undefined, rows) });
  const items = (await f.admin.summaries()).items;
  assert.equal(items.length, 2); assert.notEqual(items[0].id, items[1].id);
  for (const item of items) assert.equal((await f.admin.summary(item.id)).session_id, item.session_id);
});
