import { test } from "node:test";
import assert from "node:assert/strict";

test("overview counts usable models and running extensions consistently with navigation and plugins", async () => {
  const { availableModels, extensionPlugins } = await import(
    new URL("../core/ui/api.js", import.meta.url).href
  );
  const { renderOverview, renderPlugins } = await import(
    new URL("../core/ui/views.js", import.meta.url).href
  );
  const config = fixture();
  config.models[1].enabled = false;
  config.models[2].configuration_error = "服务不支持该用途";
  config.models.push({ ...config.models[0], id: "future", type: "tts" });
  const state = {
    config,
    status: {
      persona: "a",
      permission: "off",
      memory: { files: 0, bytes: 0 },
      plugins: [
        { id: "internal-core", builtin: true, status: "active" },
        { id: "extension-one", builtin: false, status: "active" },
        { id: "extension-two", builtin: false, status: "stopped" },
      ],
    },
  };
  assert.equal(availableModels(config).length, 2);
  assert.equal(extensionPlugins(state.status).length, 2);
  assert.match(
    renderOverview({ state }),
    /可用模型<\/small><div class="stat-value ">2<\/div>/,
  );
  assert.match(
    renderOverview({ state }),
    /运行中的扩展插件<\/small><div class="stat-value ">1<\/div>/,
  );
  assert.ok(!renderPlugins({ state }).includes("internal-core"));
  state.status.plugins[1].status = "stopped";
  assert.match(
    renderOverview({ state }),
    /运行中的扩展插件<\/small><div class="stat-value ">0<\/div>/,
  );
  config.providers[2].enabled = false;
  assert.equal(availableModels(config).length, 1);
});

// Import the browser renderer without a DOM or network so these fixtures can
// exercise the same filtering and escaping used by the actual settings page.
const { visibleModels, templatesFor, renderModels, bindModels } = await import(
  new URL("../core/ui/models.js", import.meta.url).href
);

function fixture() {
  const provider = (
    id: string,
    base_url: string,
    protocol = "openai-compatible",
  ) => ({
    id,
    name: id,
    base_url,
    protocol,
    enabled: true,
    has_key: true,
    timeout_seconds: 120,
    proxy_url: "",
  });
  const model = (id: string, provider: string, type: string, name = id) => ({
    id,
    provider,
    type,
    name,
    model: id,
    enabled: true,
    parameters: {},
    dimensions: type === "embedding" ? 1024 : null,
    configuration_error: null as string | null,
  });
  return {
    revision: "revision-one",
    providers: [
      provider("deepseek", "https://api.deepseek.com"),
      provider("shared", "https://models.example/v1"),
      provider("bailian", "https://dashscope.aliyuncs.com/api/v1", "dashscope"),
    ],
    models: [
      model("deepseek-chat", "deepseek", "chat", "DeepSeek 对话"),
      model("shared-chat", "shared", "chat", "共享服务对话"),
      model("shared-embedding", "shared", "embedding", "共享服务向量"),
      model("text-embedding-v4", "bailian", "embedding", "百炼向量"),
    ],
    bindings: { chat: "deepseek-chat", embedding: "text-embedding-v4" },
    personas: [],
  };
}

function appFor(config = fixture(), type = "embedding") {
  return {
    state: {
      config,
      modelFilter: type,
      modelDraft: null,
      modelSelection: null,
    },
  } as any;
}

// The handlers need only these form methods. Values remain independent of the
// draft, just as browser controls do before input/submit captures their content.
function formHarness(app: any) {
  renderModels(app);
  const draft = app.state.modelDraft;
  const values = new Map<string, string>();
  for (const key of [
    "name",
    "template",
    "base_url",
    "api_key",
    "model",
    "timeout_seconds",
    "proxy_url",
    "dimensions",
    "parametersText",
  ])
    values.set(key, draft[key]);
  for (const key of ["enabled", "clear_key", "use"])
    if (draft[key]) values.set(key, "on");
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        disabled: false,
        textContent: "",
        value: "",
        classList: { remove() {}, toggle() {} },
        addEventListener(event: string, fn: (...args: any[]) => unknown) {
          this[`on${event}`] = fn;
        },
      } as any);
    return nodes.get(selector);
  };
  const form: any = {
    values,
    elements: {
      template: { value: draft.template },
      dimensions: { value: draft.dimensions },
    },
    reportValidity: () => true,
    querySelector: node,
    querySelectorAll: () => [node("[data-probe-draft]"), node("[data-detect]")],
  };
  app.content = {
    querySelectorAll: () => [],
    querySelector: (selector: string) =>
      selector === "#connection-form" ? form : null,
  };
  app.configDraft = () => structuredClone(app.state.config);
  app.render = () => {};
  bindModels(app);
  return { form, draft, node };
}

