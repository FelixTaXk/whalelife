/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { resolveModel } from "../core/model-config.ts";
import { writeDiary } from "../core/memory-diary.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

type Request = { path: string; body: any };
type Reply = { json?: any; raw?: string; chunks?: any[] };
const usage = (prompt: number, completion: number) => ({
  prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
  prompt_cache_hit_tokens: prompt - 2, prompt_cache_miss_tokens: 2,
  completion_tokens_details: { reasoning_tokens: 1 },
});
const answer = (text: string, measured = usage(17, 3)): Reply => ({ chunks: [
  { choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] },
  { choices: [], usage: measured },
] });
const toolReply = (name: string, args: any, measured = usage(31, 5)): Reply => ({ chunks: [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "synthetic-call-1", type: "function",
    function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] },
  { choices: [], usage: measured },
] });
function send(response: ServerResponse, reply: Reply) {
  if (reply.raw !== undefined) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(reply.raw);
    return;
  }
  if (reply.json !== undefined) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.json));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of reply.chunks ?? []) response.write("data: " + JSON.stringify(chunk) + "\n\n");
  response.end("data: [DONE]\n\n");
}

async function fixture(t: TestContext, enabled: boolean | "default" = true) {
  const base = await temporaryDirectory("whale-diagnostic-integration-");
  // Capture is deliberately outside the application root and its memory/log directories.
  const root = join(base, "host"), directory = join(base, "capture");
  const requests: Request[] = [], serverErrors: unknown[] = [];
  let app: any, respond: (request: Request, index: number) => Reply = () => answer("合成回复");
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const received = { path: request.url ?? "", body: raw ? JSON.parse(raw) : undefined };
      requests.push(received);
      send(response, respond(received, requests.length - 1));
    } catch (error) {
      serverErrors.push(error);
      response.writeHead(500); response.end("synthetic fixture failure");
    }
  });
  t.after(async () => {
    try { await app?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => {
        if (error && (error as any).code !== "ERR_SERVER_NOT_RUNNING") reject(error); else resolve();
      }));
    }
    assert.deepEqual(serverErrors, [], "the synthetic provider must finish without fixture errors");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config: any = {
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "fixture", name: "Synthetic local provider", protocol: "openai-compatible",
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-diagnostic-api-key", enabled: true,
      timeout_seconds: 10 }],
    models: [
      { id: "chat", name: "Synthetic chat", provider: "fixture", model: "synthetic-chat", type: "chat",
        enabled: true, context_window: 32000 },
      { id: "embedding", name: "Synthetic embedding", provider: "fixture", model: "synthetic-embedding",
        type: "embedding", enabled: true, dimensions: 3 },
    ],
    model_bindings: { chat: "chat" }, personas: { a: { name: "Synthetic persona", file: "persona.md", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
    ...(enabled === "default" ? {} : { diagnostics: { enabled, directory } }),
  };
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config/config.json"), JSON.stringify(config));
  app = await boot(root);
  return { app, root, directory, requests, config,
    respond(fn: typeof respond) { respond = fn; },
    async events() {
      await app.diagnostics.flush();
      const files = (await readdir(directory)).filter(name => /\.(jsonl|ndjson)$/.test(name)).sort();
      assert.ok(files.length, "enabled diagnostics should produce protocol files");
      const events = (await Promise.all(files.map(file => readFile(join(directory, file), "utf8"))))
        .flatMap(text => text.split("\n").filter(Boolean).map(line => JSON.parse(line)));
      assert.ok(events.every(event => event.schema_version === 1 && event.event_id && event.instance_id));
      return events;
    },
  };
}
async function treeText(directory: string): Promise<string> {
  const parts = await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry =>
    entry.isDirectory() ? treeText(join(directory, entry.name)) : readFile(join(directory, entry.name), "utf8")));
  return parts.join("\n");
}
function finalUsage(events: any[], requestId: string) {
  const rows = events.filter(event => event.kind === "request.usage" && event.request_id === requestId && event.data.stage === "final");
  assert.equal(rows.length, 1, "each actual request has exactly one final usage snapshot");
  assert.equal(rows[0].data.mode, "snapshot");
  return rows[0].data.usage;
}

