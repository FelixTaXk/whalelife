import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { ExecutionArchive, diagnosticSnapshot } from "../core/execution-archive.ts";
import { Logger } from "../core/logger.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-execution-archive-");
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "test", base_url: "https://unused.invalid/v1", api_key: "synthetic-secret-archive" }],
    models: [{ id: "chat", provider: "test", model: "test", type: "chat", enabled: true, context_window: 32000 }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "A", file: "a.md", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  const app = await boot(root);
  t.after(() => app.close());
  const id = await app.sessions.current();
  const requests: any[] = [];
  const model = (fn: (request: any) => any) => { app.llm.chat = async (request: any) => {
    requests.push(structuredClone({ messages: request.messages, tools: request.tools }));
    return { usage: { prompt_tokens: 20, completion_tokens: 5 }, ...await fn(request) };
  }; };
  const chat = (text: string, signal?: AbortSignal) => app.sessions.chat(id, text, () => {}, undefined, undefined,
    signal ? { channel: "web", persona: "a", permission: "full", signal } as any : undefined);
  return { app, root, id, model, requests, chat };
}
const tool = (name: string, args: any = {}) => ({ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) });
async function allRows(archive: ExecutionArchive, session: string, id: string) {
  const rows: any[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: any = await archive.inspect(session, { execution_id: id, offset, limit: 10 });
    rows.push(...page.entries); offset = page.next_offset;
  }
  return rows;
}

test("unbounded rounds record one ordered execution with usage and real tool outcomes, without automatic recall", async t => {
  const f = await fixture(t); let actions = 0, round = 0;
  f.app.tools.register({ name: "perform_step", schema: {}, danger: "safe", description: "step",
    run: () => ({ status: "sent", confirmed: true, step: ++actions, detail: "DIAGNOSTIC_ONLY_DETAIL" }) });
  f.model(() => ++round <= 9 ? { text: "", toolCalls: [tool("perform_step")] } : { text: "任务完成", toolCalls: [] });
  assert.equal(await f.chat("完成任务"), "任务完成");
  assert.equal(actions, 9);
  const list = await f.app.executionArchive.inspect(f.id);
  assert.equal(list.executions.length, 1);
  const rows = await allRows(f.app.executionArchive, f.id, list.executions[0].execution_id);
  assert.deepEqual(rows.map(r => r.seq), rows.map((_r, i) => i));
  assert.equal(rows.filter(r => r.kind === "tool_result").length, 9);
  assert.equal(rows.filter(r => r.kind === "model_result").length, 10);
  assert.equal(rows.filter(r => r.kind === "model_result").reduce((n, r) => n + r.data.usage.prompt_tokens, 0), 200);
  assert.equal(rows.at(-1).data.status, "completed");
  assert.equal((await f.app.memoryEngine.state(f.id)).usage.chat.requests, 10);
  f.model(() => ({ text: "你好", toolCalls: [] }));
  await f.chat("你好");
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes("DIAGNOSTIC_ONLY_DETAIL"));
  assert.equal((await f.app.memoryEngine.search(f.id, "DIAGNOSTIC_ONLY_DETAIL", { manual: true })).items.length, 0);
});

test("model independently reads selected archive pages, only this turn sees details and reads do not recursively copy archives", async t => {
  const f = await fixture(t);
  const old = await f.app.executionArchive.start(f.id, { kind: "direct_tool", tool: "past" });
  await old!.write("tool_result", { result: { failure: "ARCHIVED_FAILURE_DETAIL" } });
  await old!.end("failed");
  let round = 0;
  f.model(request => {
    if (++round === 1) {
      assert.ok(!JSON.stringify(request.messages).includes("ARCHIVED_FAILURE_DETAIL"));
      return { text: "", toolCalls: [tool("inspect_execution", { execution_id: old!.id })] };
    }
    assert.ok(JSON.stringify(request.messages).includes("ARCHIVED_FAILURE_DETAIL"));
    return { text: "我核对过上次执行，问题已定位。", toolCalls: [] };
  });
  await f.chat("继续处理任务"); // No user request to inspect: the model chose this tool.
  const latest = (await f.app.executionArchive.inspect(f.id)).executions.find((x: any) => x.execution_id !== old!.id);
  const rows = await allRows(f.app.executionArchive, f.id, latest.execution_id);
  assert.ok(!JSON.stringify(rows).includes("ARCHIVED_FAILURE_DETAIL"));
  assert.ok((await f.app.memory.readSession(f.id)).some((r: any) => r.text === "我核对过上次执行，问题已定位。"));
  assert.ok(!JSON.stringify(await f.app.memory.readSession(f.id)).includes("ARCHIVED_FAILURE_DETAIL"));
  f.model(() => ({ text: "日常聊天", toolCalls: [] }));
  await f.chat("聊点别的");
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes("ARCHIVED_FAILURE_DETAIL"));
  assert.equal((await f.app.memoryEngine.search(f.id, "ARCHIVED_FAILURE_DETAIL", { manual: true })).items.length, 0);
});

