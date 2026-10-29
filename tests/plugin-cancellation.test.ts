import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { withModelResponse } from "../core/model-http.ts";
import { LLM } from "../core/llm.ts";
import { Tools } from "../core/tools.ts";
import { Sessions } from "../core/session.ts";
import { Memory } from "../core/memory.ts";
import { compressShort } from "../core/memory-lifecycle.ts";
import { ModelConfig } from "../core/model-config.ts";

const logger: any = { info() {}, warn() {}, error() {} };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
async function server(t: TestContext, handle: RequestListener) {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const address = server.address() as { port: number };
  return { base_url: `http://127.0.0.1:${address.port}`, model: "local-test", timeout_seconds: 10 };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-cancellation-"));
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  await writeFile(join(root, "persona.md"), "测试助手");
  const config: any = {
    providers: [{ id: "local", model: "test", base_url: "https://unused.example/v1", context_window: 16000 }],
    personas: { a: { name: "A", file: "persona.md", provider: "local", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } },
    memory: { budget_tokens: 6000 },
  };
  const tools = new Tools(logger);
  const llm: any = { chat: async () => ({ text: "完成", toolCalls: [] }) };
  const sessions = new Sessions(root, config, { memory, llm, tools, logger });
  t.after(async () => {
    await sessions.close();
    await memory.queue;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, memory, tools, llm, sessions };
}

test("external abort cancels an HTTP request before headers and preserves its reason", { timeout: 5000 }, async (t) => {
  const entered = deferred(), disconnected = deferred(), controller = new AbortController();
  let requests = 0;
  const provider = await server(t, (_request, response) => {
    requests++;
    response.on("close", () => disconnected.resolve());
    entered.resolve();
  });
  const reason = Error("plugin stopped");
  const pending = withModelResponse(provider, "/chat", {}, (response) => response.text(), controller.signal);
  const rejected = assert.rejects(pending, (error) => error === reason);
  await entered.promise;
  controller.abort(reason);
  await rejected;
  await disconnected.promise;
  await assert.rejects(
    withModelResponse(provider, "/chat", {}, (response) => response.text(), controller.signal),
    (error) => error === reason,
  );
  assert.equal(requests, 1, "an already canceled call must never reach the transport");
});

test("LLM cancellation interrupts streaming reads and keeps the original cancellation reason", { timeout: 5000 }, async (t) => {
  const disconnected = deferred(), controller = new AbortController(), reason = Error("caller canceled");
  const provider = await server(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    response.on("close", () => disconnected.resolve());
  });
  const chunks: string[] = [];
  await assert.rejects(new LLM(logger).chat({
    provider, messages: [{ role: "user", content: "test" }], signal: controller.signal,
    onChunk: (text: string) => { chunks.push(text); controller.abort(reason); },
  }), (error) => error === reason);
  await disconnected.promise;
  assert.deepEqual(chunks, ["first"]);
});

test("request timeout still applies while an external signal is active", { timeout: 5000 }, async (t) => {
  const provider = await server(t, () => {}), controller = new AbortController();
  await assert.rejects(withModelResponse({ ...provider, timeout_seconds: 1 }, "/chat", {},
    (response) => response.text(), controller.signal),
  (error: any) => error.status === 504 && /超时/.test(error.message));
  assert.equal(controller.signal.aborted, false);
});

test("plugin disposal cancels running tools, rejects later calls and cannot remove a replacement", async () => {
  const tools = new Tools(logger), controller = new AbortController(), entered = deferred();
  let received: AbortSignal | undefined, calls = 0;
  const dispose = tools.register({ name: "action", schema: {}, danger: "safe", owner: "plugin", run: async (_args: any, session: any) => {
    calls++; received = session.signal; entered.resolve(); return aborted(session.signal);
  } }, controller.signal);
  const pending = tools.call("action", {}, { id: "one", permission: "full" });
  await entered.promise;
  controller.abort(Error("plugin disabled"));
  assert.equal(received?.aborted, true);
  assert.equal((await pending).ok, false);
  assert.equal((await tools.call("action", {}, { permission: "full" })).ok, false);
  assert.equal(calls, 1);
  assert.equal(tools.list().length, 0);
  assert.throws(() => tools.register({ name: "stale" }, controller.signal), /plugin disabled/);
  tools.register({ name: "action", schema: {}, danger: "safe", run: async () => "replacement" });
  dispose();
  assert.deepEqual(await tools.call("action", {}, { permission: "full" }), { ok: true, result: "replacement" });
});

