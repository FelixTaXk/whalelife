/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
const { renderModels, bindModels, configWithDraft, configWithModels } = await import(
  new URL("../core/ui/models.js", import.meta.url).href
);

const mapping = { response_field: "metadata.thought", request_field: "thought_text" };
function fixture() {
  return {
    revision: "revision-one",
    providers: [
      { id: "relay", name: "Relay", protocol: "openai-compatible", base_url: "https://relay.invalid/v1",
        has_key: true, enabled: true, timeout_seconds: 120, proxy_url: "" },
      { id: "plugin", name: "Plugin", protocol: "custom", base_url: "https://plugin.invalid/v1", enabled: true },
    ],
    models: [
      { id: "first", provider: "relay", type: "chat", model: "first-chat", name: "First", enabled: true, parameters: {}, dimensions: null },
      { id: "second", provider: "relay", type: "chat", model: "second-chat", name: "Second", enabled: true, parameters: {}, dimensions: null,
        reasoning_compatibility: { ...mapping } },
      { id: "embedding", provider: "relay", type: "embedding", model: "embedding", name: "Embedding", enabled: true, parameters: {}, dimensions: 1024 },
      { id: "disabled", provider: "relay", type: "chat", model: "disabled", name: "Disabled", enabled: false, parameters: {} },
      { id: "external", provider: "plugin", type: "chat", model: "external", name: "External", enabled: true, parameters: {} },
    ],
    bindings: { chat: "first", embedding: "embedding" }, personas: [],
  };
}
function appFor(config: any = fixture(), type = "chat", selection = "first") {
  return { state: { config, modelFilter: type, modelSelection: selection, modelDraft: null, page: "models" } } as any;
}
function harness(app: any = appFor()) {
  const html = renderModels(app), draft = app.state.modelDraft, values = new Map<string, string>();
  for (const key of ["name", "providerName", "template", "base_url", "api_key", "model", "timeout_seconds", "proxy_url", "dimensions", "context_window", "parametersText", "compatibilityAssistant"])
    values.set(key, draft[key] ?? "");
  for (const key of ["enabled", "clear_key", "use"]) if (draft[key]) values.set(key, "on");
  if (draft.reasoningCompatibility?.fill_missing) values.set("compatibilityFill", "on");
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) {
      const classes = new Set<string>();
      nodes.set(selector, {
        disabled: false, hidden: false, textContent: "", value: "",
        get innerHTML() { return this.textContent; }, set innerHTML(_value) { assert.fail("diagnostic output must use textContent"); },
        classList: { add: (value: string) => classes.add(value), remove: (value: string) => classes.delete(value),
          toggle: (value: string, present: boolean) => present ? classes.add(value) : classes.delete(value), contains: (value: string) => classes.has(value) },
        addEventListener(event: string, handler: any) { this[`on${event}`] = handler; },
      });
    }
    return nodes.get(selector);
  };
  const form: any = { values, isConnected: true, elements: { template: { value: draft.template } },
    reportValidity: () => true, querySelector: node, querySelectorAll: () => [] };
  let currentForm = form;
  app.content = { querySelectorAll: () => [], querySelector: (selector: string) => selector === "#connection-form" ? currentForm :
    selector === "[data-custom-model]" || selector === "[data-fetch-models]" ? node(selector) : null };
  app.configDraft = () => structuredClone(app.state.config);
  app.render = () => {};
  bindModels(app);
  return { app, form, draft, node, values, html, replaceForm(value: any) { currentForm = value; } };
}
function formData(t: any) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FormData")!;
  class FixtureFormData {
    form: any;
    constructor(form: any) { this.form = form; }
    has(name: string) { return this.form.values.has(name); }
    get(name: string) { return this.form.values.get(name) ?? null; }
  }
  Object.defineProperty(globalThis, "FormData", { ...original, value: FixtureFormData });
  t.after(() => Object.defineProperty(globalThis, "FormData", original));
}
const verified = (extra: any = {}) => ({ verified: true, compatibility: { ...mapping }, message: "已验证", requests: 4,
  usage: { input_tokens: 41, output_tokens: 12 }, ...extra });

