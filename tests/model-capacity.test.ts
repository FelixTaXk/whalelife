import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.ts";
import { Logger } from "../core/logger.ts";
import { ModelConfig, resolveModel } from "../core/model-config.ts";
import { modelContextMetadata, resolveModelContext, type ModelContextCache } from "../core/model-context.ts";

const connection = {
  id: "test-service", name: "Test service", protocol: "openai-compatible",
  base_url: "http://127.0.0.1:1/v1", api_key: "local-test-secret", enabled: true,
  timeout_seconds: 2, proxy_url: "", model: "selected", model_id: "chat",
  context_window: null, parameters: { max_tokens: 1024 },
};

async function localModels(t: TestContext, response: unknown) {
  const requests: string[] = [];
  const server = createServer((request, reply) => {
    requests.push(request.url!);
    assert.equal(request.headers.authorization, "Bearer local-test-secret");
    reply.setHeader("content-type", "application/json");
    reply.end(JSON.stringify(response));
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = await temporaryDirectory("whale-model-capacity-");
  await mkdir(join(root, "config"));
  const config: any = {
    providers: [{ ...connection, base_url: `http://127.0.0.1:${address.port}/v1` }],
    models: [{ id: "chat", name: "Chat", provider: connection.id, model: "selected", type: "chat",
      enabled: true, parameters: { max_tokens: 1024 } }],
    model_bindings: { chat: "chat" }, personas: {},
  };
  await writeFile(join(root, "config", "config.json"), JSON.stringify(config));
  const manager = new ModelConfig(root, config, new Logger(join(root, "logs")));
  return { manager, config, requests };
}

test("service context aliases are numeric whole-context ceilings, never output or input limits", () => {
  for (const key of ["context_window", "context_length", "max_context_length", "max_model_len"]) {
    for (const wrapper of [(value: any) => value, (value: any) => ({ top_provider: value }), (value: any) => ({ model_info: value })]) {
      assert.equal(modelContextMetadata(wrapper({ [key]: 32768 })), 32768);
      for (const value of [0, -1, 1.5, "32768", true, NaN, Infinity, 10000001, Number.MAX_SAFE_INTEGER])
        assert.equal(modelContextMetadata(wrapper({ [key]: value })), null);
    }
  }
  assert.equal(modelContextMetadata({ context_length: 10000000 }), 10000000);
  assert.equal(modelContextMetadata({ context_length: 131072, top_provider: { context_length: 32768 } }), 32768);
  assert.equal(modelContextMetadata({ context_window: "broken", model_info: { max_model_len: 8192 } }), 8192);
  for (const metadata of [null, [], { model: "known-looking-large-model" },
    { max_tokens: 8192, max_output_tokens: 16384, max_input_tokens: 32768, top_provider: { max_completion_tokens: 4096 } }])
    assert.equal(modelContextMetadata(metadata), null);
});

test("saved and draft discovery normalize service metadata without saving or guessing by model name", async t => {
  const f = await localModels(t, { data: [
    { id: "selected", context_length: 65536, top_provider: { context_length: 32768 } },
    { id: "local-model", max_model_len: 8192 },
    { id: "nested-model", model_info: { max_context_length: 16384 } },
    { id: "known-looking-large-model", max_tokens: 128000, max_output_tokens: 64000 },
  ] });
  const listed = await f.manager.listModels(connection.id);
  assert.deepEqual(listed.details, [
    { id: "selected", context_window: 32768 },
    { id: "local-model", context_window: 8192 },
    { id: "nested-model", context_window: 16384 },
    { id: "known-looking-large-model", context_window: null },
  ]);
  const before = f.manager.snapshot();
  const draft = await f.manager.listDraftModels({ provider: { ...before.providers[0], api_key: "" } });
  assert.deepEqual(draft, listed);
  assert.deepEqual(f.manager.snapshot(), before);
  assert.deepEqual(await resolveModelContext({ provider: resolveModel(f.config, "chat"), modelConfig: f.manager }),
    { tokens: 32768, source: "provider" });
  assert.deepEqual(f.requests, ["/v1/models", "/v1/models", "/v1/models"]);
});

test("manual context capacity wins without discovery and invalid values cannot become capacities", async () => {
  const modelConfig = { async listModels() { assert.fail("manual context must not call model discovery"); } };
  assert.deepEqual(await resolveModelContext({ provider: { ...connection, context_window: 12000 }, modelConfig, refresh: true }),
    { tokens: 12000, source: "configured" });
  for (const value of ["12000", 0, -1, 1.5, Infinity, 10000001])
    assert.deepEqual(await resolveModelContext({ provider: { ...connection, context_window: value } }),
      { tokens: null, source: "unknown" });
});

test("resolver requires an exact model match and returns unknown for failures and malformed limits", async () => {
  const cases = [
    [{ id: "selected-large", context_window: 65536 }],
    [{ id: "SELECTED", context_window: 65536 }],
    [{ id: "selected", context_window: 0 }],
    [{ id: "selected", context_window: 10000001 }],
    [],
  ];
  for (const details of cases)
    assert.deepEqual(await resolveModelContext({ provider: connection, modelConfig: { async listModels() { return { details }; } } }),
      { tokens: null, source: "unknown" });
  assert.deepEqual(await resolveModelContext({ provider: connection,
    modelConfig: { async listModels() { throw Error("service unavailable"); } } }), { tokens: null, source: "unknown" });
  assert.deepEqual(await resolveModelContext({ provider: connection,
    modelConfig: { async listModels() { return { details: [{ id: "selected", context_window: 65536 }, { id: "selected", context_window: 32768 }] }; } } }),
    { tokens: 32768, source: "provider" });
});

test("cache refreshes and invalidates across connection, credentials, model, and configuration changes", async () => {
  let requests = 0, tokens = 32768;
  const modelConfig = { revision: "one", async listModels() {
    requests++;
    return { details: ["selected", "other"].map(id => ({ id, context_window: tokens })) };
  } };
  const cache: ModelContextCache = new Map();
  const options = { provider: connection, modelConfig };
  await resolveModelContext(options, cache);
  tokens = 65536;
  assert.equal((await resolveModelContext(options, cache)).tokens, 32768);
  assert.equal(requests, 1);
  assert.equal((await resolveModelContext({ ...options, refresh: true }, cache)).tokens, 65536);
  assert.equal(requests, 2);
  const changes = [
    { id: "other-service" }, { base_url: "http://127.0.0.1:2/v1" }, { api_key: "changed-local-secret" },
    { protocol: "other-protocol" }, { proxy_url: "http://127.0.0.1:3" }, { timeout_seconds: 3 },
    { model: "other" }, { model_id: "other-config" }, { parameters: { max_tokens: 2048 } },
  ];
  for (const change of changes) await resolveModelContext({ ...options, provider: { ...connection, ...change } }, cache);
  assert.equal(requests, 2 + changes.length);
  modelConfig.revision = "two";
  await resolveModelContext(options, cache);
  assert.equal(requests, 3 + changes.length);
  assert.ok([...cache.keys()].every(key => /^[a-f0-9]{64}$/.test(key)));
  assert.ok(!JSON.stringify([...cache]).includes("secret"));
  for (let index = 0; index < 140; index++)
    await resolveModelContext({ ...options, provider: { ...connection, model_id: `config-${index}` } }, cache);
  assert.ok(cache.size <= 128);
});

test("unknown metadata is cached briefly and explicit cancellation never creates an unknown cache result", async () => {
  const cache: ModelContextCache = new Map();
  let requests = 0;
  const modelConfig = { async listModels() { requests++; throw Error("unavailable"); } };
  const options = { provider: connection, modelConfig };
  await resolveModelContext(options, cache);
  await resolveModelContext(options, cache);
  assert.equal(requests, 1);
  assert.ok([...cache.values()][0].until <= Date.now() + 60000);
  for (const value of cache.values()) value.until = 0;
  await resolveModelContext(options, cache);
  assert.equal(requests, 2);
  const controller = new AbortController();
  const canceledCache: ModelContextCache = new Map();
  await assert.rejects(resolveModelContext({ provider: connection, signal: controller.signal,
    modelConfig: { async listModels() { controller.abort(Error("cancel context lookup")); throw Error("request aborted"); } },
  }, canceledCache), /cancel context lookup/);
  assert.equal(canceledCache.size, 0);
  await assert.rejects(resolveModelContext({ provider: { ...connection, context_window: 4096 }, signal: controller.signal }), /cancel context lookup/);
});

const { renderModels, bindModels, configWithDraft } = await import(new URL("../core/ui/models.js", import.meta.url).href);
function editorHarness(t: TestContext, contextWindow: number | null = null) {
  const config = {
    revision: "test", providers: [{ ...connection, api_key: undefined, has_key: true }],
    models: [{ id: "chat", provider: connection.id, name: "Chat", model: "selected", type: "chat", enabled: true,
      context_window: contextWindow, parameters: { max_tokens: 1024 } }], bindings: { chat: "chat" }, personas: [],
  };
  const app: any = { state: { config, modelFilter: "chat" }, render() {} };
  const html = renderModels(app), draft = app.state.modelDraft;
  const values = new Map<string, string>();
  for (const field of ["name", "providerName", "template", "base_url", "api_key", "model", "timeout_seconds", "proxy_url", "dimensions", "context_window", "parametersText"])
    values.set(field, draft[field]);
  for (const field of ["enabled", "clear_key", "use"]) if (draft[field]) values.set(field, "on");
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { disabled: false, textContent: "", value: "",
      addEventListener(this: any, name: string, fn: any) { this[`on${name}`] = fn; }, classList: { remove() {}, toggle() {} } });
    return nodes.get(selector);
  };
  const form: any = { values, elements: { template: { value: draft.template } }, querySelector: node,
    querySelectorAll: () => [], reportValidity: () => true };
  app.content = { querySelectorAll: () => [], querySelector: (selector: string) => selector === "#connection-form" ? form : node(selector) };
  app.configDraft = () => structuredClone(config);
  const original = Object.getOwnPropertyDescriptor(globalThis, "FormData")!;
  Object.defineProperty(globalThis, "FormData", { ...original, value: class {
    form: any;
    constructor(form: any) { this.form = form; }
    has(name: string) { return this.form.values.has(name); }
    get(name: string) { return this.form.values.get(name) ?? null; }
  } });
  t.after(() => Object.defineProperty(globalThis, "FormData", original));
  bindModels(app);
  return { app, draft, values, form, node, html };
}