test("a tool continuation preserves one execution and independent actual requests and usage", async t => {
  const f = await fixture(t), id = await f.app.sessions.current();
  f.app.tools.register({ name: "diagnostic_echo", description: "Synthetic echo", schema: { text: { type: "string" } },
    danger: "safe", run: (args: any) => ({ echoed: args.text }) });
  f.respond((_request, index) => index === 0 ? toolReply("diagnostic_echo", { text: "合成工具参数" }) : answer("工具已完成", usage(49, 7)));
  const streamed: string[] = [];
  assert.equal(await f.app.sessions.chat(id, "运行合成工具", (text: string) => streamed.push(text)), "工具已完成");
  assert.equal(streamed.join(""), "工具已完成");
  assert.equal(f.requests.length, 2);
  const events = await f.events(), starts = events.filter(event => event.kind === "request.start");
  assert.equal(starts.length, 2);
  assert.equal(new Set(starts.map(event => event.request_id)).size, 2);
  assert.equal(new Set(starts.map(event => event.execution_id)).size, 1);
  assert.ok(starts[0].execution_id);
  assert.ok(starts.every(event => event.session_id === id));
  assert.deepEqual(starts.map(event => event.data.body), f.requests.map(request => request.body));
  assert.deepEqual(finalUsage(events, starts[0].request_id), usage(31, 5));
  assert.deepEqual(finalUsage(events, starts[1].request_id), usage(49, 7));
  assert.equal(events.filter(event => event.kind === "execution.start" && event.execution_id === starts[0].execution_id).length, 1);
  assert.equal(events.filter(event => event.kind === "execution.end" && event.execution_id === starts[0].execution_id).length, 1);
  for (const kind of ["tool.start", "tool.end", "context.change"]) {
    assert.ok(events.some(event => event.kind === kind && event.execution_id === starts[0].execution_id), kind);
  }
  assert.ok(events.some(event => event.kind === "tool.end" && JSON.stringify(event.data).includes("合成工具参数")));
  assert.equal(events.filter(event => event.kind === "request.end" && event.data.status === "completed").length, 2);
  assert.ok(!JSON.stringify(events).includes("synthetic-diagnostic-api-key"), "connection credentials are never exported");
});

test("default-off and explicitly-off capture leave the same serialized request, response and request count", async t => {
  const results: any[] = [];
  for (const enabled of ["default", false, true] as const) {
    const f = await fixture(t, enabled);
    const reply = await f.app.llm.chat({ model: "chat", messages: [{ role: "user", content: "固定合成请求" }] });
    results.push({ requests: f.requests, reply: { text: reply.text, toolCalls: reply.toolCalls, usage: reply.usage } });
    if (enabled === true) assert.equal((await f.events()).filter(event => event.kind === "request.start").length, 1);
    else {
      await f.app.diagnostics?.flush();
      await assert.rejects(readdir(f.directory), { code: "ENOENT" });
      assert.ok(!(await readdir(f.root)).includes("diagnostics"), "disabled capture creates no implicit output directory");
    }
  }
  assert.equal(results[0].requests.length, 1);
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
});

