/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { contextFrame } from "./context-material.ts";
import type { Diagnostics } from "./diagnostics.ts";
import { LLM } from "./llm.ts";
import type { Logger } from "./logger.ts";
import { ModelRequestError } from "./model-http.ts";
import { modelUsageDetails, type CacheUsage } from "./model-usage.ts";
import { timeContext } from "./time.ts";

export const CACHE_TEST_PLAN = Object.freeze({
  max_requests: 8, warmup_per_layout: 2, measured_per_layout: 2,
  max_output_tokens: 320, max_output_tokens_per_request: 320,
  max_message_bytes_per_request: 32 * 1024, timeout_seconds: 180,
  // The equivalent 34-exchange fixture previously measured about 4.4k per request.
  estimated_input_tokens: 4500 * 8,
});
const miraCatalog = "https://mirarouter.com/api/models";
const deepSeekPricing = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
// Public USD per million tokens at this exact endpoint. No price discovery call.
const miraRates = new Map<string, { input: number; cache: number; output: number }>([
  ["deepseek-v4-flash-0731", { input: 0.12, cache: 0.012, output: 0.24 }],
  ["deepseek-v4.1-flash", { input: 0.135, cache: 0.0035, output: 0.54 }],
]);
const mira = (provider: any) => provider?.base_url?.replace(/\/+$/, "") === "https://api.mirarouter.com/v1" &&
  (provider.protocol ?? "openai-compatible") === "openai-compatible";
type Cost = {
  currency: string; basis: "reference" | "reported"; min: number; max: number; amount: number | null;
  price_date?: string; source?: string;
};

