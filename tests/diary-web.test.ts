/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { diarySourceRevision, type DiaryEntry } from "../core/memory-diary.ts";
import { collectTimes } from "../core/time.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-diary-web-");
  let app: any;
  t.after(async () => { if (app) await app.close(); });
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config", "config.json"), JSON.stringify({
    web: { host: "127.0.0.1", port: 0, password: "synthetic-test-password" },
    log: { level: "error" },
    providers: [{ id: "synthetic", name: "Synthetic", enabled: true, protocol: "openai-compatible",
      base_url: "http://127.0.0.1:1/v1", api_key: "", timeout_seconds: 2 }],
    models: [{ id: "synthetic-chat", name: "Synthetic chat", model: "synthetic-chat", provider: "synthetic",
      type: "chat", enabled: true, context_window: 262144, parameters: { max_tokens: 1024 } }],
    model_bindings: { chat: "synthetic-chat" },
    personas: { synthetic: { name: "合成人格", file: "memory/personas/synthetic.md", model: "synthetic-chat", permission: "off" } },
    channels: { web: { persona: "synthetic", permission: "off" } },
    memory: { root: "memory", diary_enabled: true, compression_trigger_percent: 80, compression_target_percent: 50 },
  }));
  app = await boot(root);
  const requests: any[] = [];
  app.llm.chat = async (request: any) => {
    requests.push(structuredClone(request.messages));
    return { text: "合成回复", toolCalls: [], finish_reason: "stop", usage: { prompt_tokens: 50, completion_tokens: 10 } };
  };
  app.modelConfig.listModels = async () => { throw Error("Configured capacity must not call model discovery"); };
  await app.memory.saveSessionMeta("one", { name: "合成日记会话", context: { diary_enabled: true } });
  for (let i = 0; i < 3; i++) await app.memory.appendEvent({ session: "one", type: "message",
    role: i % 2 ? "assistant" : "user", text: `SYNTHETIC_RAW_${i}_ONLY`, ts: `2026-10-0${i + 1}T00:00:00Z` });
  const rows = await app.memory.readSession("one");
  const entry: DiaryEntry = { version: 1, id: "synthetic-diary", session: "one", scope: "session",
    text: "我记下了合成对话中的共同结论，仍需在后续交流中核实。", source_ids: rows.slice(0, 2).map((row: any) => row.id),
    source_revision: diarySourceRevision(rows.slice(0, 2)), created_at: "2026-11-08T00:00:00Z",
    ...collectTimes(undefined, rows.slice(0, 2)), model: "synthetic-chat" };
  await app.memoryEngine.commitDiary("one", entry);
  await app.memoryEngine.settings("one", { ...(await app.memoryEngine.state("one")).settings, recall_tokens: 0 }, []);
  const url = "http://127.0.0.1:" + app.web.server.address().port;
  const login = await fetch(url + "/api/login", { method: "POST", body: JSON.stringify({ password: "synthetic-test-password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const get = (path: string) => fetch(url + path, { headers: { Cookie: cookie } });
  const post = (path: string, body: any, headers: Record<string, string> = {}) => fetch(url + path, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { root, app, requests, rows, entry, url, get, post };
}

async function setDiaryGeneration(f: Awaited<ReturnType<typeof fixture>>, enabled: boolean, historyEnabled = true) {
  const response = await f.post("/api/session/context", { id: "one", context: {
    diary_enabled: enabled, history_enabled: historyEnabled, include_facts: true, history_scope: "session",
    compression_trigger_percent: 80, compression_target_percent: 50,
  } });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test("explicit draft discovery refreshes context metadata without applying draft capacity", async t => {
  const f = await fixture(t);
  const configBefore = await readFile(join(f.root, "config/config.json"), "utf8");
  f.app.sessions.modelLimits.set("stale", { value: null, until: Date.now() + 60000 });
  f.app.modelConfig.listDraftModels = async () => ({ details: [{ id: "synthetic-chat", context_window: 1048576 }] });
  assert.equal((await f.post("/api/model-config/models/draft", { provider: {} })).status, 200);
  assert.equal(f.app.sessions.modelLimits.size, 0);
  const status = await (await f.get("/api/session/context?id=one")).json();
  assert.equal(status.model.context_window, 262144);
  assert.equal(status.model.limit_source, "configured");
  assert.equal(await readFile(join(f.root, "config/config.json"), "utf8"), configBefore);
  assert.equal(f.requests.length, 0);
});

test("diary HTTP views and explicit resume enforce authentication, origin, session guards and current scope", async t => {
  const f = await fixture(t);
  for (const path of ["/api/memory/summaries", "/api/memory/summary?id=synthetic", "/api/session/context?id=one"])
    assert.equal((await fetch(f.url + path)).status, 401);
  assert.equal((await fetch(f.url + "/api/memory/diary/retry", { method: "POST", body: '{"id":"one"}' })).status, 401);
  await f.app.memoryEngine.pauseDiary("one", "session", "合成暂停原因");
  await f.app.memoryEngine.pauseDiary("one", "persona:other", "其他范围的暂停");
  const listResponse = await f.get("/api/memory/summaries");
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).items[0];
  assert.equal(listed.mode, "diary"); assert.equal("text" in listed, false);
  const detailResponse = await f.get("/api/memory/summary?id=" + listed.id);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.text, f.entry.text); assert.deepEqual(detail.source_ids, f.entry.source_ids);
  assert.equal(detail.source_revision, f.entry.source_revision);
  assert.equal((await f.post("/api/memory/diary/retry", { id: "one" }, { Origin: "https://foreign.invalid" })).status, 403);
  for (const guard of ["locks", "blockedSessions", "channelOperations", "memoryMaintenance"]) {
    if (guard === "memoryMaintenance") f.app.sessions.memoryMaintenance = true;
    else if (guard === "channelOperations") f.app.sessions.channelOperations.set("one", 1);
    else f.app.sessions[guard].add("one");
    try {
      const refused = await f.post("/api/memory/diary/retry", { id: "one" });
      assert.equal(refused.status, 400); assert.match((await refused.json()).error, /会话正在处理/);
    } finally {
      if (guard === "memoryMaintenance") f.app.sessions.memoryMaintenance = false;
      else f.app.sessions[guard].delete("one");
    }
  }
  await setDiaryGeneration(f, false);
  const disabled = await f.post("/api/memory/diary/retry", { id: "one" });
  assert.equal(disabled.status, 400); assert.match((await disabled.json()).error, /先启用/);
  assert.equal((await f.app.memoryEngine.state("one")).diary_failures.session.reason, "合成暂停原因");
  await setDiaryGeneration(f, true);
  const resumed = await f.post("/api/memory/diary/retry", { id: "one", scope: "persona:other" });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  const status = await resumed.json();
  assert.equal(status.id, "one"); assert.equal(status.diary.paused, undefined);
  const failures = (await f.app.memoryEngine.state("one")).diary_failures;
  assert.equal(failures.session, undefined); assert.equal(failures["persona:other"].reason, "其他范围的暂停");
  assert.equal(f.requests.length, 0, "viewing or resuming must not generate a diary");
});

test("HTTP generation switch leaves valid diaries available and replacing their source messages", async t => {
  const f = await fixture(t);
  await f.app.memory.currentSession({ id: "one" });
  const before = await f.app.memoryEngine.state("one");
  const status = await setDiaryGeneration(f, false);
  assert.equal(status.policy.diary_enabled, false);
  assert.equal(status.diary.covered_messages, 2);
  assert.equal(status.diary.remaining_messages, 1);
  const listed = (await (await f.get("/api/memory/summaries")).json()).items[0];
  assert.equal(listed.available, true); assert.equal(listed.status, "ready");
  assert.match(listed.status_message, /自动生成开关只控制后续新日记/);
  assert.doesNotMatch(listed.status_message, /普通模式|日记模式|已存档供查看/);
  const detail = await (await f.get("/api/memory/summary?id=" + listed.id)).json();
  assert.equal(detail.available, true); assert.equal(detail.text, f.entry.text);
  assert.equal(detail.source_revision, f.entry.source_revision);
  assert.equal(f.requests.length, 0, "changing generation must not make a model request");
  await f.app.sessions.chat("one", "关闭生成后继续对话", () => {});
  assert.equal(f.requests.length, 1);
  const prompt = JSON.stringify(f.requests[0]);
  assert.ok(prompt.includes(f.entry.text)); assert.match(prompt, /SYNTHETIC_RAW_2_ONLY/);
  assert.doesNotMatch(prompt, /SYNTHETIC_RAW_[01]_ONLY/);
  assert.deepEqual((await f.app.memoryEngine.state("one")).diaries, before.diaries);
  assert.equal((await f.app.memoryEngine.state("one")).usage.memory.requests, 0);
  assert.equal(await f.app.memory.currentSession(), "one");
  await setDiaryGeneration(f, false, false);
  const noHistory = (await (await f.get("/api/memory/summaries")).json()).items[0];
  assert.equal(noHistory.available, false);
  assert.match(noHistory.status_message, /带入历史已关闭/);
  assert.deepEqual((await f.app.memoryEngine.state("one")).diaries, before.diaries);
});

test("HTTP backup restore retains the disabled generation switch and reuses existing diary context", async t => {
  const f = await fixture(t);
  await setDiaryGeneration(f, false);
  await f.app.memoryEngine.pauseDiary("one", "session", "合成暂停留档");
  const originalState = await f.app.memoryEngine.state("one");
  const backupResponse = await f.post("/api/memory/backup", {});
  assert.equal(backupResponse.status, 200);
  const backup = await backupResponse.json();
  await setDiaryGeneration(f, true);
  await f.app.memory.appendEvent({ session: "one", type: "message", role: "user", text: "SYNTHETIC_AFTER_BACKUP" });
  const restore = await f.post("/api/memory/restore", { id: backup.id });
  assert.equal(restore.status, 200, await restore.clone().text());
  const restored = await f.app.memoryEngine.state("one");
  assert.deepEqual(restored.diaries, originalState.diaries);
  assert.deepEqual(restored.diary_failures, originalState.diary_failures);
  assert.equal((await f.app.memory.readSession("one")).length, f.rows.length);
  const preview = await f.get("/api/session/context?id=one");
  assert.equal(preview.status, 200);
  const status = await preview.json();
  assert.equal(status.policy.diary_enabled, false);
  assert.equal(status.diary.count, 1); assert.equal(status.diary.covered_messages, 2);
  assert.equal(status.diary.remaining_messages, 1); assert.equal(status.diary.invalid, 0);
  const listed = (await (await f.get("/api/memory/summaries")).json()).items[0];
  assert.equal(listed.available, true); assert.equal(listed.status, "ready");
  assert.equal(listed.source_revision, f.entry.source_revision);
  assert.equal(f.requests.length, 0);
  await f.app.sessions.chat("one", "继续进行合成测试", () => {});
  assert.equal(f.requests.length, 1, "restored context needs only the ordinary chat request");
  const replay = JSON.stringify(f.requests[0]);
  assert.ok(replay.includes(f.entry.text)); assert.match(replay, /SYNTHETIC_RAW_2_ONLY/);
  assert.doesNotMatch(replay, /SYNTHETIC_RAW_[01]_ONLY|SYNTHETIC_AFTER_BACKUP/);
  const afterChat = await f.app.memoryEngine.state("one");
  assert.deepEqual(afterChat.diaries, originalState.diaries);
  assert.equal(afterChat.usage.memory.requests, 0);
});

async function rewriteBackupState(f: Awaited<ReturnType<typeof fixture>>, backup: string, change: (value: any) => void) {
  const directory = join(f.app.memoryAdmin.backupRoot, backup), path = "sessions/one/knowledge/state.json";
  const statePath = join(directory, "data", ...path.split("/"));
  const state = JSON.parse(await readFile(statePath, "utf8"));
  change(state);
  const content = JSON.stringify(state, null, 2);
  await writeFile(statePath, content);
  const manifestPath = join(directory, "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const item = manifest.files.find((entry: any) => entry.path === path);
  item.bytes = Buffer.byteLength(content); item.sha256 = createHash("sha256").update(content).digest("hex");
  manifest.bytes = manifest.files.reduce((sum: number, entry: any) => sum + entry.bytes, 0);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

test("restore rejects malformed diary references before replacing live files and excludes well-formed stale references from context", async t => {
  const f = await fixture(t), backup = await (await f.post("/api/memory/backup", {})).json();
  const statePath = join(f.app.memory.sessionDir("one"), "knowledge", "state.json");
  const before = await readFile(statePath, "utf8");
  await rewriteBackupState(f, backup.id, state => { state.diaries[0].source_ids[0] = "../invalid-source"; });
  const malformed = await f.post("/api/memory/restore", { id: backup.id });
  assert.equal(malformed.status, 400); assert.match((await malformed.json()).error, /日记.*损坏/);
  assert.equal(await readFile(statePath, "utf8"), before);
  assert.equal(f.app.sessions.memoryMaintenance, false);
  // Stale diaries are retained as audit records, so shape-valid stale sources can be restored.
  // Their source revision/membership is checked before any context injection.
  await rewriteBackupState(f, backup.id, state => { state.diaries[0].source_ids[0] = "missing-source"; });
  const stale = await f.post("/api/memory/restore", { id: backup.id });
  assert.equal(stale.status, 200, await stale.clone().text());
  const status = await (await f.get("/api/session/context?id=one")).json();
  assert.equal(status.diary.count, 0); assert.equal(status.diary.invalid, 1);
  assert.equal(status.diary.remaining_messages, 3);
  const listed = (await (await f.get("/api/memory/summaries")).json()).items[0];
  assert.equal(listed.status, "needs_rebuild"); assert.equal(listed.available, false);
  assert.equal(f.requests.length, 0);
});