test("temporary tool content is captured independently and never spreads into memory or the next dialogue", async t => {
  const f = await fixture(t), id = await f.app.sessions.current(), marker = "SYNTHETIC_DIAGNOSTIC_TEMPORARY_BODY";
  f.app.tools.registerTransient({ name: "diagnostic_temporary", description: "Read temporary synthetic material", schema: {},
    danger: "safe", run: () => ({ content: marker, receipt: { action: "read", count: 1 } }) });
  f.respond((_request, index) => index === 0 ? toolReply("diagnostic_temporary", {}) : answer("已查看，结果正常。"));
  await f.app.sessions.chat(id, "查看合成资料", () => {});
  assert.ok(JSON.stringify(f.requests[1].body.messages).includes(marker), "continuation receives the actual tool result");
  const events = await f.events();
  assert.ok(events.some(event => event.kind === "tool.end" && JSON.stringify(event.data).includes(marker)));
  assert.ok(events.some(event => event.kind === "request.start" && JSON.stringify(event.data.body).includes(marker)));
  assert.ok(!(await treeText(join(f.root, "memory"))).includes(marker));
  assert.ok(!(await treeText(join(f.root, "logs"))).includes(marker), "ordinary execution archives retain their old isolation");
  await f.app.sessions.chat(id, "继续普通对话", () => {});
  assert.equal(f.requests.length, 3);
  assert.ok(!JSON.stringify(f.requests[2].body).includes(marker), "diagnostic capture does not reinsert material into later prompts");
});

test("chat and embedding connection probes export their own raw response usage", async t => {
  const f = await fixture(t), embeddingUsage = { prompt_tokens: 9, total_tokens: 9, vendor_extension: { measured: 9 } };
  f.respond(request => request.path.endsWith("/embeddings")
    ? { json: { data: [{ embedding: [0.1, 0.2, 0.3] }], usage: embeddingUsage } }
    : { json: { choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: usage(11, 2) } });
  assert.equal((await f.app.modelConfig.testModel("chat")).ok, true);
  assert.equal((await f.app.modelConfig.testModel("embedding")).dimensions, 3);
  const events = await f.events(), starts = events.filter(event => event.kind === "request.start");
  assert.equal(f.requests.length, 2);
  assert.equal(starts.length, 2);
  assert.equal(new Set(starts.map(event => event.request_id)).size, 2);
  assert.ok(starts.every(event => event.session_id === undefined), "a connection probe is not a dialogue session");
  assert.deepEqual(starts.map(event => event.data.body), f.requests.map(request => request.body));
  assert.deepEqual(finalUsage(events, starts[0].request_id), usage(11, 2));
  assert.deepEqual(finalUsage(events, starts[1].request_id), embeddingUsage);
  assert.ok(events.filter(event => event.kind === "request.end").every(event => event.data.http_status === 200));
});

test("invalid and oversized JSON probes retain observed response evidence without retrying or inventing usage", async t => {
  const f = await fixture(t), limit = 2 * 1024 * 1024;
  const malformed = '{"choices":[{"message":{"content":"SYNTHETIC_INCOMPLETE_JSON';
  const oversized = JSON.stringify({ choices: [{ message: { content: "SYNTHETIC_OVERSIZED_BODY_" + "x".repeat(limit + 65536) } }] });
  const responses = [malformed, oversized];
  f.respond((_request, index) => ({ raw: responses[index] }));
  for (let index = 0; index < responses.length; index++) {
    await assert.rejects(f.app.modelConfig.testModel("chat"), (error: any) => {
      assert.equal(error.status, 502);
      assert.match(error.message, /无效或过大的 JSON/);
      return true;
    });
    assert.equal(f.requests.length, index + 1, "capture failure must not retry the actual HTTP request");
  }
  const events = await f.events(), starts = events.filter(event => event.kind === "request.start");
  assert.equal(starts.length, 2);
  assert.equal(new Set(starts.map(event => event.request_id)).size, 2);
  assert.equal(events.filter(event => event.kind === "request.usage").length, 0, "unparsed JSON cannot supply trustworthy usage");
  for (let index = 0; index < starts.length; index++) {
    const related = events.filter(event => event.request_id === starts[index].request_id);
    const endings = related.filter(event => event.kind === "request.end");
    assert.equal(endings.length, 1);
    assert.equal(endings[0].data.status, "failed");
    assert.equal(endings[0].data.http_status, 200, "preserve actual HTTP status independently of parse failure");
    assert.equal(endings[0].data.usage, undefined);
    const evidence = related.find(event => event.kind === "response.chunk" && typeof event.data.raw === "string");
    assert.ok(evidence, "already observed invalid response bytes remain available for diagnosis");
    assert.equal(evidence.data.limit_bytes, limit);
    assert.equal(evidence.data.truncated, index === 1);
    assert.equal(evidence.data.complete, index === 0);
    if (index === 0) {
      assert.equal(evidence.data.raw, malformed);
      assert.equal(evidence.data.observed_bytes, Buffer.byteLength(malformed));
    } else {
      assert.ok(evidence.data.observed_bytes > limit, "overflow reports the bytes actually observed");
      assert.ok(evidence.data.observed_bytes <= Buffer.byteLength(oversized));
      assert.ok(evidence.data.raw.includes("SYNTHETIC_OVERSIZED_BODY_"));
      assert.ok(oversized.startsWith(evidence.data.raw), "retained data is an actual response prefix");
      assert.ok(Buffer.byteLength(evidence.data.raw) <= evidence.data.observed_bytes);
    }
  }
});