async function withFormData(action: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FormData")!;
  class FixtureFormData {
    form: any;
    constructor(form: any) {
      this.form = form;
    }
    has(name: string) {
      return this.form.values.has(name);
    }
    get(name: string) {
      return this.form.values.get(name) ?? null;
    }
  }
  Object.defineProperty(globalThis, "FormData", {
    ...original,
    value: FixtureFormData,
  });
  try {
    await action();
  } finally {
    Object.defineProperty(globalThis, "FormData", original);
  }
}

test("model lists separate capabilities even when the same provider serves both", () => {
  const config = fixture();
  const before = structuredClone(config);
  assert.deepEqual(
    visibleModels(config, "embedding").map((m: any) => m.id),
    ["shared-embedding", "text-embedding-v4"],
  );
  assert.deepEqual(
    visibleModels(config, "chat").map((m: any) => m.id),
    ["deepseek-chat", "shared-chat"],
  );
  assert.deepEqual(
    config,
    before,
    "filtering must not delete or reclassify persisted records",
  );
});

test("invalid old embedding records stay stored but never become selectable connections", () => {
  const config = fixture();
  config.models.push(
    {
      ...config.models[0],
      id: "bad-deepseek-embedding",
      name: "误配的 DeepSeek 向量",
      type: "embedding",
      configuration_error: "DeepSeek 不支持嵌入接口",
    },
    {
      ...config.models[2],
      id: "missing-provider",
      provider: "removed-provider",
    },
    {
      ...config.models[2],
      id: "unsupported-protocol",
      configuration_error: "提供商协议不受支持",
    },
  );
  const html = renderModels(appFor(config));
  assert.deepEqual(
    visibleModels(config, "embedding").map((m: any) => m.id),
    ["shared-embedding", "text-embedding-v4"],
  );
  assert.match(html, /3 条配置待修复/);
  assert.match(html, /data-issues/);
  for (const id of [
    "bad-deepseek-embedding",
    "missing-provider",
    "unsupported-protocol",
  ]) {
    assert.ok(
      config.models.some((m) => m.id === id),
      "repairable records must remain in the source config",
    );
    assert.ok(!html.includes(`data-connection="${id}"`));
  }
});

test("DeepSeek embedding is rejected even when an older snapshot lacks a diagnostic", () => {
  const config = fixture();
  config.models.push({
    ...config.models[0],
    id: "legacy-embedding",
    type: "embedding",
  });
  assert.ok(
    !visibleModels(config, "embedding").some(
      (m: any) => m.id === "legacy-embedding",
    ),
  );
});

test("embedding templates include native DashScope and exclude the DeepSeek chat service", () => {
  const embedding = templatesFor("embedding");
  assert.ok(embedding.length > 0);
  assert.ok(
    !embedding.some((t: any) =>
      /deepseek/i.test(`${t.id} ${t.label} ${t.base_url}`),
    ),
  );
  const dashscope = embedding.find((t: any) => t.protocol === "dashscope");
  assert.ok(
    dashscope,
    "native DashScope must be an available embedding connection",
  );
  assert.equal(new URL(dashscope.base_url).hostname, "dashscope.aliyuncs.com");
  assert.ok(!dashscope.base_url.includes("compatible-mode"));
  assert.ok(templatesFor("chat").some((t: any) => t.id === "deepseek"));
  assert.deepEqual(templatesFor("all"), []);
});

test("the rendered embedding page exposes only embedding connections and their settings", () => {
  const app = appFor();
  app.state.modelSelection = "text-embedding-v4";
  const html = renderModels(app);
  assert.match(html, /data-connection="shared-embedding"/);
  assert.match(html, /data-connection="text-embedding-v4"/);
  assert.doesNotMatch(html, /DeepSeek|deepseek-chat|shared-chat|共享服务对话/);
  assert.doesNotMatch(html, /data-filter="all"/);
  for (const field of [
    "base_url",
    "api_key",
    "model",
    "dimensions",
    "timeout_seconds",
    "proxy_url",
  ]) {
    assert.ok(
      html.includes(`name="${field}"`),
      `${field} must be editable in the connection form`,
    );
  }
  assert.match(html, /data-detect/);
  assert.match(html, /name="api_key" value=""/);
});

