/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { CACHE_TEST_PLAN, cacheTestPlan, runCacheProbe } from "../core/cache-probe.ts";

const logger: any = { info() {}, error() {} };
const waitForCache = async () => {};
const provider = { protocol: "openai-compatible", model: "synthetic", base_url: "https://relay.invalid/v1",
  enabled: true, api_key: "DUMMY_KEY", parameters: {} };
const mira = { ...provider, model: "deepseek-v4-flash-0731", base_url: "https://api.mirarouter.com/v1",
  parameters: { thinking: { type: "enabled" }, provider: { only: ["synthetic/upstream"] }, temperature: 0.2 } };
type Request = { body: any; round: number; isStable: boolean; code: string };
const usage = (r: Request) => ({ prompt_tokens: 4400, completion_tokens: 24, prompt_cache_hit_tokens: r.isStable ? 4250 : 128,
  cost: r.isStable ? 0.0002 : 0.001, currency: "USD" });
function sse(text: string, raw: any, finish_reason = "stop") {
  const chunks = [{ choices: [{ finish_reason, delta: { content: text } }] }, { choices: [], usage: raw }];
  return new Response(chunks.map(c => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n");
}
function transport(t: TestContext, reply: (r: Request, signal: AbortSignal) => Response | Promise<Response>) {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body), penultimate = body.messages.at(-2);
    const system = body.messages.find((m: any) => m.role === "system" && m.content.includes("本轮合成回执码为"));
    const request = { body, round: Math.floor(requests.length / 2) + 1, isStable: penultimate.role === "system",
      code: system.content.match(/本轮合成回执码为 ([0-9A-F]{6})/)[1] };
    requests.push(request);
    return reply(request, init.signal);
  });
  return requests;
}

test("planning is local, estimates both arms and all warm-ups, and binds catalog rates to endpoint + model", t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw Error("must not contact a model"); });
  for (const [model, cached, input, output] of [
    ["deepseek-v4-flash-0731", 0.012, 0.12, 0.24], ["deepseek-v4.1-flash", 0.0035, 0.135, 0.54],
  ] as const) {
    const plan = cacheTestPlan({ ...mira, model }), estimate = plan.estimated_cost!;
    assert.equal(plan.max_requests, 2 * (plan.warmup_per_layout + plan.measured_per_layout));
    assert.equal(estimate.currency, "USD"); assert.equal(estimate.basis, "reference");
    assert.equal(estimate.min, plan.estimated_input_tokens * cached / 1e6);
    assert.equal(estimate.max, (plan.estimated_input_tokens * input + plan.max_requests * plan.max_output_tokens * output) / 1e6);
    assert.equal(estimate.source, "https://mirarouter.com/api/models"); assert.ok(estimate.price_date);
  }
  assert.equal(cacheTestPlan({ ...provider, model: mira.model }).estimated_cost, null);
  assert.equal(cacheTestPlan({ ...mira, model: "another-model" }).estimated_cost, null);
  assert.equal(cacheTestPlan({ ...mira, base_url: mira.base_url + "/proxy" }).estimated_cost, null);
  assert.equal(cacheTestPlan({ ...mira, protocol: "custom" }).estimated_cost, null);
  const ds = cacheTestPlan({ ...provider, base_url: "https://api.deepseek.com/v1", model: "deepseek-v4-flash" });
  assert.equal(ds.estimated_cost?.currency, "CNY");
  assert.equal(fetch.mock.callCount(), 0);
});