test("session close aborts in-flight models, releases locks and rejects new work", async (t) => {
  const f = await fixture(t), entered = deferred();
  let received: AbortSignal | undefined;
  f.llm.chat = (request: any) => { received = request.signal; entered.resolve(); return aborted(request.signal); };
  const pending = f.sessions.chat("one", "开始", () => {});
  const rejected = assert.rejects(pending, /会话服务已关闭/);
  await entered.promise;
  await f.sessions.close();
  await rejected;
  assert.equal(received?.aborted, true);
  assert.equal(f.sessions.locks.size, 0);
  assert.equal((await f.memory.readSession("one")).filter((x) => x.role === "assistant").length, 0);
  await assert.rejects(f.sessions.chat("two", "再次开始", () => {}), /会话服务已关闭/);
  await f.sessions.close();
});

test("caller cancellation reaches the model without closing unrelated session work", async (t) => {
  const f = await fixture(t), entered = deferred(), controller = new AbortController();
  const reason = Error("channel caller canceled");
  f.llm.chat = (request: any) => { entered.resolve(); return aborted(request.signal); };
  const pending = f.sessions.chat("one", "开始", () => {}, undefined, undefined, {
    channel: "adapter", account: "test", peer: "one", persona: "a", permission: "full", signal: controller.signal,
  });
  const rejected = assert.rejects(pending, (error) => error === reason);
  await entered.promise;
  controller.abort(reason);
  await rejected;
  f.llm.chat = async () => ({ text: "继续", toolCalls: [] });
  assert.equal(await f.sessions.chat("one", "继续", () => {}), "继续");
});

test("session close also cancels model-window HTTP discovery without caching a canceled result", { timeout: 5000 }, async (t) => {
  const f = await fixture(t), entered = deferred(), disconnected = deferred();
  const provider = await server(t, (request, response) => {
    assert.equal(request.url, "/models");
    response.on("close", () => disconnected.resolve());
    entered.resolve();
  });
  f.config.providers = [{ ...provider, id: "local" }];
  await mkdir(join(f.root, "config"));
  await writeFile(join(f.root, "config/config.json"), JSON.stringify(f.config));
  f.sessions.services.modelConfig = new ModelConfig(f.root, f.config, logger);
  let requests = 0;
  f.llm.chat = async () => { requests++; return { text: "unexpected", toolCalls: [] }; };
  const pending = f.sessions.chat("one", "开始", () => {});
  const rejected = assert.rejects(pending, /会话服务已关闭/);
  await entered.promise;
  await f.sessions.close();
  await rejected;
  await disconnected.promise;
  assert.equal(requests, 0);
  assert.equal(f.sessions.modelLimits.size, 0);
});

test("close tracks the async admission phase and does not allow a late model request", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  let requests = 0, closed = false;
  const sessionMeta = f.memory.sessionMeta.bind(f.memory);
  f.memory.sessionMeta = async (id) => { entered.resolve(); await release.promise; return sessionMeta(id); };
  f.llm.chat = async () => { requests++; return { text: "unexpected", toolCalls: [] }; };
  const pending = f.sessions.chat("one", "开始", () => {});
  const rejected = assert.rejects(pending, /会话服务已关闭/);
  await entered.promise;
  const closing = f.sessions.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(requests, 0);
  assert.equal(f.sessions.locks.size, 0);
});