test("plugin direct model calls have trusted ownership but no invented session, and connection reads create no request", async t => {
  const f = await fixture(t);
  let plugin: any;
  await f.app.runtime.load("diagnostic-probe", { id: "diagnostic-probe", name: "Synthetic diagnostics probe", version: "1.0.0", apiVersion: "1" },
    (ctx: any) => { plugin = ctx; });
  assert.equal(f.app.runtime.records.get("diagnostic-probe").status, "active");
  const before = (await f.events()).filter(event => event.kind === "request.start").length;
  assert.equal(plugin.models.connection("chat").model, "synthetic-chat");
  assert.equal(f.requests.length, 0);
  assert.equal((await f.events()).filter(event => event.kind === "request.start").length, before);
  const reply = await plugin.llm.chat({ model: "chat", messages: [{ role: "user", content: "插件的合成请求" }], plugin_id: "forged-owner" });
  assert.equal(reply.text, "合成回复");
  const events = await f.events(), starts = events.filter(event => event.kind === "request.start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].plugin_id, "diagnostic-probe");
  assert.equal(starts[0].session_id, undefined);
  assert.ok(starts[0].execution_id && starts[0].request_id);
  assert.ok(events.filter(event => event.request_id === starts[0].request_id)
    .every(event => event.plugin_id === "diagnostic-probe" && event.session_id === undefined));
  assert.equal(f.requests.length, 1);
});

test("diary generation uses the real transport and records its purpose and independent raw usage", async t => {
  const f = await fixture(t), id = await f.app.sessions.current();
  await f.app.memory.appendEvent({ session: id, type: "message", role: "user", text: "这是一段用于测试日记的合成原始经历。".repeat(100) });
  await f.app.memory.appendEvent({ session: id, type: "message", role: "assistant", text: "我已听到这段合成经历，后续仍按原文理解。".repeat(100) });
  const rows = await f.app.memory.readSession(id), measured = usage(227, 23);
  f.respond(() => answer(JSON.stringify({ diary: "用户描述了一段合成经历，我回复已知悉。" }), measured));
  const result = await writeDiary({ services: f.app, id, scope: "session", rows,
    provider: resolveModel(f.app.config, "chat"), limit: 32000, outputTokens: 512 });
  assert.equal(result.status, "written", result.reason);
  const events = await f.events(), starts = events.filter(event => event.kind === "request.start");
  assert.equal(f.requests.length, 1);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].data.purpose ?? starts[0].purpose, "memory_diary");
  assert.ok(starts[0].execution_id && starts[0].request_id);
  assert.deepEqual(starts[0].data.body, f.requests[0].body);
  assert.deepEqual(finalUsage(events, starts[0].request_id), measured);
});