test("the production SSE path runs bounded interleaved frames with identical paired history and a changing verified reference", async t => {
  const requests = transport(t, r => sse(r.code, { ...usage(r), currency: undefined, private_note: "PRIVATE_USAGE" }));
  const saved = structuredClone(mira);
  const result = await runCacheProbe({ provider: mira, logger, waitForCache });
  assert.equal(result.requests, 8); assert.equal(result.verdict, "better");
  assert.deepEqual(requests.map(r => r.isStable), [false, true, true, false, false, true, true, false]);
  assert.deepEqual(result.samples.map(s => s.warmup), [true, true, true, true, false, false, false, false]);
  for (let i = 0; i < requests.length; i += 2) {
    const [a, b] = requests.slice(i, i + 2);
    assert.equal(a.code, b.code); assert.deepEqual(a.body.messages.at(-1), b.body.messages.at(-1));
    const history = (r: Request) => r.body.messages.filter((m: any) => m.role !== "system");
    assert.deepEqual(history(a), history(b)); assert.equal(history(a).length, 69 + i);
    assert.ok(!a.body.messages.at(-1).content.includes(a.code));
    for (const r of [a, b]) {
      assert.deepEqual(Object.keys(r.body).sort(), ["max_tokens", "messages", "model", "stream", "stream_options", "thinking", "provider", "temperature"].sort());
      assert.deepEqual(r.body.thinking, saved.parameters.thinking); assert.equal(r.body.model, saved.model);
      assert.deepEqual(r.body.provider, saved.parameters.provider); assert.equal(r.body.temperature, saved.parameters.temperature);
      assert.equal(r.body.max_tokens, 320); assert.equal(r.body.stream_options.include_usage, true);
      assert.ok(Buffer.byteLength(JSON.stringify(r.body.messages)) <= CACHE_TEST_PLAN.max_message_bytes_per_request);
    }
  }
  assert.deepEqual(mira, saved);
  assert.equal(result.summaries.stable.measured, 2);
  assert.equal(result.summaries.stable.hit_tokens, 8500);
  assert.equal(result.summaries.stable.cost?.basis, "reported");
  assert.equal(result.summaries.stable.cost?.amount, 0.0004);
  assert.equal(result.total.input_tokens, 4400 * 8);
  assert.ok(Math.abs(result.total.cost!.amount! - 0.0048) < 1e-12);
  assert.ok(!/DUMMY_KEY|PRIVATE_USAGE|演练资料第|web_search_options/.test(JSON.stringify(result)));
});

test("the current price sheet yields a distinct reference estimate when this relay omits usage.cost", async t => {
  transport(t, r => sse(r.code, { ...usage(r), cost: undefined, currency: undefined }));
  const result = await runCacheProbe({ provider: mira, logger, waitForCache });
  assert.equal(result.verdict, "better");
  assert.equal(result.summaries.stable.cost?.basis, "reference");
  assert.equal(result.summaries.stable.cost?.currency, "USD");
});

for (const scenario of [
  { name: "unknown cache", patch: () => ({ prompt_cache_hit_tokens: undefined }), verdict: "inconclusive", hits: null },
  { name: "explicit cold zero", patch: () => ({ prompt_cache_hit_tokens: 0 }), verdict: "inconclusive", hits: 0 },
  { name: "contradictory cache fields", patch: () => ({ prompt_tokens_details: { cached_tokens: 17 } }), verdict: "inconclusive", hits: null },
  { name: "improvement only during warmup", patch: (r: Request) => r.round > 2 ? { prompt_cache_hit_tokens: 1024, cost: 0.001 } : {}, verdict: "keep" },
  { name: "only one formal success", patch: (r: Request) => r.round === 4 ? { prompt_cache_hit_tokens: 1024, cost: 0.001 } : {}, verdict: "inconclusive" },
  { name: "better hits higher cost", patch: (r: Request) => ({ cost: r.isStable ? 0.002 : 0.001 }), verdict: "keep" },
  { name: "zero cost both arms", patch: () => ({ cost: 0 }), verdict: "keep" },
  { name: "unknown cost currency", patch: () => ({ currency: undefined }), verdict: "inconclusive" },
  { name: "mixed currencies", patch: (r: Request) => ({ currency: r.isStable ? "EUR" : "USD" }), verdict: "inconclusive" },
  { name: "conflicting currency declarations", patch: () => ({ cost_currency: "EUR" }), verdict: "inconclusive" },
  { name: "uncalibrated upstream amount", patch: () => ({ cost: undefined, cost_details: { upstream_inference_cost: 0.003 } }), verdict: "inconclusive" },
  { name: "unmatched input sizes", patch: (r: Request) => ({ prompt_tokens: r.isStable ? 9000 : 4400 }), verdict: "inconclusive" },
] as const) test("comparison handles " + scenario.name, async t => {
  const requests = transport(t, r => sse(r.code, { ...usage(r), ...scenario.patch(r) }));
  const result = await runCacheProbe({ provider, logger, waitForCache });
  assert.equal(result.verdict, scenario.verdict);
  assert.equal(requests.length, 8);
  assert.equal(requests[0].body.thinking, undefined);
  if ("hits" in scenario) assert.equal(result.summaries.stable.hit_tokens, scenario.hits);
  if (["unknown cost currency", "uncalibrated upstream amount", "conflicting currency declarations"].some(n => n === scenario.name))
    assert.equal(result.total.cost, null);
  if (scenario.name === "zero cost both arms") assert.equal(result.total.cost?.amount, 0);
});