test("a stale all-types selection falls back to the chat page without mixing in embeddings", () => {
  const app = appFor(fixture(), "all");
  const html = renderModels(app);
  assert.equal(app.state.modelFilter, "chat");
  assert.match(html, /data-connection="deepseek-chat"/);
  assert.doesNotMatch(
    html,
    /data-connection="shared-embedding"|data-connection="text-embedding-v4"/,
  );
  assert.doesNotMatch(html, /data-filter="all"/);
});

test("connection names, model values, and JSON parameters cannot inject HTML", () => {
  const config = fixture();
  const maliciousName = '<img src=x onerror="alert(1)">';
  const maliciousModel = 'model" autofocus onfocus="alert(2)';
  config.models[2].name = maliciousName;
  config.models[2].model = maliciousModel;
  config.models[2].parameters = {
    note: "</textarea><script>alert(3)</script>",
  };
  const html = renderModels(appFor(config));
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(html.includes("model&quot; autofocus onfocus=&quot;alert(2)"));
  assert.ok(
    html.includes("&lt;/textarea&gt;&lt;script&gt;alert(3)&lt;/script&gt;"),
  );
  assert.ok(!html.includes(maliciousName));
  assert.ok(!html.includes(maliciousModel));
  assert.doesNotMatch(html, /<script>|<img\b|<\/textarea><script>/);
});