test("model editor fetches the draft connection, preserves manual fallback, and saves only explicit manual values", async t => {
  const h = editorHarness(t, 12000);
  assert.match(h.html, /data-fetch-context/);
  assert.match(h.html, /不是单次输出上限/);
  h.values.set("base_url", "http://127.0.0.1:12345/v1");
  h.values.set("api_key", "draft-test-key");
  h.form.oninput();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (path: any, init: any) => {
    requests++;
    assert.equal(path, "/api/model-config/models/draft");
    const sent = JSON.parse(init.body);
    assert.equal(sent.provider.base_url, "http://127.0.0.1:12345/v1");
    assert.equal(sent.provider.api_key, "draft-test-key");
    return new Response(JSON.stringify({ details: [{ id: "selected", context_window: 32768 }] }));
  });
  await h.node("[data-fetch-context]").onclick();
  assert.equal(requests, 1);
  assert.equal(h.draft.context_window, "12000");
  assert.match(h.node("#context-capacity-result").textContent, /服务返回.*32,768.*优先采用手动值/);
  assert.equal(configWithDraft(h.app.configDraft(), h.draft).models[0].context_window, 12000);
  h.values.set("context_window", "");
  h.form.oninput();
  await h.node("[data-fetch-context]").onclick();
  assert.match(h.node("#context-capacity-result").textContent, /32,768.*自动/);
  assert.equal(configWithDraft(h.app.configDraft(), h.draft).models[0].context_window, null);
  assert.equal(h.app.state.config.models[0].context_window, 12000);
});

test("editor ignores responses for an outdated draft and keeps manual entry available after missing metadata or network errors", async t => {
  const h = editorHarness(t);
  let complete!: (value: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { complete = resolve; }));
  const reading = h.node("[data-fetch-context]").onclick();
  h.values.set("model", "other");
  h.form.oninput();
  complete(new Response(JSON.stringify({ details: [{ id: "selected", context_window: 65536 }] })));
  await reading;
  assert.equal(h.draft.capacityResult, null);
  assert.doesNotMatch(h.node("#context-capacity-result").textContent, /65,536/);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ details: [{ id: "other-large", context_window: 65536 }] })));
  await h.node("[data-fetch-context]").onclick();
  assert.match(h.node("#context-capacity-result").textContent, /未提供.*手动填写/);
  t.mock.method(globalThis, "fetch", async () => { throw Error("offline"); });
  await h.node("[data-fetch-context]").onclick();
  assert.match(h.node("#context-capacity-result").textContent, /读取失败.*手动填写/);
  assert.equal(h.node("[data-fetch-context]").disabled, false);
  h.values.set("context_window", "8192");
  h.form.oninput();
  assert.equal(configWithDraft(h.app.configDraft(), h.draft).models[0].context_window, 8192);
});