test("archive lookup is session-scoped, read-only, paginated and respects tool permissions", async t => {
  const f = await fixture(t), archive = f.app.executionArchive;
  const run = await archive.start("other_session", { kind: "private" });
  for (let i = 0; i < 12; i++) await run!.write("tool_result", { number: i });
  await run!.end("completed");
  const first: any = await archive.inspect("other_session", { execution_id: run!.id, limit: 3 });
  assert.equal(first.entries.length, 3); assert.equal(first.next_offset, 3);
  const next: any = await archive.inspect("other_session", { execution_id: run!.id, offset: 3, limit: 3 });
  assert.equal(next.entries[0].seq, 3);
  const tail: any = await archive.inspect("other_session", { execution_id: run!.id, tail: true, limit: 2 });
  assert.equal(tail.entries.length, 2); assert.equal(tail.entries.at(-1).kind, "finish");
  assert.equal((await archive.inspect("other_session")).executions[0].status, "completed");
  await assert.rejects(archive.inspect("other_session", { execution_id: run!.id, tail: true, offset: 0 }));
  await assert.rejects(archive.inspect(f.id, { execution_id: run!.id }));
  for (const args of [{ session: "other_session" }, { execution_id: "../other_session" }, { path: "config/config.json" }, { limit: 100 }, { offset: -1 }])
    await assert.rejects(archive.inspect(f.id, args));
  const denied = await f.app.tools.call("inspect_execution", {}, { id: f.id, permission: "off" });
  assert.equal(denied.ok, false);
  const controller = new AbortController(); controller.abort(Error("stop-read"));
  await assert.rejects(archive.inspect(f.id, {}, controller.signal), /stop-read/);
  const file = join(archive.root, "other_session", run!.id + ".jsonl");
  const before = await readFile(file, "utf8");
  await archive.inspect("other_session", { execution_id: run!.id });
  assert.equal(await readFile(file, "utf8"), before);
});

test("cancellation beyond six rounds terminates execution, keeps completed actions and frees the session", async t => {
  const f = await fixture(t), abort = new AbortController(); let actions = 0, round = 0;
  f.app.tools.register({ name: "step", description: "step", schema: {}, danger: "safe", run: () => ({ done: ++actions }) });
  f.model(request => {
    if (++round <= 8) return { text: "", toolCalls: [tool("step")] };
    abort.abort(Error("user-stop")); request.signal.throwIfAborted();
  });
  await assert.rejects(f.chat("长任务", abort.signal), /user-stop/);
  assert.equal(actions, 8);
  const run = (await f.app.executionArchive.inspect(f.id)).executions[0];
  const rows = await allRows(f.app.executionArchive, f.id, run.execution_id);
  assert.equal(rows.at(-1).data.status, "cancelled");
  assert.equal(f.app.sessions.locks.size, 0);
  f.model(() => ({ text: "恢复正常", toolCalls: [] }));
  assert.equal(await f.chat("继续聊天"), "恢复正常");
  assert.equal(actions, 8);
});