test("context caller cancellation interrupts HTTP discovery and a fresh query can cache its real limit", { timeout: 5000 }, async (t) => {
  const f = await fixture(t), entered = deferred(), disconnected = deferred(), controller = new AbortController();
  let requests = 0;
  const provider = await server(t, (request, response) => {
    assert.equal(request.url, "/models");
    if (++requests === 1) {
      response.on("close", () => disconnected.resolve());
      entered.resolve();
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-test", context_window: 32000 }] }));
    }
  });
  f.config.providers = [{ ...provider, id: "local" }];
  await mkdir(join(f.root, "config"));
  await writeFile(join(f.root, "config/config.json"), JSON.stringify(f.config));
  f.sessions.services.modelConfig = new ModelConfig(f.root, f.config, logger);
  const route = { channel: "plugin", account: "test", peer: "one", persona: "a", permission: "full" as const, signal: controller.signal };
  const reason = Error("context caller canceled");
  const pending = f.sessions.contextStatus("one", route);
  const rejected = assert.rejects(pending, (error) => error === reason);
  await entered.promise;
  controller.abort(reason);
  await rejected;
  await disconnected.promise;
  assert.equal(f.sessions.modelLimits.size, 0);
  const status = await f.sessions.contextStatus("one", { ...route, signal: undefined });
  assert.equal(status.model.context_window, 32000);
  assert.equal(status.model.limit_source, "provider");
  assert.equal(f.sessions.modelLimits.size, 1);
  assert.equal((await f.sessions.contextStatus("one")).model.context_window, 32000);
  await assert.rejects(f.sessions.contextStatus("one", route), (error) => error === reason);
  assert.equal(requests, 2, "cancellation must neither cache a failure nor invalidate the later real result");
});

test("close tracks context queries and rejects a late discovery result without caching it", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  delete f.config.providers[0].context_window;
  let received: AbortSignal | undefined, closed = false;
  f.sessions.services.modelConfig = { listModels: async (_id: string, signal: AbortSignal) => {
    received = signal; entered.resolve(); await release.promise;
    return { details: [{ id: "test", context_window: 32000 }] };
  } };
  const pending = f.sessions.contextStatus("one");
  const rejected = assert.rejects(pending, /会话服务已关闭/);
  await entered.promise;
  const closing = f.sessions.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received?.aborted, true);
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(f.sessions.modelLimits.size, 0);
  await assert.rejects(f.sessions.contextStatus("one"), /会话服务已关闭/);
});

test("close waits for dispatched tools and stores confirmed success with its origin before stopping", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred(), plugin = new AbortController();
  let toolSignal: AbortSignal | undefined, secondCalls = 0, closed = false, modelCalls = 0;
  const observations: any[] = [];
  f.tools.observe = async (event) => { observations.push(event); };
  f.tools.register({ name: "first", schema: {}, danger: "safe", owner: "business", run: async (_args: any, session: any) => {
    toolSignal = session.signal; entered.resolve(); await release.promise; return "confirmed external success";
  } }, plugin.signal);
  f.tools.register({ name: "second", schema: {}, danger: "safe", run: async () => { secondCalls++; } });
  f.llm.chat = async () => {
    modelCalls++;
    return { text: "", toolCalls: [{ id: "a", name: "first", arguments: "{}" }, { id: "b", name: "second", arguments: "{}" }] };
  };
  const pending = f.sessions.chat("one", "执行", () => {});
  const rejected = assert.rejects(pending, /会话服务已关闭/);
  await entered.promise;
  f.sessions.beginClose();
  plugin.abort();
  const closing = f.sessions.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(toolSignal?.aborted, true);
  release.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(secondCalls, 0);
  assert.equal(modelCalls, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].ok, true);
  const result = (await f.memory.readSession("one")).find((x) => x.type === "tool");
  assert.equal(result.ok, true);
  assert.equal(result.result, "confirmed external success");
  assert.equal(result.origin.plugin, "business");
  assert.equal(f.sessions.locks.size, 0);
});

test("memory compression forwards its cancellation signal to the model", async () => {
  const controller = new AbortController(), entered = deferred();
  let received: AbortSignal | undefined;
  const rows = [{ id: "one", role: "user", text: "内容".repeat(1000) }];
  const pending = compressShort({ services: {
    logger,
    memoryEngine: { reserveConsolidation: async () => true, summaryState: async () => {} },
    llm: { chat: (request: any) => { received = request.signal; entered.resolve(); return aborted(request.signal); } },
  }, id: "one", key: "s_one", provider: {}, limit: null, signal: controller.signal, rows, overflow: rows, checkpoint: {} });
  await entered.promise;
  controller.abort();
  assert.equal(await pending, true);
  assert.equal(received, controller.signal);
  assert.equal(received?.aborted, true);
});