test("rejects unsupported models before transport and does not follow a failed route", async t => {
  const requests = transport(t, r => r.isStable ? new Response('{"error":{"message":"private vendor text"}}', { status: 400 })
    : sse(r.code, usage(r)));
  for (const change of [{ enabled: false }, { type: "embedding" }, { protocol: "custom" }])
    assert.match((await runCacheProbe({ provider: { ...provider, ...change }, logger })).message, /对话模型/);
  assert.equal(requests.length, 0);
  const result = await runCacheProbe({ provider, logger, waitForCache });
  assert.equal(result.verdict, "inconclusive"); assert.equal(result.requests, 2);
  assert.equal(result.total.input_tokens, null); assert.equal(result.total.cost, null);
  assert.equal(result.summaries.standard.measured, 0); assert.equal(requests.length, 2);
  assert.match(result.message, /第 1 轮稳定前缀.*HTTP 400/);
  assert.ok(!JSON.stringify(result).includes("private vendor text"));
});

test("unsafe paid, free-form or ambiguous settings are blocked by both preview and execution", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw Error("must never request"); });
  for (const parameters of [
    { n: 2 }, { best_of: 2 }, { web_search_options: {} }, { messages: ["private"] }, { instructions: "private" },
    { provider: { order: ["a", "b"] } }, { provider: { only: ["a"], allow_fallbacks: true } },
    { provider: { only: ["a"], order: ["b"] } }, { reasoning: { private_data: "private" } },
    { thinking: { type: "enabled", budget_tokens: 9999 } }, { max_tokens: 100, max_completion_tokens: 120 },
    { max_tokens: 0 }, { max_tokens: "320" }, { temperature: "private" }, { stop: ["private"] },
  ]) {
    const target = { ...mira, parameters }, plan = cacheTestPlan(target);
    assert.ok(plan.unavailable_reason); assert.equal(plan.estimated_cost, null);
    const result = await runCacheProbe({ provider: target, logger, waitForCache });
    assert.equal(result.requests, 0); assert.equal(result.verdict, "inconclusive");
    assert.ok(!result.message.includes("private"));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("preserves the saved output-cap dialect, a smaller cap and reasoning settings", async t => {
  const target = { ...provider, parameters: { max_completion_tokens: 150, reasoning_effort: "low", n: 1 } };
  const requests = transport(t, r => sse(r.code, usage(r)));
  const plan = cacheTestPlan(target);
  assert.equal(plan.max_output_tokens, 150); assert.equal(plan.unavailable_reason, null);
  assert.equal((await runCacheProbe({ provider: target, logger, waitForCache })).verdict, "better");
  assert.equal(requests[0].body.max_tokens, undefined); assert.equal(requests[0].body.max_completion_tokens, 150);
  assert.equal(requests[0].body.n, 1); assert.equal(requests[0].body.reasoning_effort, "low");
  assert.equal(cacheTestPlan({ ...target, parameters: { max_tokens: 99999 } }).max_output_tokens, 320);
});

for (const fail of ["wrong code", "length", "excess output", "tool response"]) test("stops on " + fail + " and retains returned usage", async t => {
  const requests = transport(t, r => sse(fail === "wrong code" ? "WRONG" : r.code,
    { ...usage(r), completion_tokens: fail === "excess output" ? 321 : 24 },
    fail === "length" ? "length" : fail === "tool response" ? "tool_calls" : "stop"));
  const result = await runCacheProbe({ provider, logger, waitForCache });
  assert.equal(result.requests, 1); assert.equal(requests.length, 1); assert.equal(result.verdict, "inconclusive");
  assert.equal(result.samples[0].completed, false); assert.equal(result.total.cost?.amount, 0.001);
});

test("cancellation reaches the active fetch, and a pre-cancelled or interrupted warmup cannot send again", async t => {
  const controller = new AbortController();
  const requests = transport(t, async (_r, signal) => {
    controller.abort();
    assert.equal(signal.aborted, true); throw signal.reason;
  });
  const options = { provider, logger, signal: controller.signal, waitForCache };
  const result = await runCacheProbe(options);
  assert.equal(requests.length, 1); assert.equal(result.requests, 1); assert.equal(result.total.cost, null);
  assert.match(result.message, /取消/);
  const repeat = await runCacheProbe(options);
  assert.equal(repeat.requests, 0); assert.equal(requests.length, 1);
});

test("abort while warming the cache stops before the following pair", async t => {
  const controller = new AbortController();
  const requests = transport(t, r => sse(r.code, usage(r)));
  const result = await runCacheProbe({ provider, logger, signal: controller.signal,
    waitForCache: async signal => { controller.abort(); signal.throwIfAborted(); } });
  assert.equal(requests.length, 2); assert.equal(result.requests, 2); assert.match(result.message, /取消/);
});