test("compatibility controls stay visible above the model list and connection settings, chat-only and default-off, with usable helpers", () => {
  const config = fixture(), app = appFor(config), html = renderModels(app);
  const compatibility = html.match(/<section\b[^>]*class="[^"]*\bmodel-compatibility\b[^"]*"[^>]*>/);
  assert.ok(compatibility, "compatibility controls must be in an always-visible section");
  assert.doesNotMatch(compatibility[0], /\bhidden\b/);
  assert.ok(compatibility.index! < html.indexOf('<h3 class="model-section-heading">服务连接</h3>'),
    "compatibility controls must appear before the connection settings");
  assert.ok(compatibility.index! < html.indexOf('<section class="connection-models">'),
    "compatibility controls must appear above the configured model list");
  assert.doesNotMatch(html, /<details\b[^>]*class="[^"]*\bmodel-compatibility\b/);
  assert.match(html, /name="compatibilityFill" type="checkbox" >缺|name="compatibilityFill" type="checkbox" ><span/);
  assert.match(html, /最多调用模型 4 次/);
  const select = html.match(/<select id="compatibility-assistant"[\s\S]*?<\/select>/)![0];
  assert.match(select, /value="">使用当前模型/); assert.match(select, /value="second"/);
  assert.doesNotMatch(select, /value="embedding"|value="disabled"|value="external"/);
  assert.doesNotMatch(renderModels(appFor(config, "embedding", "embedding")), /data-ai-compatibility|compatibilityFill/);
  assert.doesNotMatch(renderModels(appFor(config, "chat", "external")), /data-ai-compatibility|compatibilityFill/);
  const updated = configWithDraft(structuredClone(config), app.state.modelDraft);
  assert.equal(Object.hasOwn(updated.models[0], "reasoning_compatibility"), false);
  assert.deepEqual(updated.models[1], config.models[1]);
  assert.deepEqual(updated.bindings, config.bindings);
});

test("AI detection uses unsaved connection and chosen helper, applies verified mapping to draft only, and cannot enable fill", async t => {
  formData(t);
  const h = harness(), before = structuredClone(h.app.state.config);
  h.values.set("base_url", "https://draft.invalid/v1"); h.values.set("api_key", "synthetic-unsaved-key");
  h.values.set("model", "draft-chat"); h.values.set("compatibilityAssistant", "second");
  h.form.oninput();
  h.app.saveConfig = () => assert.fail("must not save during compatibility detection");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (path: any, init: any) => {
    requests++; assert.equal(path, "/api/model-config/compatibility");
    const body = JSON.parse(init.body);
    assert.equal(body.provider.base_url, "https://draft.invalid/v1"); assert.equal(body.provider.api_key, "synthetic-unsaved-key");
    assert.equal(body.model.model, "draft-chat"); assert.equal(body.assistantModelId, "second");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(verified({ compatibility: { ...mapping, fill_missing: true } }));
  });
  await h.node("[data-ai-compatibility]").onclick();
  assert.equal(requests, 1); assert.deepEqual(h.draft.reasoningCompatibility, mapping);
  assert.deepEqual(h.app.state.config, before);
  assert.equal(h.draft.dirty, true); assert.equal(h.node("#connection-save").disabled, false);
  assert.match(h.node("#compatibility-result").textContent, /41 输入 \/ 12 输出 token.*草稿.*保存/);
  assert.equal(h.node("[data-ai-compatibility]").disabled, false);
  assert.equal(h.node("[data-cancel-compatibility]").hidden, true);
  let saved: any;
  h.app.saveConfig = async (input: any) => { saved = input; };
  await h.form.onsubmit({ preventDefault() {} });
  assert.deepEqual(saved.models[0].reasoning_compatibility, mapping);
  assert.deepEqual(saved.models[1], before.models[1]); assert.deepEqual(saved.bindings, before.bindings);
});

test("existing opt-in fill is preserved independently from AI mapping and current-model helper is omitted", async t => {
  formData(t);
  const config: any = fixture(); config.models[0].reasoning_compatibility = { fill_missing: true };
  const h = harness(appFor(config));
  t.mock.method(globalThis, "fetch", async (_path: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(Object.hasOwn(body, "assistantModelId"), false);
    return Response.json(verified());
  });
  await h.node("[data-ai-compatibility]").onclick();
  assert.deepEqual(h.draft.reasoningCompatibility, { ...mapping, fill_missing: true });
  h.node("[data-clear-compatibility]").onclick();
  assert.deepEqual(h.draft.reasoningCompatibility, { fill_missing: true });
  h.values.delete("compatibilityFill"); h.form.oninput();
  const saved = configWithDraft(h.app.configDraft(), h.draft);
  assert.equal(saved.models[0].reasoning_compatibility, null);
});

test("clearing saved mapping is explicit null while sibling settings survive multi-model additions", async t => {
  formData(t);
  const h = harness(appFor(fixture(), "chat", "second"));
  h.node("[data-clear-compatibility]").onclick();
  assert.equal(h.draft.reasoningCompatibility, null);
  const saved = configWithDraft(h.app.configDraft(), h.draft);
  assert.equal(saved.models[1].reasoning_compatibility, null);
  const primary = harness();
  const multiple = configWithModels(primary.app.configDraft(), primary.draft, [{ model: "third" }]);
  assert.deepEqual(multiple.models[1].reasoning_compatibility, mapping);
  assert.equal(Object.hasOwn(multiple.models.at(-1), "reasoning_compatibility"), false);
});

