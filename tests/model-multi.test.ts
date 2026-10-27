import { test } from "node:test";
import assert from "node:assert/strict";
const { configWithModels, renderModels } = await import(
  new URL("../core/ui/models.js", import.meta.url).href
);
function fixture() {
  const provider = {
    id: "source",
    name: "Source",
    protocol: "openai-compatible",
    base_url: "https://models.example/v1",
    enabled: true,
    has_key: true,
    timeout_seconds: 120,
    proxy_url: "",
  };
  const model = {
    id: "first",
    provider: "source",
    model: "chat-a",
    name: "Chat A",
    type: "chat",
    enabled: true,
    parameters: { temperature: 0.3 },
    dimensions: null,
  };
  const config = {
    revision: "one",
    providers: [provider],
    models: [model],
    bindings: { chat: "first", embedding: null },
    personas: [],
  };
  const app = { state: { config, modelFilter: "chat" } } as any;
  renderModels(app);
  return { config, app, draft: app.state.modelDraft };
}
test("one connection imports multiple models without duplicate records or changing routing", () => {
  const { config, draft } = fixture();
  const next = configWithModels(structuredClone(config), draft, [
    { model: "chat-a" },
    { model: "chat-b" },
    { model: "chat-b" },
    { model: "chat-c", name: "Third" },
  ]);
  assert.equal(next.providers.length, 1);
  assert.deepEqual(
    next.models.map((m: any) => m.model),
    ["chat-a", "chat-b", "chat-c"],
  );
  assert.ok(next.models.every((m: any) => m.provider === "source"));
  assert.equal(next.models[2].name, "Third");
  assert.equal(next.bindings.chat, "first");
  assert.deepEqual(next.models[0].parameters, { temperature: 0.3 });
  assert.equal(next.providers[0].api_key, "");
  assert.equal(config.models.length, 1);
});
test("new connection can import its first models without a placeholder model", () => {
  const { draft } = fixture();
  const next = configWithModels(
    {
      revision: "one",
      providers: [],
      models: [],
      bindings: { chat: null },
      personas: [],
    },
    {
      ...draft,
      isNew: true,
      model: "",
      api_key: "typed-draft-key",
      use: false,
    },
    [{ model: "chat-a" }, { model: "chat-b" }],
  );
  assert.equal(next.models.length, 2);
  assert.equal(next.providers[0].api_key, "typed-draft-key");
  assert.equal(next.bindings.chat, null);
  assert.ok(next.models.every((m: any) => m.id !== draft.id));
});
test("sidebar groups models by connection and lists explicit shared model names", () => {
  const { config, app } = fixture();
  config.models.push({
    ...config.models[0],
    id: "second",
    model: "chat-b",
    name: "Chat B",
  });
  const html = renderModels(app);
  assert.equal((html.match(/data-connection=/g) || []).length, 1);
  assert.match(html, /data-edit-model="first"/);
  assert.match(html, /data-edit-model="second"/);
  assert.match(html, /共用此连接的其他模型/);
  assert.match(html, /Chat B/);
  assert.match(html, /data-fetch-models/);
  assert.match(html, /data-custom-model/);
});
