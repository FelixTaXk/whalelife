/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Channels } from "../core/channels.ts";
import { Sessions } from "../core/session.ts";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { EmptyModelResponseError } from "../core/model-response-error.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const privateText = "SYNTHETIC_ERROR_PRIVATE_BODY";
const privateKey = "synthetic-error-secret-key";
const message = (messageId: string) => ({ peer: "friend", sender: "human", messageId, text: "请完成任务" });
const answer = () => ({ text: "已完成的最终回复", toolCalls: [] });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function diskText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? diskText(join(root, entry.name)) : readFile(join(root, entry.name), "utf8")))).join("\n");
}
async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-channel-error-reporting-");
  const releases: (() => void)[] = [];
  const logs: unknown[] = [], requests: unknown[] = [], deliveries: unknown[] = [], calls: unknown[] = [];
  const logger: any = { secrets: [privateKey], info() {}, warn(...args: unknown[]) { logs.push(args); }, error(...args: unknown[]) { logs.push(args); } };
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  await writeFile(join(root, "a.md"), "合成人格");
  const config: any = {
    providers: [{ id: "demo", model: "chat", base_url: "https://unused.invalid/v1", context_window: 300000 }],
    personas: { a: { name: "A", file: "a.md", provider: "demo", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" }, mock: { persona: "a", permission: "full" } },
    memory: { recent_lines: 200, budget_tokens: 200000, include_summary: false },
  };
  const engine = new MemoryEngine(memory);
  let respond: (input: any) => any = answer;
  const services: any = { memory, memoryEngine: engine, logger,
    llm: { chat: async (input: any) => { requests.push(input); return respond(input); } },
    tools: {
      entries: new Map(),
      list: () => [{ type: "function", function: { name: "temporary_read", parameters: { type: "object" } } }],
      call: async (...args: unknown[]) => { calls.push(args); return { ok: true, result: privateText }; },
    },
  };
  const sessions = new Sessions(root, config, services);
  engine.maintenance = id => sessions.memoryMaintenance || !!(id && sessions.blockedSessions.has(id));
  const channels = new Channels(memory, sessions, config);
  t.after(async () => { releases.forEach(release => release()); await Promise.all([channels.close(), sessions.close()]); });
  const handle = channels.register({ id: "mock", account: "test", persona: "a", permission: "full", send: async value => { deliveries.push(value); } });
  return { root, memory, services, sessions, channels, handle, requests, calls, deliveries, logs,
    respond: (fn: typeof respond) => { respond = fn; },
    gate: () => { const gate = deferred(); releases.push(gate.resolve); return gate; },
  };
}

test("openTurn keeps safe failure attribution and its durable duplicate without replay", async t => {
  const f = await fixture(t);
  f.respond(() => { throw Error("模型服务返回 HTTP 429：服务额度或余额不足；insufficient_quota"); });
  const turn = await f.handle.openTurn!(message("model-error"));
  const result = await turn.result();
  assert.equal(result.status, "generation_failed");
  assert.match(result.error!, /生成或会话记录阶段/);
  assert.match(result.error!, /HTTP 429/);
  assert.match(result.error!, /服务额度或余额不足/);
  assert.match(result.error!, /不要自动重跑/);
  const duplicate = await f.handle.receive(message("model-error"));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.error, result.error);
  await assert.rejects(f.handle.retry("friend", "model-error"), /不能重放/);
  assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 0);
});

test("openTurn stores only fixed categories for unknown errors, not credentials, paths or copied conversation", async t => {
  const f = await fixture(t);
  f.respond(() => { throw Object.assign(Error(`${privateKey} ${privateText} C:\\Users\\private-user\\secret.txt https://private.invalid/?token=unknown ${"x".repeat(10000)}`), { code: "ENOSPC" }); });
  const result = await (await f.handle.openTurn!(message("private-error"))).result();
  assert.equal(result.status, "generation_failed");
  assert.match(result.error!, /ENOSPC/);
  assert.ok(result.error!.length < 512);
  const stored = await diskText(join(f.root, "memory"));
  for (const text of [privateKey, privateText, "private-user", "private.invalid"])
    assert.ok(!JSON.stringify([result, f.logs, stored]).includes(text), text);
});

test("openTurn preserves each fixed empty-response cause without trusting a mutated message", async t => {
  const f = await fixture(t);
  for (const [finish, reasoning] of [["length", false], ["content_filter", false], ["insufficient_system_resource", false],
    ["aborted", false], ["stop", true], ["stop", false]] as const) {
    const original = new EmptyModelResponseError(finish, reasoning), expected = original.message;
    original.message = `${privateText} ${privateKey}`;
    f.respond(() => { throw original; });
    const result = await (await f.handle.openTurn!(message("empty-" + original.reason))).result();
    assert.equal(result.status, "generation_failed"); assert.ok(result.error!.includes(expected));
    assert.doesNotMatch(result.error!, new RegExp(privateText + "|" + privateKey));
  }
  assert.equal(f.requests.length, 6); assert.equal(f.deliveries.length, 0);
  assert.ok(!(await diskText(join(f.root, "memory"))).includes(privateText));
});