test("failed and malformed detection never changes compatibility or saves, and output remains plain text", async t => {
  formData(t);
  const h = harness(appFor(fixture(), "chat", "second")), original = structuredClone(h.draft.reasoningCompatibility);
  h.app.saveConfig = () => assert.fail("failure cannot save configuration");
  let response: any = { verified: false, message: '<img src=x onerror="fail()">', requests: 2,
    compatibility: { response_field: "bad", request_field: "bad" }, usage: { input_tokens: null, output_tokens: null } };
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  await h.node("[data-ai-compatibility]").onclick();
  assert.deepEqual(h.draft.reasoningCompatibility, original);
  assert.match(h.node("#compatibility-result").textContent, /<img/);
  assert.doesNotMatch(h.node("#compatibility-result").textContent, /0 输入|0 输出/);
  assert.equal(h.draft.dirty, false);
  const html = renderModels(h.app);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/);
  response = verified({ compatibility: null });
  await h.node("[data-ai-compatibility]").onclick();
  assert.deepEqual(h.draft.reasoningCompatibility, original);
  assert.match(h.node("#compatibility-result").textContent, /不完整/);
});

for (const name of ["base_url", "api_key", "model", "parametersText", "compatibilityAssistant", "compatibilityFill"]) {
  test(`late compatibility result is ignored after ${name} changes, including without input events`, async t => {
    formData(t); const h = harness();
    let complete!: (value: Response) => void;
    t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { complete = resolve; }));
    const pending = h.node("[data-ai-compatibility]").onclick();
    h.values.set(name, name === "parametersText" ? '{"temperature":0.5}' : name === "compatibilityFill" ? "on" : "changed");
    complete(Response.json(verified())); await pending;
    assert.equal(h.draft.reasoningCompatibility, null);
    assert.equal(h.draft.dirty, false);
    assert.doesNotMatch(h.node("#compatibility-result").textContent, /已验证|已填入/);
  });
}

test("switching models, replacing form, or unmounting rejects a late successful result", async t => {
  formData(t);
  for (const kind of ["model", "form", "unmount", "revision"]) {
    const h = harness(); let complete!: (value: Response) => void;
    const mock = t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { complete = resolve; }));
    const pending = h.node("[data-ai-compatibility]").onclick();
    if (kind === "model") h.app.state.modelDraft = { id: "different" };
    if (kind === "form") h.replaceForm(null);
    if (kind === "unmount") h.form.isConnected = false;
    if (kind === "revision") h.app.state.config.revision = "new-revision";
    complete(Response.json(verified())); await pending;
    assert.equal(h.draft.reasoningCompatibility, null);
    mock.mock.restore();
  }
});

test("duplicate detection is suppressed and explicit cancel prevents applying even a racing success", async t => {
  formData(t); const h = harness(); let complete!: (value: Response) => void, signal!: AbortSignal, calls = 0;
  t.mock.method(globalThis, "fetch", (_path: any, init: any) => {
    calls++; signal = init.signal; return new Promise<Response>(resolve => { complete = resolve; });
  });
  const pending = h.node("[data-ai-compatibility]").onclick();
  await h.node("[data-ai-compatibility]").onclick();
  assert.equal(calls, 1); assert.equal(h.node("[data-ai-compatibility]").disabled, true);
  h.node("[data-cancel-compatibility]").onclick(); assert.equal(signal.aborted, true);
  complete(Response.json(verified())); await pending;
  assert.equal(h.draft.reasoningCompatibility, null); assert.match(h.node("#compatibility-result").textContent, /已取消/);
  assert.equal(h.draft.compatibilityRun, undefined); assert.equal(h.draft.compatibilityLoading, false);
});

test("editing the draft aborts detection while helper-only selection does not dirty model configuration", async t => {
  formData(t); const h = harness();
  h.values.set("compatibilityAssistant", "second"); h.form.oninput({ target: { name: "compatibilityAssistant" } });
  assert.equal(h.draft.dirty, false);
  let signal!: AbortSignal;
  t.mock.method(globalThis, "fetch", (_path: any, init: any) => {
    signal = init.signal;
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  });
  const pending = h.node("[data-ai-compatibility]").onclick();
  h.values.set("model", "changed-model"); h.form.oninput();
  await pending;
  assert.equal(signal.aborted, true); assert.equal(h.draft.reasoningCompatibility, null);
  assert.equal(h.draft.model, "changed-model"); assert.equal(h.draft.dirty, true);
});

