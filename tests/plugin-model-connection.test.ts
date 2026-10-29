import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MODEL_TYPES, ModelConfig, resolveModel } from "../core/model-config.ts";
import { pluginServices } from "../core/plugin-services.ts";
import { LLM } from "../core/llm.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-plugin-model-connection-"));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "config"));
  const file = join(root, "config/config.json");
  const config: any = {
    providers: [{ id: "cloud", name: "测试连接", protocol: "openai-compatible", base_url: "https://models.example/v1",
      api_key: "synthetic-plugin-model-key", enabled: true, proxy_url: "http://127.0.0.1:7890", timeout_seconds: 75 }],
    models: MODEL_TYPES.map((type) => ({ id: type + "-config", name: type + " 配置", model: "vendor-" + type, type,
      provider: "cloud", enabled: true, parameters: { options: { nested: [1, "value"] } },
      dimensions: type === "embedding" ? 1024 : null, context_window: type === "chat" ? 128000 : null })),
    model_bindings: { chat: "chat-config" }, personas: { a: { name: "A", model: null } }, channels: { web: { persona: "a" } },
  };
  const logger: any = { secrets: [], info() {}, warn() {}, error() {} };
  await writeFile(file, JSON.stringify(config));
  const manager = new ModelConfig(root, config, logger);
  const models = pluginServices(config, manager, {} as any, {}).models;
  const input = () => {
    const snapshot = manager.snapshot();
    return { revision: snapshot.revision, providers: snapshot.providers, models: snapshot.models,
      bindings: snapshot.bindings, personaModels: { a: null } };
  };
  const edit = async (mutate: (value: any) => void) => {
    const disk = JSON.parse(await readFile(file, "utf8")); mutate(disk); await writeFile(file, JSON.stringify(disk));
  };
  return { file, config, manager, models, logger, edit, input };
}

test("plugins can explicitly resolve every configured model type without executing its business API", async (t) => {
  const f = await fixture(t);
  assert.equal(f.models.list().length, MODEL_TYPES.length);
  for (const type of MODEL_TYPES) {
    const connection = f.models.connection(type + "-config");
    assert.equal(connection.id, type + "-config");
    assert.equal(connection.type, type);
    assert.equal(connection.model, "vendor-" + type);
    assert.equal(connection.provider_id, "cloud");
    assert.equal(connection.provider_name, "测试连接");
    assert.equal(connection.base_url, "https://models.example/v1");
    assert.equal(connection.api_key, "synthetic-plugin-model-key");
    assert.equal(connection.timeout_seconds, 75);
    assert.equal(connection.proxy_url, "http://127.0.0.1:7890");
    assert.equal(connection.context_window, type === "chat" ? 128000 : null);
    assert.equal(connection.dimensions, type === "embedding" ? 1024 : null);
    assert.equal(f.models.list(type)[0].callable, type === "chat");
  }
});

test("public metadata and browser snapshots never expose the backend credential connection", async (t) => {
  const f = await fixture(t);
  for (const value of [f.models.list(), f.manager.snapshot()]) {
    assert.doesNotMatch(JSON.stringify(value), /synthetic-plugin-model-key/);
    assert.doesNotMatch(JSON.stringify(value), /"api_key"/);
  }
  assert.doesNotMatch(JSON.stringify(f.models.list()), /models\.example|7890/);
  assert.deepEqual(Object.keys(f.models.connection("chat-config")).sort(), [
    "id", "name", "model", "type", "provider_id", "provider_name", "protocol", "base_url", "api_key",
    "timeout_seconds", "proxy_url", "parameters", "dimensions", "context_window",
  ].sort());
});

test("each connection is a deep independent snapshot and external edits are observed on the next read", async (t) => {
  const f = await fixture(t), connection: any = f.models.connection("chat-config");
  connection.parameters.options.nested.push("mutated"); connection.api_key = "overwritten";
  connection.base_url = "https://unrelated.example";
  assert.deepEqual(f.models.connection("chat-config").parameters, { options: { nested: [1, "value"] } });
  assert.equal(f.models.connection("chat-config").api_key, "synthetic-plugin-model-key");
  await f.edit((disk) => { disk.providers[0].api_key = "changed-key"; disk.providers[0].timeout_seconds = 40; });
  assert.equal(f.models.connection("chat-config").api_key, "changed-key");
  assert.equal(f.models.connection("chat-config").timeout_seconds, 40);
  assert.ok(f.logger.secrets.includes("changed-key"));
});

test("resolution never chooses a default or accepts a provider's bare model name", async (t) => {
  const f = await fixture(t);
  for (const id of [undefined, null, "", "vendor-chat", "cloud", "missing", "../chat-config"])
    assert.throws(() => f.models.connection(id as any), /模型配置|模型引用/);
  assert.equal(f.config.model_bindings.chat, "chat-config");
});

test("disabled models, missing providers and invalid connection fields are rejected", async (t) => {
  const f = await fixture(t);
  await f.edit((disk) => { disk.models[0].enabled = false; });
  assert.throws(() => f.models.connection("chat-config"), /停用/);
  await f.edit((disk) => { disk.models[0].enabled = true; disk.providers[0].enabled = false; });
  assert.throws(() => f.models.connection("chat-config"), /停用/);
  await f.edit((disk) => { disk.providers[0].enabled = true; disk.models[0].provider = "absent"; });
  assert.throws(() => f.models.connection("chat-config"), /不存在/);
  await f.edit((disk) => { disk.models[0].provider = "cloud"; disk.providers[0].base_url = "file:///private"; });
  assert.throws(() => f.models.connection("chat-config"), /HTTP/);
  await f.edit((disk) => { disk.providers[0].base_url = "https://models.example/v1"; disk.providers[0].timeout_seconds = 0; });
  assert.throws(() => f.models.connection("chat-config"), /超时/);
});

