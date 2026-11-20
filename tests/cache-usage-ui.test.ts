/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { renderContextMeter } = await import(new URL("../core/ui/context.js", import.meta.url).href);
function context(): any {
  return {
    model: { name: "synthetic", context_window: 10000 },
    context_estimate: { input_tokens: 3000, reserved_output_tokens: 1000, total_tokens: 4000, percent: 40 },
    usage: {
      input_tokens: 2000, output_tokens: 100, used_tokens: 2100, percent: 21,
      measured_at: "2026-11-09T00:00:00Z",
      cache: { hit_tokens: 1500, miss_tokens: 500, hit_percent: 75 },
      cost: { currency: "CNY", amount: 0.0001234567, min: 0.0001234567, max: 0.0001234567,
        price_date: "2026-11-09", period: "off_peak", basis: "reference" },
    },
  };
}
const label = (html: string) => html.match(/<span title="[^"]*">([^<]*)<\/span>/)?.[1] || "";

test("compact context keeps cache percentage and reference cost in one line with request details in its title", () => {
  const value = context(), compact = renderContextMeter(value, true), full = renderContextMeter(value);
  assert.equal(label(compact), "上下文 40.00% · 当前估算 · 缓存 75% · 估算¥0.000123");
  assert.doesNotMatch(compact, /<progress|<p>|<form|<details|<br/);
  assert.match(compact, /title="[^"]*命中 1,500 tokens；未命中 500 tokens；命中率 75%/);
  assert.match(compact, /参考价日期 2026-11-09 · 低峰时段/);
  assert.match(compact, /仅作参考，不等于账单/);
  assert.match(compact, /仅对应最近一次模型请求，不含同轮其他工具调用或日记整理请求/);
  assert.match(full, /最近一次请求缓存：命中 1,500 tokens；未命中 500 tokens；命中率 75%/);
  assert.match(full, /参考费用：¥0.000123/);
  assert.match(full, /<strong>40.00% · 当前估算<\/strong>/);
  assert.match(full, /最近请求实测：输入 2,000 \+ 输出 100 = 2,100 tokens/);
});

test("a reported charge takes precedence and labels this request in chat and memory", () => {
  const value = context();
  for (const [amount, currency] of [[0.000123456789, "USD"], [0, "CNY"]] as const) {
    value.usage.reported_cost = { amount, currency };
    const compact = renderContextMeter(value, true), full = renderContextMeter(value);
    assert.ok(label(compact).endsWith(`本次回传 ${amount} ${currency}`));
    for (const html of [compact, full]) {
      assert.ok(html.includes(`接口回传费用：${amount} ${currency}。实际扣款以服务商账单为准。`));
      assert.match(html, /仅对应最近一次模型请求/);
      assert.doesNotMatch(html, /参考费用|参考价日期|估算¥|价格未知/);
    }
    value.usage.cost = null;
  }
});

test("malformed reported charges fall back to reference prices or unknown", () => {
  const value = context();
  for (const reported of [
    { amount: null, currency: "USD" }, { amount: "0", currency: "USD" }, { amount: NaN, currency: "USD" },
    { amount: Infinity, currency: "USD" }, { amount: -1, currency: "USD" }, { amount: 1 },
    { amount: 1, currency: '<img src=x>' }, { amount: 1, currency: ["USD"] }, { amount: 1, currency: "ZZZ" },
  ]) {
    value.usage.reported_cost = reported;
    assert.match(label(renderContextMeter(value, true)), /估算¥0.000123$/);
    assert.doesNotMatch(renderContextMeter(value), /接口回传费用|<img|NaN|Infinity/);
  }
  value.usage.cost = null;
  assert.match(label(renderContextMeter(value, true)), /价格未知$/);
});

test("unknown or partially reported caches remain distinct from genuine zero usage and unknown prices", () => {
  const value = context();
  value.usage.cache = { hit_tokens: null, miss_tokens: null, hit_percent: null }; value.usage.cost = null;
  assert.equal(label(renderContextMeter(value, true)), "上下文 40.00% · 当前估算 · 缓存未报告 · 价格未知");
  let full = renderContextMeter(value);
  assert.match(full, /命中 未报告；未命中 未报告；命中率 未报告/);
  assert.doesNotMatch(full, /命中 0 tokens|命中率 0%|¥0/);
  value.usage.cache = { hit_tokens: 0, miss_tokens: 2000, hit_percent: 0 };
  full = renderContextMeter(value);
  assert.match(full, /命中 0 tokens；未命中 2,000 tokens；命中率 0%/);
  assert.match(label(renderContextMeter(value, true)), /缓存 0% · 价格未知/);
  value.usage.cache = { hit_tokens: 1500, miss_tokens: null, hit_percent: null };
  assert.match(renderContextMeter(value), /命中 1,500 tokens；未命中 未报告；命中率 未报告/);
  delete value.usage.cache; delete value.usage.cost;
  assert.match(label(renderContextMeter(value, true)), /缓存未报告 · 价格未知/);
  value.usage = null;
  assert.match(renderContextMeter(value), /尚无此模型和人格的实测记录/);
  assert.doesNotMatch(renderContextMeter(value), /NaN|undefined|¥0/);
});

test("reference ranges and tiny nonzero costs never imply an exact bill or round small costs to zero", () => {
  const value = context();
  value.usage.cost = { ...value.usage.cost, amount: null, min: 0.000017, max: 0.0023456789, period: "peak_or_holiday" };
  assert.match(label(renderContextMeter(value, true)), /估算¥0.000017–¥0.002346/);
  assert.match(renderContextMeter(value), /高峰或节假日/);
  value.usage.cost.amount = 0.0000002;
  assert.match(label(renderContextMeter(value, true)), /估算&lt;¥0.000001/);
  value.usage.cost.amount = 0;
  assert.match(label(renderContextMeter(value, true)), /估算¥0$/);
  value.usage.cost.amount = null; value.usage.cost.min = null;
  assert.match(label(renderContextMeter(value, true)), /价格未知/);
});

test("cache reporting is independent of context capacity and reference metadata is escaped", () => {
  const value = context(); value.model.context_window = null;
  value.usage.cost.price_date = '<img src=x onerror="bad()">';
  const compact = renderContextMeter(value, true), full = renderContextMeter(value);
  assert.match(label(compact), /上下文 容量未知.*缓存 75%/);
  assert.match(compact, /href="#models">填写模型容量/);
  assert.doesNotMatch(full, /<progress|40.00%|<img|onerror="bad/);
  assert.match(full, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  for (const pending of [null, { error: "<synthetic-error>" }]) {
    const rendered = renderContextMeter(pending, true);
    assert.doesNotMatch(label(rendered), /缓存|价格|估算¥/);
  }
});
