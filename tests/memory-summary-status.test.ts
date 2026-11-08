/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { MemoryAdmin } from "../core/memory-admin.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const key = (mode = "short") => (mode === "short" ? "s_" : "p_") +
  createHash("sha256").update("one:session").digest("hex").slice(0, 40);
async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-summary-status-");
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  t.after(async () => { await memory.queue; });
  await memory.init();
  await memory.saveSessionMeta("one", { name: "测试会话", context: { short_term_min_messages: 2 } });
  for (let i = 0; i < 3; i++) await memory.appendEvent({ session: "one", type: "message", role: "user",
    text: "合成记录" + i, ts: new Date(Date.now() - (i ? 0 : 30 * 86400000)).toISOString() });
  const engine = new MemoryEngine(memory), rows = await memory.readSession("one");
  const admin = new MemoryAdmin(memory, { root, locks: new Set(), config: { memory: {} } }, logger);
  const saved = { mode: "short", start_id: rows[1].id, last_id: rows[1].id, covered: 1,
    last_offset: 0, text: "有效摘要", updated_at: "2026-11-01T00:00:00Z" };
  return { root, memory, engine, admin, rows, saved };
}

test("summary list and detail use checkpoint text rather than an outdated display file", async t => {
  const f = await fixture(t);
  await f.engine.summaryState("one", key(), f.saved);
  await f.memory.writeSummary(key(), "陈旧展示副本", "one");
  const detail = await f.admin.summary(key()), item = (await f.admin.summaries()).items[0];
  assert.equal(detail.text, "有效摘要");
  assert.equal(detail.status, "ready");
  assert.equal(detail.available, true);
  assert.equal(detail.session_id, "one"); assert.equal(detail.session_name, "测试会话");
  assert.equal(detail.updated_at, f.saved.updated_at);
  assert.equal(item.bytes, Buffer.byteLength(detail.text));
  assert.equal(item.status, detail.status); assert.equal("text" in item, false);
  assert.equal(await readFile(await f.memory.summaryPath(key()), "utf8"), "陈旧展示副本", "inspection must not rewrite data");
});

test("an empty failed checkpoint never falls back to stale markdown, and exposes retry state", async t => {
  const f = await fixture(t), retry_at = Date.now() + 60000;
  await f.memory.writeSummary(key(), "已经失效的旧摘要", "one");
  await f.engine.summaryState("one", key(), { covered: 0, mode: "short", start_id: f.rows[1].id,
    retry_at, last_error: "摘要格式不符合要求", failure_count: 1 });
  const detail = await f.admin.summary(key()), item = (await f.admin.summaries()).items[0];
  assert.equal(detail.text, ""); assert.equal(detail.bytes, 0); assert.equal(detail.available, false);
  assert.equal(detail.status, "failed"); assert.equal(item.status, "failed");
  assert.equal(detail.retry_at, retry_at); assert.equal(detail.last_error, "摘要格式不符合要求");
  assert.doesNotMatch(JSON.stringify(item), /已经失效的旧摘要/);
});

test("a moved short-term window marks preserved old text as needing rebuild", async t => {
  const f = await fixture(t);
  await f.engine.summaryState("one", key(), { ...f.saved, start_id: f.rows[0].id, covered: 2 });
  const detail = await f.admin.summary(key());
  assert.equal(detail.text, "有效摘要"); assert.equal(detail.status, "needs_rebuild"); assert.equal(detail.available, false);
  assert.match(detail.status_message, /不会作为当前短期摘要带入/);
});

test("a failed update retains the previous valid checkpoint without claiming the update succeeded", async t => {
  const f = await fixture(t);
  await f.engine.summaryState("one", key(), { ...f.saved, last_error: "摘要返回了空正文", retry_at: Date.now() + 60000 });
  const detail = await f.admin.summary(key());
  assert.equal(detail.text, "有效摘要"); assert.equal(detail.available, true); assert.equal(detail.status, "update_failed");
  assert.match(detail.status_message, /上次有效正文/);
});

test("checkpoints without markdown projections remain visible, including empty first attempts", async t => {
  const f = await fixture(t);
  await f.engine.summaryState("one", key(), { covered: 0, mode: "short", start_id: f.rows[1].id });
  await f.engine.summaryState("one", key("long"), { covered: 1, last_id: f.rows[0].id, mode: "long", text: "长期概览" });
  const items = (await f.admin.summaries()).items;
  assert.equal(items.length, 2);
  assert.equal(items.find(x => x.id === key())?.status, "pending");
  assert.equal((await f.admin.summary(key("long"))).text, "长期概览");
});