test("credential-free local connections work and switching protocol cannot silently keep an old key", async (t) => {
  const f = await fixture(t);
  const value = f.input();
  value.providers[0].protocol = "local-native";
  value.providers[0].clear_key = true;
  value.providers[0].base_url = "http://127.0.0.1:15000/api";
  value.bindings.chat = null;
  await f.manager.save(value);
  assert.equal(f.models.connection("tts-config").api_key, "");
  assert.equal(f.models.connection("tts-config").base_url, "http://127.0.0.1:15000/api");
  assert.equal(f.manager.snapshot().providers[0].has_key, false);
});

test("known service/type mismatches remain invalid for connection access", async (t) => {
  const f = await fixture(t);
  await f.edit((disk) => { disk.providers[0].base_url = "https://api.deepseek.com/v1"; });
  assert.throws(() => f.models.connection("embedding-config"), /DeepSeek/);
  assert.equal(f.models.list().length, 1);
  await f.edit((disk) => { disk.providers[0].base_url = "https://dashscope.aliyuncs.com/api/v1"; disk.providers[0].protocol = "dashscope"; });
  assert.equal(f.models.connection("embedding-config").protocol, "dashscope");
  assert.throws(() => f.models.connection("chat-config"), /DashScope/);
});

test("custom protocol identifiers persist for plugins while core dialogue and probing refuse them", async (t) => {
  const f = await fixture(t), value = f.input();
  value.providers[0].protocol = "vendor-native-v2";
  value.providers[0].clear_key = true;
  value.bindings.chat = null;
  await f.manager.save(value);
  assert.equal(f.models.connection("image-config").protocol, "vendor-native-v2");
  assert.ok(f.models.list().every((model) => !model.callable));
  assert.throws(() => resolveModel(f.config, "chat-config"), /由插件调用/);
  const connection = f.models.connection("chat-config");
  await assert.rejects(new LLM(f.logger).chat({ provider: connection, messages: [] }), /由插件调用/);
  await assert.rejects(f.manager.testModel("chat-config"), /插件调用和测试/);
  await assert.rejects(f.manager.listModels("cloud"), /手动填写模型/);
  const binding = f.input(); binding.bindings.chat = "chat-config";
  await assert.rejects(f.manager.save(binding), /绑定的模型必须/);
});

test("protocol identifiers reject unsafe values and credential changes require an explicit choice", async (t) => {
  const f = await fixture(t);
  for (const protocol of ["", "HTTP", "native v2", "../../vendor", "x\nheader", "x".repeat(65)]) {
    const value = f.input(); value.providers[0].protocol = protocol;
    await assert.rejects(f.manager.save(value), /协议标识/);
  }
  const value = f.input(); value.providers[0].protocol = "native";
  await assert.rejects(f.manager.save(value), /重新输入密钥/);
});

test("all model configuration pages expose plugin protocol configuration without claiming executable features", async () => {
  const { templatesFor, renderModels } = await import(new URL("../core/ui/models.js", import.meta.url).href);
  for (const type of MODEL_TYPES) {
    assert.ok(templatesFor(type).some((template: any) => template.id === "plugin"));
    const state: any = { config: { providers: [], models: [], bindings: {}, personas: [], revision: "one" }, modelFilter: type };
    assert.match(renderModels({ state }), /data-add/);
    assert.equal(state.modelFilter, type);
  }
  const state: any = { modelFilter: "image", modelSelection: "image", config: {
    revision: "one", providers: [{ id: "p", name: "图像连接", protocol: "image-native", base_url: "https://image.example/api", enabled: true }],
    models: [{ id: "image", name: "图像模型", model: "paint", type: "image", provider: "p", enabled: true }], bindings: {}, personas: [],
  } };
  const html = renderModels({ state });
  assert.match(html, /name="protocol"[^>]*value="image-native"/);
  assert.match(html, /data-probe-draft disabled/);
  assert.match(html, /data-fetch-models disabled/);
  assert.doesNotMatch(html, /name="context_window"/);
});

test("plugin-only dialogue protocols are omitted from core routing and persona selectors", async () => {
  const { renderBindings } = await import(new URL("../core/ui/views.js", import.meta.url).href);
  const { renderPersonas } = await import(new URL("../core/ui/personas.js", import.meta.url).href);
  const { availableModels } = await import(new URL("../core/ui/api.js", import.meta.url).href);
  const model = { id: "native-chat", name: "插件原生模型", model: "native-chat", type: "chat", provider: "native", enabled: true };
  const config = { revision: "one", activePersona: "a", bindings: { chat: null },
    providers: [{ id: "native", name: "Native", protocol: "vendor-native", enabled: true }], models: [model], personas: [{ id: "a", name: "A", model: null }] };
  const app: any = { state: { config, personaDrafts: {}, personaSelection: "a", status: { persona: "a" } } };
  assert.equal(availableModels(config).length, 0);
  assert.doesNotMatch(renderBindings(app), /<option value="native-chat"/);
  assert.doesNotMatch(renderPersonas(app), /<option value="native-chat"/);
});