const simpleNumber = new Set(["temperature", "top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "seed"]);
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const object = (value: any): value is Record<string, any> => value != null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function fixedRoute(route: unknown) {
  if (!object(route) || Object.keys(route).some(k => !["only", "order", "allow_fallbacks"].includes(k))) return false;
  // Preserve a user-pinned upstream; never test a new route or permit an explicit fallback.
  if (route.allow_fallbacks !== undefined && route.allow_fallbacks !== false) return false;
  const pinned = (v: any) => Array.isArray(v) && v.length === 1 && typeof v[0] === "string" && /^[a-z\d][a-z\d_.\/-]{0,79}$/i.test(v[0]);
  if (route.only !== undefined && !pinned(route.only) || route.order !== undefined && !pinned(route.order)) return false;
  if (!route.only && !(route.order && route.allow_fallbacks === false)) return false;
  return !route.only || !route.order || route.only[0] === route.order[0];
}
function allowedParameter(key: string, value: any, output: number) {
  if (simpleNumber.has(key)) return Number.isFinite(value);
  if (key === "n" || key === "best_of") return value === 1;
  if (key === "max_tokens" || key === "max_completion_tokens") return positive(value);
  if (key === "enable_thinking") return typeof value === "boolean";
  if (key === "reasoning_effort") return efforts.has(value);
  if (key === "thinking") return object(value) && Object.keys(value).every(k => k === "type" || k === "budget_tokens") &&
    ["disabled", "enabled", "adaptive"].includes(value.type) &&
    (value.budget_tokens === undefined || positive(value.budget_tokens) && value.budget_tokens < output);
  if (key === "reasoning") return object(value) && Object.entries(value).every(([k, v]) =>
    k === "effort" ? efforts.has(v) : k === "enabled" || k === "exclude" ? typeof v === "boolean" :
    k === "max_tokens" && positive(v) && v < output);
  return key === "provider" && fixedRoute(value);
}
function requestSettings(provider: any) {
  const parameters = provider?.parameters === undefined ? {} : provider.parameters;
  let maximum: number = CACHE_TEST_PLAN.max_output_tokens;
  let reason: string | null = null;
  if (!provider?.model || provider.enabled === false || (provider.type !== undefined && provider.type !== "chat") ||
      (provider.protocol ?? "openai-compatible") !== "openai-compatible")
    reason = "请选择已启用的 OpenAI 兼容对话模型。";
  else if (!object(parameters) || parameters.max_completion_tokens !== undefined && parameters.max_tokens !== undefined)
    reason = "模型参数无效或同时配置了两种输出上限，无法保证测试的请求范围。";
  else {
    const limit = parameters.max_completion_tokens ?? parameters.max_tokens;
    if (positive(limit)) maximum = Math.min(maximum, limit);
    const blocked = Object.entries(parameters).find(([key, value]) => !allowedParameter(key, value, maximum));
    if (blocked) {
      const name = /^[a-z][a-z0-9_]{0,39}$/.test(blocked[0]) ? " " + blocked[0] : "";
      reason = `无法在相同路由和付费上限内安全复用此模型的参数${name}，已停用主动测试。`;
    }
  }
  const outputKey = object(parameters) && Object.hasOwn(parameters, "max_completion_tokens") ? "max_completion_tokens" : "max_tokens";
  return { maximum, reason, parameters: reason ? {} : { ...parameters, [outputKey]: maximum } };
}

/** An estimate for the whole experiment, including warm-ups. Never a spending limit. */
export function cacheTestPlan(provider: any) {
  const { maximum, reason } = requestSettings(provider);
  const plan = { ...CACHE_TEST_PLAN, max_output_tokens: maximum, max_output_tokens_per_request: maximum, unavailable_reason: reason };
  const input = CACHE_TEST_PLAN.estimated_input_tokens;
  const output = CACHE_TEST_PLAN.max_requests * maximum;
  let estimated_cost: Cost | null = null;
  if (reason) return { ...plan, estimated_cost };
  const rates = mira(provider) && miraRates.get(provider.model);
  if (rates) {
    estimated_cost = { currency: "USD", basis: "reference", amount: null, price_date: "2026-11-20", source: miraCatalog,
      min: input * rates.cache / 1e6, max: (input * rates.input + output * rates.output) / 1e6 };
  } else {
    const now = new Date();
    const low = modelUsageDetails({ prompt_tokens: input, prompt_cache_hit_tokens: input, completion_tokens: 0 }, provider, now).cost;
    const high = modelUsageDetails({ prompt_tokens: input, prompt_cache_hit_tokens: 0, completion_tokens: output }, provider, now).cost;
    if (low && high) estimated_cost = { currency: low.currency, basis: "reference", amount: null, min: low.min,
      max: high.max, price_date: low.price_date, source: deepSeekPricing };
  }
  return { ...plan, estimated_cost };
}

type Layout = "standard" | "stable";
type Sample = {
  layout: Layout; round: number; warmup: boolean; completed: boolean;
  input_tokens: number | null; output_tokens: number | null; hit_tokens: number | null;
  miss_tokens: number | null; hit_percent: number | null; cost: Cost | null;
};
type Verdict = "better" | "keep" | "inconclusive";
const supportedCurrencies = new Set<string>(Intl.supportedValuesOf("currency"));
const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

function sampleCost(raw: any, provider: any, cache: CacheUsage, reference: ReturnType<typeof modelUsageDetails>["cost"]): Cost | null {
  if (typeof raw?.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0) {
    const currencies = [raw.cost_currency, raw.currency].filter(value => value !== undefined);
    const currency = currencies.length ? currencies[0] : mira(provider) ? "USD" : null;
    if (supportedCurrencies.has(currency) && currencies.every(value => value === currency))
      return { basis: "reported", currency, amount: raw.cost, min: raw.cost, max: raw.cost };
  }
  if (raw?.cost != null) return null;
  if (reference) return { basis: "reference", currency: reference.currency, amount: reference.amount,
    min: reference.min, max: reference.max, price_date: reference.price_date, source: deepSeekPricing };
  const rates = mira(provider) && miraRates.get(provider.model);
  const input = count(raw?.prompt_tokens), output = count(raw?.completion_tokens);
  if (!rates || input === null || output === null) return null;
  const cached = cache.hit_tokens !== null && cache.miss_tokens !== null;
  const inputMin = cached ? cache.hit_tokens! * rates.cache + cache.miss_tokens! * rates.input : input * rates.cache;
  const inputMax = cached ? inputMin : input * rates.input;
  const min = (inputMin + output * rates.output) / 1e6, max = (inputMax + output * rates.output) / 1e6;
  return { basis: "reference", currency: "USD", amount: cached ? min : null, min, max, price_date: "2026-11-20", source: miraCatalog };
}

function summarize(samples: Sample[]) {
  const sum = (key: "input_tokens" | "output_tokens" | "hit_tokens" | "miss_tokens") => {
    if (!samples.length || samples.some(sample => sample[key] === null)) return null;
    return count(samples.reduce((n, sample) => n + sample[key]!, 0));
  };
  const input = sum("input_tokens"), hits = sum("hit_tokens");
  const first = samples[0]?.cost;
  let cost: Cost | null = null;
  if (first && samples.every(s => s.cost?.basis === first.basis && s.cost.currency === first.currency &&
      s.cost.price_date === first.price_date)) {
    const min = samples.reduce((n, s) => n + s.cost!.min, 0);
    const max = samples.reduce((n, s) => n + s.cost!.max, 0);
    if (Number.isFinite(max)) cost = { ...first, min, max, amount: samples.every(s => s.cost!.amount !== null) ? min : null };
  }
  return { measured: samples.length, input_tokens: input, output_tokens: sum("output_tokens"),
    hit_tokens: hits, miss_tokens: sum("miss_tokens"), hit_percent: input && hits !== null ? 100 * hits / input : null, cost };
}

function evaluate(standard: Sample[], stable: Sample[]): [Verdict, string] {
  const pairs = standard.map((a, i) => ({ a, b: stable[i] }));
  if (pairs.length !== CACHE_TEST_PLAN.measured_per_layout || stable.length !== pairs.length ||
      pairs.some(({ a, b }) => a.round !== b.round || a.hit_percent === null || b.hit_percent === null))
    return ["inconclusive", "配对样本缺少有效的输入或缓存计量，无法判断哪种布局更省。"];
  if (pairs.some(({ a, b }) => Math.min(a.input_tokens!, b.input_tokens!) < 1024 ||
      Math.max(a.input_tokens!, b.input_tokens!) > 1.1 * Math.min(a.input_tokens!, b.input_tokens!)))
    return ["inconclusive", "两种布局返回的输入用量过小或相差超过 10%，无法可靠比较。"];
  if (pairs.some(({ a, b }) => !a.hit_tokens && !b.hit_tokens))
    return ["inconclusive", "至少一组正式对照中两种布局都报告零命中，未能确认缓存已预热。"];
  const advantage = (a: Sample, b: Sample) =>
    b.hit_percent! - a.hit_percent! >= 10 && a.miss_tokens! - b.miss_tokens! >= 128;
  const improved = pairs.every(({ a, b }) => advantage(a, b));
  const first = pairs[0].a.cost;
  if (!first || ![...standard, ...stable].every(s => s.cost?.currency === first.currency &&
      s.cost.basis === first.basis && s.cost.price_date === first.price_date))
    return ["inconclusive", improved ? "稳定前缀在两轮都减少了未命中输入，但缺少币种和口径一致的费用，无法确认节省。"
      : "两种布局没有足够的可比费用数据，无法确认切换后会更省。"];
  const cheaper = pairs.every(({ a, b }) => b.cost!.max < a.cost!.min);
  if (improved && cheaper) return ["better", "两轮正式对照中，稳定前缀的命中率均提高至少 10 个百分点，未命中输入均减少至少 128 token，费用也均较低。"];
  if (pairs.every(({ a, b }) => b.cost!.min >= a.cost!.max))
    return ["keep", "两轮正式对照均未显示稳定前缀可以降低费用，建议保留当前设置。"];
  return ["inconclusive", "两轮的缓存改善和费用下降未同时得到确认，暂时保留当前设置。"];
}

/** Fixed fictional records. A pair shares the same history, clock, question and expected reply. */
function syntheticHistory(start: number) {
  const rows: { role: string; content: string; type: string; origin: { channel: string }; ts: string }[] = [];
  function append(role: string, content: string, timestamp: number) {
    rows.push({ role, content, type: "message", origin: { channel: "web" }, ts: new Date(timestamp).toISOString() });
  }
  const colours = ["蓝", "黄", "绿", "白", "紫", "橙"];
  for (let i = 0; i < 34; i++) {
    const batch = "W" + (3100 + 7 * i), rack = String.fromCharCode(65 + i % 7) + (1 + i % 5);
    const quantity = 11 + i % 16, colour = colours[i % colours.length];
    const timestamp = start - (75 - 2 * i) * 60_000;
    append("user", `演练资料第${i + 1}批。${rack}架上有${quantity}本${colour}色封面的册子，登记编号${batch}。请记一下颜色、位置和数量，后面的复核要用。`, timestamp);
    append("assistant", `已登记编号${batch}，位置${rack}架，数量${quantity}本，封面为${colour}色。整理时按编号归档，这批与其他架分开核对。`, timestamp + 12_000);
  }
  return { rows, append };
}

export async function runCacheProbe(options: {
  provider: any; logger: Logger; signal?: AbortSignal; diagnostics?: Diagnostics;
  waitForCache?: (signal: AbortSignal) => Promise<void>;
}) {
  const { provider } = options;
  const settings = requestSettings(provider);
  const target = { ...provider, parameters: settings.parameters };
  const llm = new LLM(options.logger);
  llm.diagnostics = options.diagnostics;
  const deadline = AbortSignal.timeout(CACHE_TEST_PLAN.timeout_seconds * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const samples: Sample[] = [];
  const report = (verdict: Verdict, message: string) => {
    const formal = samples.filter(s => !s.warmup && s.completed);
    return { verdict, message, requests: samples.length, samples,
      summaries: { standard: summarize(formal.filter(s => s.layout === "standard")),
        stable: summarize(formal.filter(s => s.layout === "stable")) }, total: summarize(samples) };
  };
  if (settings.reason) return report("inconclusive", settings.reason);
  const start = Date.now(), history = syntheticHistory(start), zone = "Asia/Shanghai";
  const persona = { prompt: "你是虚构的档案核对助手。合成测试批次 " + randomBytes(8).toString("hex") };
  const layouts: Layout[] = ["standard", "stable"];
  try {
    for (let round = 1; round <= CACHE_TEST_PLAN.warmup_per_layout + CACHE_TEST_PLAN.measured_per_layout; round++) {
      if (round > 1) {
        signal.throwIfAborted();
        if (options.waitForCache) await options.waitForCache(signal);
        else await delay(8000, undefined, { signal });
      }
      const stamp = start + (round - 1) * 60_000;
      const time = timeContext(zone, new Date(stamp).toISOString(), history.rows, stamp);
      const code = randomBytes(3).toString("hex").toUpperCase();
      const material = { persona, facts: [], zone, origin: { channel: "web" }, engine: true,
        local: "本轮合成回执码为 " + code, snippets: [] };
      const query = `第${round}次演练。请只原样回复本轮合成回执码。`;
      for (const layout of round % 2 ? layouts : [...layouts].reverse()) {
        signal.throwIfAborted();
        const { messages } = contextFrame(material, history.rows, false, time, layout === "stable");
        messages.push({ role: "user", content: query });
        if (Buffer.byteLength(JSON.stringify(messages)) > CACHE_TEST_PLAN.max_message_bytes_per_request ||
            samples.length >= CACHE_TEST_PLAN.max_requests) return report("inconclusive", "测试已达到请求或消息大小上限。");
        const sample: Sample = { round, layout, warmup: round <= CACHE_TEST_PLAN.warmup_per_layout, completed: false,
          input_tokens: null, output_tokens: null, hit_tokens: null, miss_tokens: null, hit_percent: null, cost: null };
        samples.push(sample);
        const run = () => llm.chat({ provider: target, messages, signal });
        const reply = options.diagnostics?.enabled ? await options.diagnostics.run({ purpose: "cache_probe" }, run) : await run();
        const { cache, cost } = modelUsageDetails(reply.usage, target);
        Object.assign(sample, cache, { input_tokens: count(reply.usage?.prompt_tokens), output_tokens: count(reply.usage?.completion_tokens),
          cost: sampleCost(reply.usage, target, cache, cost) });
        signal.throwIfAborted();
        if (reply.finish_reason && reply.finish_reason !== "stop" || reply.text.trim() !== code || reply.toolCalls.length ||
            (sample.output_tokens !== null && sample.output_tokens > settings.maximum))
          return report("inconclusive", `第 ${round} 轮${layout === "stable" ? "稳定前缀" : "常规布局"}未完整返回正确的合成回执，已停止后续请求。`);
        sample.completed = true;
      }
      history.append("user", query, stamp);
      history.append("assistant", code, stamp + 5000);
    }
  } catch (error) {
    if (signal.aborted) return report("inconclusive", options.signal?.aborted ? "测试已取消，已发出的请求可能产生费用。" : "测试达到总时限，已停止后续请求。");
    const status = error instanceof ModelRequestError && error.message.match(/^模型服务返回 HTTP ([1-5]\d{2})(?:：|$)/);
    const last = samples.at(-1);
    const stage = last ? `第 ${last.round} 轮${last.layout === "stable" ? "稳定前缀" : "常规布局"}` : "准备阶段";
    return report("inconclusive", `${stage}请求失败${status ? "（HTTP " + status[1] + "）" : ""}，已停止后续请求。`);
  }
  const formal = samples.filter(s => !s.warmup);
  return report(...evaluate(formal.filter(s => s.layout === "standard"), formal.filter(s => s.layout === "stable")));
}