test("the repair dialog escapes legacy names and backend diagnostic text", () => {
  const config = fixture();
  config.models.push({
    ...config.models[2],
    id: "broken",
    name: '<img src=x onerror="alert(1)">',
    configuration_error: '<script>alert("diagnostic")</script>',
  });
  const app = appFor(config);
  let showIssues!: () => void;
  let body = "";
  app.content = {
    querySelectorAll: () => [],
    querySelector: (selector: string) =>
      selector === "[data-issues]"
        ? {
            addEventListener: (_event: string, callback: () => void) => {
              showIssues = callback;
            },
          }
        : null,
  };
  app.dialog = (_title: string, html: string) => {
    body = html;
  };
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });
  try {
    bindModels(app);
    showIssues();
    assert.match(body, /data-repair="broken"/);
    assert.ok(body.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(
      body.includes(
        "&lt;script&gt;alert(&quot;diagnostic&quot;)&lt;/script&gt;",
      ),
    );
    assert.doesNotMatch(body, /<script>|<img\b/);
  } finally {
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("a refreshed snapshot replaces a clean editor with the latest model and revision", () => {
  const app = appFor();
  renderModels(app);
  assert.equal(app.state.modelDraft.model, "shared-embedding");
  const refreshed = structuredClone(app.state.config);
  refreshed.revision = "revision-two";
  refreshed.models[2].model = "updated-embedding";
  refreshed.bindings.embedding = "shared-embedding";
  app.state.config = refreshed;
  const html = renderModels(app);
  assert.match(html, /name="model" value="updated-embedding"/);
  assert.equal(app.state.modelDraft.revision, "revision-two");
  assert.equal(app.state.modelDraft.use, true);
});

test("saving an embedding edit preserves sibling chat models and their selection", async () => {
  const app = appFor();
  const before = structuredClone(app.state.config);
  const { form } = formHarness(app);
  form.values.set("name", "更新后的向量配置");
  form.values.set("model", "new-embedding-model");
  let saved: any;
  app.saveConfig = async (value: any) => {
    saved = value;
  };
  await withFormData(async () => {
    form.oninput();
    await form.onsubmit({ preventDefault() {} });
  });
  assert.ok(saved);
  assert.deepEqual(
    saved.models.filter((m: any) => m.type === "chat"),
    before.models.filter((m: any) => m.type === "chat"),
  );
  assert.deepEqual(
    saved.models.find((m: any) => m.id === "text-embedding-v4"),
    before.models[3],
  );
  assert.equal(
    saved.models.find((m: any) => m.id === "shared-embedding").model,
    "new-embedding-model",
  );
  assert.deepEqual(saved.bindings, before.bindings);
  assert.deepEqual(
    saved.providers.filter((p: any) => p.id !== "shared"),
    before.providers.filter((p: any) => p.id !== "shared"),
  );
  const connection = saved.providers.find((p: any) => p.id === "shared");
  assert.equal(
    connection.api_key,
    "",
    "an empty submitted key asks the backend to preserve the saved secret",
  );
  assert.equal(connection.clear_key, false);
  assert.deepEqual(
    app.state.config,
    before,
    "the handler must not mutate the current snapshot in place",
  );
});

test("detecting draft dimensions sends unsaved values without saving or mutating live configuration", async (t) => {
  const app = appFor();
  const before = structuredClone(app.state.config);
  const { form, draft, node } = formHarness(app);
  form.values.set("model", "draft-embedding-model");
  form.values.set("base_url", "https://draft.example/v1");
  form.values.set("api_key", "synthetic-draft-secret");
  form.values.set("timeout_seconds", "45");
  let saves = 0;
  app.saveConfig = async () => {
    saves++;
  };
  const requests: any[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init: RequestInit) => {
      requests.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({
        dimensions: 768,
        latency_ms: 1,
        message: "嵌入接口可用",
      });
    },
  );
  await withFormData(async () => {
    form.oninput();
    await node("[data-detect]").onclick();
  });
  assert.equal(saves, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/model-config/probe");
  assert.equal(requests[0].body.model.model, "draft-embedding-model");
  assert.equal(requests[0].body.provider.base_url, "https://draft.example/v1");
  assert.equal(requests[0].body.provider.api_key, "synthetic-draft-secret");
  assert.equal(requests[0].body.provider.timeout_seconds, 45);
  assert.equal(requests[0].body.detectDimensions, true);
  assert.equal(draft.dimensions, "768");
  assert.equal(draft.dirty, true);
  assert.equal(form.elements.dimensions.value, "768");
  assert.deepEqual(app.state.config, before);
});

test("late dimension detection cannot replace dimensions after the user edits the draft", async (t) => {
  const app = appFor();
  const { form, draft, node } = formHarness(app);
  let complete!: (response: Response) => void;
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  await withFormData(async () => {
    const pending = node("[data-detect]").onclick();
    form.values.set("model", "a-different-embedding-model");
    form.values.set("dimensions", "1536");
    form.oninput();
    complete(
      Response.json({
        dimensions: 768,
        latency_ms: 1,
        message: "旧模型检测结果",
      }),
    );
    await pending;
  });
  assert.equal(draft.model, "a-different-embedding-model");
  assert.equal(draft.dimensions, "1536");
  assert.doesNotMatch(
    node("#connection-result").textContent,
    /旧模型检测结果|768/,
  );
});

test("renaming a model on a disabled legacy connection does not restart that connection", async () => {
  const config = fixture();
  config.providers[1].enabled = false;
  const app = appFor(config);
  const { form, draft } = formHarness(app);
  assert.equal(draft.enabled, false);
  form.values.set("name", "停用中的向量配置");
  let saved: any;
  app.saveConfig = async (value: any) => {
    saved = value;
  };
  await withFormData(async () => {
    form.oninput();
    await form.onsubmit({ preventDefault() {} });
  });
  assert.equal(
    saved.providers.find((p: any) => p.id === "shared").enabled,
    false,
  );
  assert.equal(
    saved.models.find((m: any) => m.id === "shared-embedding").enabled,
    false,
  );
  assert.deepEqual(
    saved.models.find((m: any) => m.id === "shared-chat"),
    config.models[1],
  );
  assert.deepEqual(saved.bindings, config.bindings);
});

test("explicitly enabling one model on a disabled connection keeps its siblings effectively disabled", async () => {
  const config = fixture();
  config.providers[1].enabled = false;
  const app = appFor(config);
  const { form } = formHarness(app);
  form.values.set("enabled", "on");
  let saved: any;
  app.saveConfig = async (value: any) => {
    saved = value;
  };
  await withFormData(async () => {
    form.oninput();
    await form.onsubmit({ preventDefault() {} });
  });
  assert.equal(
    saved.providers.find((p: any) => p.id === "shared").enabled,
    true,
  );
  assert.equal(
    saved.models.find((m: any) => m.id === "shared-embedding").enabled,
    true,
  );
  assert.deepEqual(
    saved.models.find((m: any) => m.id === "shared-chat"),
    { ...config.models[1], enabled: false },
  );
  assert.deepEqual(
    saved.models.find((m: any) => m.id === "deepseek-chat"),
    config.models[0],
  );
  assert.deepEqual(
    saved.models.find((m: any) => m.id === "text-embedding-v4"),
    config.models[3],
  );
  assert.deepEqual(saved.bindings, config.bindings);
});