test("transient bodies remain absent from execution files while verified receipts and parameter fingerprints remain", async t => {
  const f = await fixture(t); let round = 0;
  f.app.tools.registerTransient({ name: "temporary", description: "temp", schema: {}, danger: "safe",
    run: () => ({ content: "TEMP_BODY_NEVER_ARCHIVE", receipt: { confirmed: true, id: "actual_receipt" } }) });
  f.model(() => ++round === 1 ? { text: "", toolCalls: [tool("temporary", { text: "TEMP_ARG_NEVER_ARCHIVE" })] } : { text: "已完成", toolCalls: [] });
  await f.chat("检查临时工具");
  const run = (await f.app.executionArchive.inspect(f.id)).executions[0];
  const raw = await readFile(join(f.app.executionArchive.root, f.id, run.execution_id + ".jsonl"), "utf8");
  assert.ok(!raw.includes("TEMP_BODY_NEVER_ARCHIVE")); assert.ok(!raw.includes("TEMP_ARG_NEVER_ARCHIVE"));
  assert.ok(raw.includes("actual_receipt")); assert.ok(raw.includes("arguments_digest"));
});

test("diagnostic redaction keeps useful failures and usage but removes secrets, addresses, binary and reasoning", () => {
  const snap = diagnosticSnapshot({ error: new Error("Failed with known-private-key at https://site.invalid/?token=private"),
    api_key: "unknown-secret", headers: { Cookie: "session=abc", Authorization: "Bearer secret" },
    bytes: new Uint8Array([1, 2]), content: "data:image/png;base64,AAAA password=hunter2",
    reasoning_content: "private thinking", usage: { prompt_tokens: 30, completion_tokens: 4 }, big: "x".repeat(10000) }, ["known-private-key"]);
  const raw = JSON.stringify(snap);
  for (const secret of ["known-private-key", "unknown-secret", "session=abc", "Bearer secret", "hunter2", "AAAA", "private thinking", "site.invalid"])
    assert.ok(!raw.includes(secret), secret);
  assert.equal(snap.usage.prompt_tokens, 30); assert.match(snap.error.message, /Failed/); assert.match(snap.big, /截断/);
  const headers = diagnosticSnapshot("upstream failure\nCookie: a=first-secret; b=second-secret\nAuthorization: Basic encoded-credential\nreason: denied");
  assert.ok(!headers.includes("first-secret")); assert.ok(!headers.includes("second-secret")); assert.ok(!headers.includes("encoded-credential"));
  assert.ok(headers.includes("reason: denied"));
});

test("archive failure does not break chat or replay completed tools", async t => {
  const f = await fixture(t); let actions = 0, round = 0;
  await mkdir(join(f.root, "logs"), { recursive: true });
  await writeFile(join(f.root, "logs/executions"), "unwritable-directory-fixture");
  f.app.tools.register({ name: "action", description: "action", schema: {}, danger: "safe", run: () => ({ done: ++actions }) });
  f.model(() => ++round === 1 ? { text: "", toolCalls: [tool("action")] } : { text: "已完成", toolCalls: [] });
  assert.equal(await f.chat("执行"), "已完成"); assert.equal(actions, 1);
});

test("session directory links cannot redirect diagnostic reads into another session", async () => {
  const root = await temporaryDirectory("whale-execution-link-");
  const archive = new ExecutionArchive(join(root, "executions"), new Logger(join(root, "logs"), { level: "error" }));
  const run = await archive.start("private_session", { kind: "private" });
  await symlink(join(root, "executions/private_session"), join(root, "executions/other_session"), "junction");
  await assert.rejects(archive.inspect("other_session", { execution_id: run!.id }), /目录无效/);
});

test("actual context capacity still stops model requests and records the reason without repeating a tool", async t => {
  const f = await fixture(t); let actions = 0;
  f.app.tools.register({ name: "large_result", description: "large", schema: {}, danger: "safe", run: () => { actions++; return "x".repeat(200000); } });
  f.model(() => ({ text: "", toolCalls: [tool("large_result")] }));
  await assert.rejects(f.chat("读取大结果"), /超出模型上下文预算/);
  assert.equal(actions, 1); assert.equal(f.requests.length, 1);
  const run = (await f.app.executionArchive.inspect(f.id)).executions[0];
  const rows = await allRows(f.app.executionArchive, f.id, run.execution_id);
  assert.ok(rows.some(r => r.kind === "blocked" && r.data.reason === "context_capacity_exceeded"));
  assert.equal(rows.at(-1).data.status, "failed");
});