test("stored mapping labels and helper model names are escaped when rendered", () => {
  const config: any = fixture(); config.models[0].reasoning_compatibility = { response_field: '<img src=x onerror="fail()">', request_field: '" onclick="fail()' };
  config.models[1].name = "</select><script>fail()</script>";
  const html = renderModels(appFor(config));
  assert.match(html, /&lt;img/); assert.match(html, /&lt;\/select&gt;&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script/);
});

test("partial saved mappings display the actual default for the other direction", () => {
  const config: any = fixture();
  config.models[0].reasoning_compatibility = { request_field: "thought" };
  assert.match(renderModels(appFor(config)), /读取：现有字段识别；回传：thought/);
  config.models[0].reasoning_compatibility = { response_field: "metadata.thought" };
  assert.match(renderModels(appFor(config)), /读取：metadata.thought；回传：reasoning_content/);
});

test("saving cancels active diagnostics and blocks a new request until saving finishes", async t => {
  formData(t); const h = harness();
  let finishSave!: () => void, calls = 0, signal!: AbortSignal;
  h.app.saveConfig = () => new Promise<void>(resolve => { finishSave = resolve; });
  t.mock.method(globalThis, "fetch", (_path: any, init: any) => {
    calls++; signal = init.signal;
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  });
  const detecting = h.node("[data-ai-compatibility]").onclick();
  const saving = h.form.onsubmit({ preventDefault() {} });
  assert.equal(signal.aborted, true);
  assert.equal(h.app.state.modelSaving, true);
  await detecting;
  assert.equal(h.node("[data-ai-compatibility]").disabled, true, "diagnostic cleanup must respect the pending save");
  await h.node("[data-ai-compatibility]").onclick();
  assert.equal(calls, 1);
  assert.match(renderModels(h.app), /data-ai-compatibility disabled/);
  finishSave(); await saving;
  assert.equal(h.app.state.modelSaving, false);
  assert.equal(h.node("[data-ai-compatibility]").disabled, false);
});

test("a failed save also unlocks compatibility detection without changing the saved model", async t => {
  formData(t); const h = harness();
  const before = structuredClone(h.app.state.config);
  h.app.saveConfig = async () => { throw Error("synthetic save conflict"); };
  await h.form.onsubmit({ preventDefault() {} });
  assert.equal(h.app.state.modelSaving, false);
  assert.equal(h.node("[data-ai-compatibility]").disabled, false);
  assert.deepEqual(h.app.state.config, before);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(verified()); });
  await h.node("[data-ai-compatibility]").onclick();
  assert.equal(calls, 1);
});

test("full model-page rendering aborts the old form request while ordinary progress does not rerender", async t => {
  formData(t); const h = harness();
  let signal!: AbortSignal, renders = 0;
  h.app.render = () => { renders++; };
  t.mock.method(globalThis, "fetch", (_path: any, init: any) => {
    signal = init.signal;
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  });
  const pending = h.node("[data-ai-compatibility]").onclick();
  assert.equal(signal.aborted, false);
  assert.equal(renders, 0);
  renderModels(h.app);
  assert.equal(signal.aborted, true);
  await pending;
  assert.equal(h.draft.reasoningCompatibility, null);
  assert.equal(h.draft.compatibilityLoading, false);
  assert.equal(h.node("[data-ai-compatibility]").disabled, false);
});

test("adding a custom sibling model cancels detection before its shared draft save", async t => {
  formData(t); const h = harness();
  let signal!: AbortSignal, submit!: (data: any) => Promise<void>, finishSave!: () => void, saved: any;
  h.app.dialog = (_title: string, _body: string, callback: typeof submit) => { submit = callback; };
  h.app.saveConfig = (value: any) => { saved = value; return new Promise<void>(resolve => { finishSave = resolve; }); };
  t.mock.method(globalThis, "fetch", (_path: any, init: any) => {
    signal = init.signal;
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  });
  const pending = h.node("[data-ai-compatibility]").onclick();
  h.node("[data-custom-model]").onclick();
  const saving = submit(new Map([["model", "third"], ["name", "Third"]]));
  assert.equal(signal.aborted, true); assert.equal(h.app.state.modelSaving, true);
  await pending;
  assert.equal(h.node("[data-ai-compatibility]").disabled, true);
  assert.deepEqual(saved.models[1].reasoning_compatibility, mapping);
  assert.equal(saved.models.at(-1).model, "third");
  finishSave(); await saving;
  assert.equal(h.app.state.modelSaving, false);
  assert.equal(h.node("[data-ai-compatibility]").disabled, false);
});