test("unknown exception objects and hostile message getters cannot break the failure receipt", async t => {
  const f = await fixture(t), hostile = Error();
  Object.defineProperty(hostile, "message", { get() { throw Error(privateText); } });
  for (const [index, error] of [null, { message: privateText, toString() { throw Error(privateKey); } }, hostile].entries()) {
    f.respond(() => { throw error; });
    const result = await (await f.handle.openTurn!(message("unknown-" + index))).result();
    assert.equal(result.status, "generation_failed"); assert.match(result.error!, /原始错误未保存/);
    assert.doesNotMatch(result.error!, new RegExp(privateText + "|" + privateKey));
  }
  assert.equal(f.requests.length, 3); assert.equal(f.deliveries.length, 0);
});

test("openTurn retains the live transient state when generation rejects before a final receipt exists", async t => {
  const f = await fixture(t);
  f.services.tools.entries.set("temporary_read", { transientResult: true });
  f.respond(() => {
    if (f.requests.length === 1) return { text: "", toolCalls: [{ id: "temporary", name: "temporary_read", arguments: "{}" }] };
    throw Error(`模型服务返回 HTTP 401：服务拒绝了认证信息；${privateText}`);
  });
  const result = await (await f.handle.openTurn!(message("temporary-error"))).result();
  assert.equal(result.status, "generation_failed");
  assert.match(result.error!, /生成或会话记录阶段/);
  assert.match(result.error!, /临时资料|原始错误未保存/);
  assert.doesNotMatch(result.error!, /HTTP 401|服务拒绝了认证信息/);
  assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.deliveries.length, 0);
  assert.equal((await f.handle.receive(message("temporary-error"))).error, result.error);
  assert.equal(f.requests.length, 2);
  assert.ok(!(await diskText(join(f.root, "memory"))).includes(privateText));
});

test("generated-receipt failure reports its stage while preserving the existing status, reply and retry refusal", async t => {
  const f = await fixture(t);
  const original = (f.channels as any).save.bind(f.channels);
  let failed = false;
  (f.channels as any).save = async (...args: any[]) => {
    if (!failed && args[2].status === "generated") { failed = true; throw Object.assign(Error("private storage path"), { code: "ENOSPC" }); }
    return original(...args);
  };
  const result = await (await f.handle.openTurn!(message("save-error"))).result();
  assert.equal(result.status, "generation_failed");
  assert.equal(result.text, answer().text); assert.equal(result.transient, undefined);
  assert.match(result.error!, /回复回执保存阶段/); assert.match(result.error!, /ENOSPC/);
  assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 0);
  const duplicate = await f.handle.receive(message("save-error"));
  assert.equal(duplicate.error, result.error); assert.equal(duplicate.text, result.text);
  await assert.rejects(f.handle.retry("friend", "save-error"), /不能重放/);
});

test("a delivery admission failure is not reported as a missing model reply", async t => {
  const f = await fixture(t), save = (f.channels as any).save.bind(f.channels);
  (f.channels as any).save = async (...args: any[]) => {
    const result = await save(...args);
    if (args[2].status === "generated") f.sessions.blockedSessions.add(args[0]);
    return result;
  };
  const result = await (await f.handle.openTurn!(message("delivery-admission"))).result();
  f.sessions.blockedSessions.delete(result.sessionId);
  assert.equal(result.status, "generation_failed"); assert.equal(result.text, answer().text);
  assert.match(result.error!, /最终回复投递阶段/); assert.match(result.error!, /会话正在处理/);
  assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 0);
});

test("queued cancellation is attributed before generation and never saves the caller's raw reason", async t => {
  const f = await fixture(t), entered = deferred(), release = f.gate(), controller = new AbortController();
  await f.memory.saveSessionMeta("shared", {}); await f.handle.bind("friend", "shared");
  f.respond(async () => { entered.resolve(); await release.promise; return answer(); });
  const blocker = f.sessions.chat("shared", "占用执行位", () => {});
  void blocker.catch(() => {}); // Cleanup can cancel it if an earlier assertion fails.
  await entered.promise;
  const turn = await f.handle.openTurn!(message("queued-error"), { signal: controller.signal });
  controller.abort(Error(privateText));
  const result = await turn.result();
  assert.equal(result.status, "generation_failed"); assert.match(result.error!, /等待执行阶段/);
  assert.match(result.error!, /已取消或渠道停用/); assert.doesNotMatch(result.error!, new RegExp(privateText));
  assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 0);
  release.resolve(); await blocker;
  const rows = await f.memory.readSession(turn.sessionId);
  assert.ok(rows.some(row => row.external_message_id === "queued-error" && row.input_text === message("queued-error").text));
});

test("legacy receive failures retain their previous message and rejection boundaries", async t => {
  const f = await fixture(t), error = Error("legacy synthetic failure");
  f.respond(() => { throw error; });
  assert.equal((await f.handle.receive(message("legacy"))).error, error.message);
  f.respond(answer);
  const save = (f.channels as any).save.bind(f.channels);
  (f.channels as any).save = async (...args: any[]) => {
    if (args[2].status === "generated") throw error;
    return save(...args);
  };
  await assert.rejects(f.handle.receive(message("legacy-save")), value => value === error);
  assert.equal(f.deliveries.length, 0);
});