test("excluded input revisions suppress saved prose instead of reviving its projection", async t => {
  const f = await fixture(t);
  await f.memory.appendEvent({ session: "one", type: "message", role: "user", text: "技术输入",
    channel: "plugin", account: "dummy", origin: { plugin: "dummy", action: "测试" } });
  const row = (await f.memory.readSession("one")).at(-1);
  await f.engine.summaryState("one", key("long"), { covered: 1, mode: "long", last_id: row.id, text: "待排除的概览" });
  await f.memory.writeSummary(key("long"), "待排除的展示副本", "one");
  await f.engine.plugin("dummy", () => {}).excludeInputs("one", [row.id]);
  const detail = await f.admin.summary(key("long"));
  assert.equal(detail.text, ""); assert.equal(detail.available, false); assert.equal(detail.status, "pending");
});

test("other persona scopes are labeled without comparing them to the current session window", async t => {
  const f = await fixture(t), other = "s_" + "a".repeat(40);
  await f.engine.summaryState("one", other, { ...f.saved, start_id: f.rows[0].id });
  const detail = await f.admin.summary(other);
  assert.equal(detail.text, "有效摘要"); assert.equal(detail.status, "other_scope");
  assert.equal(detail.available, false); assert.doesNotMatch(detail.status_message, /覆盖范围已变化/);
});

test("legacy unowned summary files still support existing list/detail callers", async t => {
  const f = await fixture(t);
  await f.memory.writeSummary("legacy", "旧版正文");
  const detail = await f.admin.summary("legacy");
  assert.equal(detail.text, "旧版正文"); assert.equal(detail.status, "legacy");
  assert.equal((await f.admin.summaries()).items[0].id, "legacy");
  await assert.rejects(f.admin.summary("../config"), /ID 无效/);
  await assert.rejects(f.admin.summary("missing"), /摘要不存在/);
});

test("the current persona scope uses its own matching history and reports expired old scopes separately", async t => {
  const f = await fixture(t), prompt = "合成人格";
  await writeFile(join(f.root, "persona.md"), prompt);
  const revision = createHash("sha256").update(JSON.stringify(["a", prompt])).digest("hex");
  const currentKey = "s_" + createHash("sha256").update("one:" + revision).digest("hex").slice(0, 40);
  f.admin.sessions.config = { personas: { a: { file: "persona.md", provider: "fake" } },
    providers: [{ id: "fake", model: "test", base_url: "https://unused.invalid/v1" }],
    channels: { web: { persona: "a" } }, memory: {} } as any;
  await f.memory.saveSessionMeta("one", { context: { history_scope: "persona", short_term_min_messages: 2 } });
  await f.memory.appendEvent({ session: "one", type: "message", role: "user", text: "当前人格消息", persona_revision: revision });
  const row = (await f.memory.readSession("one")).at(-1);
  await f.engine.summaryState("one", currentKey, { ...f.saved, start_id: row.id, last_id: row.id });
  await f.engine.summaryState("one", key(), f.saved);
  assert.equal((await f.admin.summary(currentKey)).status, "ready");
  assert.equal((await f.admin.summary(currentKey)).available, true);
  assert.equal((await f.admin.summary(key())).status, "other_scope");
});

test("inspection is read-only and usage changes do not refresh an existing summary's timestamp", async t => {
  const f = await fixture(t);
  await f.engine.summaryState("one", key(), { ...f.saved, updated_at: undefined });
  await f.memory.writeSummary(key(), "展示正文", "one");
  const file = await f.memory.summaryPath(key()), displayTime = (await stat(file)).mtime.toISOString();
  await f.engine.usage("one", "chat", { prompt_tokens: 10, completion_tokens: 2 });
  async function snapshot(path: string): Promise<any> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) Object.assign(result, await snapshot(child));
      else result[child] = createHash("sha256").update(await readFile(child)).digest("hex");
    }
    return result;
  }
  const before = await snapshot(f.memory.root);
  assert.equal((await f.admin.summary(key())).updated_at, displayTime);
  await f.admin.summaries();
  assert.deepEqual(await snapshot(f.memory.root), before);
});

test("summary UI distinguishes failed/current/history records and escapes status data", async () => {
  const { renderMemory } = await import(new URL("../core/ui/memory.js", import.meta.url).href);
  const html = renderMemory({ state: { session: "one", memorySession: "one", memoryTab: "summaries",
    memoryLoadedTab: "summaries", memoryLoadedSession: "one",
    memoryDetails: { items: [{ id: key(), mode: "short", bytes: 0, status: "failed", session_name: "<test-session>",
      status_message: "当前没有可用摘要", last_error: "<unsafe-error>", retry_at: Date.now() + 60000 }] } } });
  assert.match(html, /整理失败/); assert.match(html, /当前没有可用摘要/); assert.match(html, /查看状态/);
  assert.match(html, /&lt;test-session&gt;/); assert.match(html, /&lt;unsafe-error&gt;/);
  assert.doesNotMatch(html, /<unsafe-error>|<test-session>|旧摘要保留至下次生成/);
});
