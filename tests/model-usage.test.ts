/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { modelUsageDetails } from "../core/model-usage.ts";
import { requestUsage } from "../core/session-context.ts";

const provider = { id: "deepseek", model_id: "flash-config", model: "deepseek-flash",
  base_url: "https://api.deepseek.com/v1", protocol: "openai-compatible" };
const offPeak = new Date("2026-11-09T20:00:00+08:00");
const peak = new Date("2026-11-09T09:00:00+08:00");
const unknown = { hit_tokens: null, miss_tokens: null, hit_percent: null };
const usage = (extra: any = {}) => ({ prompt_tokens: 1000, completion_tokens: 100, ...extra });
const details = (extra: any = {}, p = provider, when = offPeak) => modelUsageDetails(usage(extra), p, when);
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("cache reports accept both formats and derive a missing partition from a trusted count", () => {
  const expected = { hit_tokens: 750, miss_tokens: 250, hit_percent: 75 };
  for (const raw of [
    { prompt_cache_hit_tokens: 750, prompt_cache_miss_tokens: 250 },
    { prompt_cache_hit_tokens: 750 }, { prompt_cache_miss_tokens: 250 },
    { prompt_tokens_details: { cached_tokens: 750 } },
    { prompt_cache_hit_tokens: 750, prompt_tokens_details: { cached_tokens: 750 }, prompt_cache_miss_tokens: 250 },
  ]) assert.deepEqual(details(raw).cache, expected);
});

test("absent cache details stay unknown, including providers with unrelated token counters", () => {
  for (const extra of [{}, { prompt_tokens_details: {} }, { prompt_tokens_details: null },
    { cache_creation_input_tokens: 800, cached_tokens: 500 }, { total_tokens: 1100 }]) {
    const value = details(extra);
    assert.deepEqual(value.cache, unknown);
    assert.equal(value.cost!.amount, null);
    close(value.cost!.min, 0.00042);
    close(value.cost!.max, 0.0014);
  }
});

test("malformed and conflicting cache fields never turn into a zero or a precise cost", () => {
  for (const value of [-1, 1.5, "0", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1001]) {
    for (const extra of [{ prompt_cache_hit_tokens: value }, { prompt_cache_miss_tokens: value },
      { prompt_tokens_details: { cached_tokens: value } },
      { prompt_cache_hit_tokens: 200, prompt_tokens_details: { cached_tokens: value } }]) {
      const parsed = details(extra);
      assert.deepEqual(parsed.cache, unknown);
      assert.equal(parsed.cost!.amount, null);
    }
  }
  for (const extra of [
    { prompt_cache_hit_tokens: 200, prompt_tokens_details: { cached_tokens: 201 } },
    { prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 700 },
    { prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 1 },
    { prompt_tokens_details: { cached_tokens: 200 }, prompt_cache_miss_tokens: 801 },
  ]) assert.deepEqual(details(extra).cache, unknown);
});

test("explicit zero cache and zero input remain distinct from missing reports", () => {
  assert.deepEqual(details({ prompt_cache_hit_tokens: 0 }).cache,
    { hit_tokens: 0, miss_tokens: 1000, hit_percent: 0 });
  assert.deepEqual(details({ prompt_cache_miss_tokens: 0 }).cache,
    { hit_tokens: 1000, miss_tokens: 0, hit_percent: 100 });
  const zero = details({ prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 });
  assert.deepEqual(zero.cache, { hit_tokens: 0, miss_tokens: 0, hit_percent: null });
  assert.equal(zero.cost!.amount, 0);
  assert.deepEqual(details({ prompt_tokens: 0, completion_tokens: 0 }).cache, unknown);
  assert.equal(details({ prompt_tokens: 0, completion_tokens: 0 }).cost!.amount, null);
});

test("official Flash names and Pro use their verified CNY reference rates", () => {
  for (const model of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    const cost = details({ prompt_cache_hit_tokens: 750 }, { ...provider, model }).cost!;
    close(cost.amount!, 0.000665);
    assert.equal(cost.min, cost.amount); assert.equal(cost.max, cost.amount);
    assert.equal(cost.currency, "CNY"); assert.equal(cost.basis, "reference");
    assert.equal(cost.price_date, "2026-11-09"); assert.equal(cost.period, "off_peak");
  }
  close(details({ prompt_cache_hit_tokens: 750 }, { ...provider, model: "deepseek-v4-pro" }).cost!.amount!, 0.0025875);
  close(details({ prompt_cache_hit_tokens: 1, prompt_tokens: 1, completion_tokens: 0 }).cost!.amount!, 0.00000002);
});

test("weekday peak windows retain the holiday price range instead of guessing a calendar", () => {
  const cost = details({ prompt_cache_hit_tokens: 750 }, provider, peak).cost!;
  assert.equal(cost.amount, null); assert.equal(cost.period, "peak_or_holiday");
  close(cost.min, 0.000665); close(cost.max, 0.00133);
  const noCache = details({}, provider, peak).cost!;
  assert.equal(noCache.amount, null); close(noCache.min, 0.00042); close(noCache.max, 0.0028);
  const holiday = details({ prompt_cache_hit_tokens: 750 }, provider, new Date("2026-10-01T10:00:00+08:00")).cost!;
  assert.equal(holiday.period, "peak_or_holiday"); assert.equal(holiday.amount, null);
});

