/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
const { renderModels, bindModels } = await import(new URL("../core/ui/models.js", import.meta.url).href);

const config = {
  revision: "before", providers: [{ id: "relay", name: "Relay", protocol: "openai-compatible", enabled: true, base_url: "https://relay.invalid/v1" }],
  models: [{ id: "id/a", name: "First", model: "provider-model", type: "chat", enabled: true, provider: "relay" }],
  bindings: { chat: "id/a" }, personas: [],
};
const report = {
  model: "id/a", revision: "before", mode: "standard", advice: { code: "test", message: "低命中" }, confirm_token: "paid-once",
  observed: { window_days: 7, max_turns: 12, long_input_tokens: 4096, turns: 3, measured_turns: 3, long_turns: 3, measured_long_turns: 3, cached_input_percent: 5 },
  plan: { max_requests: 8, warmup_per_layout: 2, measured_per_layout: 2, max_output_tokens_per_request: 320, estimated_input_tokens: 36500, estimated_cost: null },
};
const amount = (n: number) => ({ amount: n, min: n, max: n, currency: "USD", basis: "reported" });
const sample = { measured: 2, input_tokens: 9000, output_tokens: 100, hit_tokens: 5000, miss_tokens: 4000, hit_percent: 55.5, cost: amount(0.002) };
const result = { model: "id/a", revision: "before", test_id: "apply-once", verdict: "better", requests: 8, message: "<result>",
  summaries: { standard: { ...sample, cost: amount(0.003) }, stable: sample }, total: { ...sample, cost: amount(0.009) } };

function harness() {
  const app: any = { state: { config: structuredClone(config), page: "models", modelFilter: "chat" }, render() {}, toast() {} };
  const html = renderModels(app);
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { addEventListener() {}, classList: { toggle() {} }, textContent: "", innerHTML: "" });
    return nodes.get(selector);
  };
  const form = { elements: {}, querySelector: node, querySelectorAll: () => [] };
  const switchModel: any = { dataset: { editModel: "sibling" } };
  app.content = { querySelector: (selector: string) => selector === "#connection-form" ? form : null,
    querySelectorAll: (selector: string) => selector === "[data-edit-model]" ? [switchModel] : [] };
  bindModels(app);
  const panel = node(".model-cache");
  const action = (name: string) => panel.onclick({ target: { closest: () => ({ dataset: { cacheAction: name } }) } });
  return { html, app, panel, action, switchModel };
}
test("cache check, confirmed paid test and apply are three independent actions on the saved configuration ID", async t => {
  const h = harness();
  const next = { ...config, revision: "after" };
  const calls: { path: string; body: any }[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json([report, result, next][calls.length - 1]);
  });
  assert.match(h.html, /检查缓存效果/);
  assert.doesNotMatch(h.html, /确认费用|为此模型启用稳定前缀/);
  await h.action("test"); await h.action("apply"); await h.action("inspect");
  assert.deepEqual(calls, [{ path: "/api/cache-diagnostics?model=id%2Fa", body: undefined }]);
  for (const text of ["8 次真实模型请求", "36,500", "320", "输入和输出", "不含真实聊天", "单价未知"])
    assert.ok(h.panel.innerHTML.includes(text), text);
  await h.action("apply"); await h.action("test"); await h.action("test");
  assert.deepEqual(calls[1], { path: "/api/cache-diagnostics/test",
    body: { model: "id/a", revision: "before", confirm_paid: true, confirm_token: "paid-once" } });
  assert.equal(calls.length, 2);
  assert.deepEqual(h.app.state.config, config);
  assert.match(h.panel.innerHTML, /合计节省 0.001 USD/);
  assert.match(h.panel.innerHTML, /&lt;result&gt;/);
  await h.action("apply");
  assert.deepEqual(calls[2], { path: "/api/cache-diagnostics/apply", body: { model: "id/a", revision: "before", enabled: true, test_id: "apply-once" } });
  assert.deepEqual(h.app.state.config, next);
});

test("builtin layouts, unknown metrics, insufficient history and unavailable plans do not offer a paid call", async t => {
  for (const [mode, code, reason] of [["builtin", "test", ""], ["standard", "unknown", ""], ["standard", "insufficient", ""],
    ["standard", "healthy", ""], ["standard", "test", "高级参数无法安全复现"]]) {
    const h = harness();
    let calls = 0;
    const fn = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json({ ...report, mode, advice: { code, message: "继续正常使用" },
        observed: { ...report.observed, cached_input_percent: null }, plan: { ...report.plan, unavailable_reason: reason } });
    });
    await h.action("inspect");
    assert.doesNotMatch(h.panel.innerHTML, /确认费用|为此模型启用|关闭此模型/);
    assert.match(h.panel.innerHTML, /缓存命中率为 未知/);
    if (mode === "builtin") assert.match(h.panel.innerHTML, /默认启用的内置稳定前缀/);
    if (reason) assert.ok(h.panel.innerHTML.includes(reason));
    await h.action("test"); await h.action("apply"); await h.action("disable");
    assert.equal(calls, 1);
    fn.mock.restore();
  }
});

test("an inconclusive or more expensive result stays read-only and costs keep their provenance", async t => {
  for (const [cost, text] of [[null, "缺少同一口径"], [amount(0.005), "合计多花 0.002 USD"],
    [{ ...amount(0.005), basis: "reference" }, "缺少同一口径"]] as const) {
    const h = harness();
    let calls = 0;
    const fn = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json({ ...report, result: { ...result, verdict: "inconclusive",
        summaries: { standard: result.summaries.standard, stable: { ...sample, cost } } } });
    });
    await h.action("inspect"); await h.action("apply"); await h.action("test");
    assert.ok(h.panel.innerHTML.includes(text));
    assert.doesNotMatch(h.panel.innerHTML, /为此模型启用|确认费用/);
    assert.equal(calls, 1);
    fn.mock.restore();
  }
});

test("only a previously applied model can be switched back, with its current revision", async t => {
  const h = harness();
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_path: string, init: RequestInit) => {
    bodies.push(init.body && JSON.parse(String(init.body)));
    return Response.json(bodies.length === 1 ? { ...report, mode: "optimized" } : { ...config, revision: "after" });
  });
  await h.action("inspect"); await h.action("apply"); await h.action("test");
  assert.match(h.panel.innerHTML, /关闭此模型的稳定前缀/);
  assert.equal(bodies.length, 1);
  await h.action("disable");
  assert.deepEqual(bodies[1], { model: "id/a", revision: "before", enabled: false });
});

test("cancel or page replacement aborts a paid call and rejects even a racing success", async t => {
  const events = new EventTarget();
  const add = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  const remove = Object.getOwnPropertyDescriptor(globalThis, "removeEventListener");
  Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: events.addEventListener.bind(events) });
  Object.defineProperty(globalThis, "removeEventListener", { configurable: true, value: events.removeEventListener.bind(events) });
  t.after(() => {
    if (add) Object.defineProperty(globalThis, "addEventListener", add); else Reflect.deleteProperty(globalThis, "addEventListener");
    if (remove) Object.defineProperty(globalThis, "removeEventListener", remove); else Reflect.deleteProperty(globalThis, "removeEventListener");
  });
  for (const exit of ["cancel", "render", "switch", "navigate"]) {
    const h = harness();
    let finish!: (response: Response) => void, signal!: AbortSignal;
    const fn = t.mock.method(globalThis, "fetch", (_path: string, init: RequestInit) => {
      if (!init.body) return Promise.resolve(Response.json(report));
      signal = init.signal!;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    await h.action("inspect");
    const pending = h.action("test");
    assert.match(h.panel.innerHTML, /停止后续请求/);
    if (exit === "cancel") await h.action("cancel");
    if (exit === "render") renderModels(h.app);
    if (exit === "switch") h.switchModel.onclick();
    if (exit === "navigate") events.dispatchEvent(new Event("hashchange"));
    assert.ok(signal.aborted);
    finish(Response.json(result)); await pending;
    if (exit !== "switch") assert.match(h.panel.innerHTML, /已发出的请求仍可能计费/);
    else assert.equal(h.app.state.modelSelection, "sibling");
    assert.doesNotMatch(h.panel.innerHTML, /为此模型启用/);
    assert.deepEqual(h.app.state.config, config);
    fn.mock.restore();
  }
});

test("dirty and stale configurations cannot perform an action, and applied state is never assumed on failure", async t => {
  const h = harness();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? Response.json({ ...report, result }) : Response.json({ error: "配置已变化" }, { status: 409 });
  });
  const d = h.app.state.modelDraft;
  d.dirty = true;
  await h.action("inspect");
  assert.equal(calls, 0);
  d.dirty = false;
  await h.action("inspect");
  assert.match(h.panel.innerHTML, /为此模型启用/);
  await h.action("apply");
  assert.deepEqual(h.app.state.config, config);
  assert.match(h.panel.innerHTML, /配置已变化/);
  assert.doesNotMatch(h.panel.innerHTML, /关闭此模型|为此模型启用/);
  h.app.state.config.revision = "changed";
  await h.action("inspect");
  assert.equal(calls, 2);
});