test("Beijing clock boundaries, lunch, nights and weekends do not depend on the host timezone", () => {
  for (const [time, period] of [
    ["2026-11-09T08:59:59+08:00", "off_peak"], ["2026-11-09T09:00:00+08:00", "peak_or_holiday"],
    ["2026-11-09T11:59:59+08:00", "peak_or_holiday"], ["2026-11-09T12:00:00+08:00", "off_peak"],
    ["2026-11-09T13:59:59+08:00", "off_peak"], ["2026-11-09T14:00:00+08:00", "peak_or_holiday"],
    ["2026-11-09T17:59:59+08:00", "peak_or_holiday"], ["2026-11-09T18:00:00+08:00", "off_peak"],
    ["2026-11-09T23:59:59+08:00", "off_peak"], ["2026-11-14T10:00:00+08:00", "off_peak"],
    ["2026-11-15T15:00:00+08:00", "off_peak"], ["2026-11-09T01:00:00Z", "peak_or_holiday"],
  ]) assert.equal(details({ prompt_cache_hit_tokens: 750 }, provider, new Date(time)).cost!.period, period, time);
  assert.equal(details({}, provider, new Date(NaN)).cost, null);
});

test("unknown providers, model guesses and nonofficial endpoints never inherit official prices", () => {
  for (const extra of [
    { base_url: "https://proxy.example/v1" }, { base_url: "https://api.deepseek.com.example/v1" },
    { base_url: "https://deepseek.com/v1" }, { base_url: "http://api.deepseek.com" },
    { base_url: "https://api.deepseek.com:8443" }, { base_url: "not a url" },
    { base_url: "https://user:secret@api.deepseek.com" }, { protocol: "anthropic" },
    { model: "deepseek-chat" }, { model: "deepseek-reasoner" }, { model: "deepseek-v4.1-flash" },
    { model: "DEEPSEEK-FLASH" }, { model: "deepseek-flash-latest" }, { model: "constructor" },
  ]) {
    const value = details({ prompt_cache_hit_tokens: 750 }, { ...provider, ...extra });
    assert.equal(value.cost, null, JSON.stringify(extra));
    assert.equal(value.cache.hit_percent, 75);
  }
  assert.equal(modelUsageDetails(usage(), null, offPeak).cost, null);
  assert.notEqual(details({}, { ...provider, base_url: "https://api.deepseek.com" }).cost, null);
});

test("incomplete or invalid usage cannot fabricate a cost or replace the old null contract", () => {
  for (const raw of [undefined, null, {}, { prompt_tokens: 10 }, { completion_tokens: 10 },
    { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: NaN },
    { prompt_tokens: "1", completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: 1.5 }]) {
    assert.equal(modelUsageDetails(raw, provider, offPeak).cost, null);
    assert.equal(requestUsage(raw, provider, 1000), null);
  }
});

test("saved request usage distinguishes provider charges from reference and upstream prices", () => {
  const relay = { ...provider, base_url: "https://relay.example/v1" };
  const saved = (extra: any, p = relay) => requestUsage(usage(extra), p, null)!;
  assert.deepEqual(saved({ cost: 0, currency: "CNY" }).reported_cost, { amount: 0, currency: "CNY" });
  assert.deepEqual(saved({ cost: 0.003, cost_currency: "EUR", currency: "EUR" }).reported_cost,
    { amount: 0.003, currency: "EUR" });
  const official = saved({ cost: 0.004, currency: "USD" }, provider);
  assert.equal(official.cost?.currency, "CNY");
  assert.equal(official.reported_cost?.currency, "USD");
  for (const extra of [
    { cost_details: { upstream_inference_cost: 0.01 }, currency: "USD" },
    { cost: 0.004 }, { cost: "0.004", currency: "USD" }, { cost: -1, currency: "USD" },
    { cost: 0.004, cost_currency: "USD", currency: "EUR" }, { cost: 0.004, currency: "secret" },
  ]) assert.equal(Object.hasOwn(saved(extra), "reported_cost"), false);
  assert.deepEqual(saved({ cost: 0.2 }, { ...relay, base_url: "https://api.mirarouter.com/v1/" }).reported_cost,
    { amount: 0.2, currency: "USD" });
  assert.equal(Object.hasOwn(saved({ cost: 0.2 }, { ...relay, base_url: "https://api.mirarouter.com/v1/copy" }),
    "reported_cost"), false);
});

test("requestUsage retains old numeric fields and adds normalized details without raw metadata", () => {
  const raw = usage({ prompt_tokens_details: { cached_tokens: 750, private_detail: "do-not-retain" },
    untrusted_extension: "do-not-retain" });
  const parsed = requestUsage(raw, { ...provider, base_url: "https://ordinary.example/v1" }, 10000)!;
  assert.deepEqual({ model_id: parsed.model_id, model: parsed.model, provider_id: parsed.provider_id,
    input_tokens: parsed.input_tokens, output_tokens: parsed.output_tokens, used_tokens: parsed.used_tokens,
    context_window: parsed.context_window, percent: parsed.percent },
  { model_id: "flash-config", model: "deepseek-flash", provider_id: "deepseek", input_tokens: 1000,
    output_tokens: 100, used_tokens: 1100, context_window: 10000, percent: 11 });
  assert.ok(Number.isFinite(Date.parse(parsed.measured_at)));
  assert.deepEqual(parsed.cache, { hit_tokens: 750, miss_tokens: 250, hit_percent: 75 });
  assert.equal(parsed.cost, null); assert.ok(!JSON.stringify(parsed).includes("do-not-retain"));
  const old = requestUsage(usage(), { id: "ordinary", model: "test" }, null)!;
  assert.equal(old.model_id, "test"); assert.equal(old.percent, null);
  assert.deepEqual(old.cache, unknown); assert.equal(old.cost, null);
});
