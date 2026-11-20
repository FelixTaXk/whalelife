/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export type CacheUsage = {
  hit_tokens: number | null;
  miss_tokens: number | null;
  hit_percent: number | null;
};
export type ReferenceCost = {
  currency: "CNY";
  amount: number | null;
  min: number;
  max: number;
  price_date: "2026-11-09";
  period: "off_peak" | "peak_or_holiday";
  basis: "reference";
};
const tokens = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const unknownCache = (): CacheUsage => ({ hit_tokens: null, miss_tokens: null, hit_percent: null });

type BillingProvider = { base_url?: string; protocol?: string };
export const isMiraRouterEndpoint = (provider?: BillingProvider) =>
  provider?.base_url?.replace(/\/+$/, "") === "https://api.mirarouter.com/v1" &&
  (provider.protocol ?? "openai-compatible") === "openai-compatible";

const supportedCurrencies = new Set<string>(Intl.supportedValuesOf("currency"));
/** Total charge reported by the API. Upstream costs and reference prices have different meanings. */
export function reportedUsageCost(raw: any, provider?: BillingProvider): { amount: number; currency: string } | null {
  if (typeof raw?.cost !== "number" || !Number.isFinite(raw.cost) || raw.cost < 0) return null;
  const currencies = [raw.cost_currency, raw.currency].filter(value => value !== undefined);
  const currency = currencies.length ? currencies[0] : isMiraRouterEndpoint(provider) ? "USD" : null;
  if (!supportedCurrencies.has(currency) || !currencies.every(value => value === currency)) return null;
  return { amount: raw.cost, currency };
}

/** Missing cache details are unknown; an explicit zero remains a measured zero. */
function cacheUsage(raw: any): CacheUsage {
  if (!object(raw) || !tokens(raw.prompt_tokens)) return unknownCache();
  const input = raw.prompt_tokens;
  const hits: unknown[] = [raw.prompt_cache_hit_tokens,
    object(raw.prompt_tokens_details) ? raw.prompt_tokens_details.cached_tokens : undefined]
    .filter(value => value !== undefined);
  const reportedMiss: unknown = raw.prompt_cache_miss_tokens;
  if (hits.some(value => !tokens(value) || value > input) ||
      (reportedMiss !== undefined && (!tokens(reportedMiss) || reportedMiss > input))) return unknownCache();
  if (hits.some(value => value !== hits[0])) return unknownCache();
  let hit = (hits[0] as number | undefined) ?? null;
  let miss = (reportedMiss as number | undefined) ?? null;
  if (hit === null && miss === null) return unknownCache();
  if (hit !== null && miss !== null && hit + miss !== input) return unknownCache();
  // Both formats describe a partition of input tokens; derive only from a valid report.
  if (hit === null) hit = input - miss!;
  if (miss === null) miss = input - hit;
  return { hit_tokens: hit, miss_tokens: miss, hit_percent: input ? hit / input * 100 : null };
}

// CNY per million tokens, verified 2026-11-09. These are reference rates, not a bill.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
const flash = [0.02, 1, 4] as const;
const prices = new Map<string, readonly [number, number, number]>([
  ["deepseek-flash", flash],
  ["deepseek-v4-flash", flash],
  ["deepseek-v4-flash-vision-exp", flash],
  ["deepseek-v4-pro", [0.15, 4.5, 13.5]],
]);
function referenceCost(raw: any, provider: any, cache: CacheUsage, measuredAt: Date): ReferenceCost | null {
  if (!object(raw) || !tokens(raw.prompt_tokens) || !tokens(raw.completion_tokens) ||
      !Number.isFinite(measuredAt.getTime())) return null;
  if ((provider?.protocol ?? "openai-compatible") !== "openai-compatible") return null;
  let endpoint: URL;
  try { endpoint = new URL(provider?.base_url); } catch { return null; }
  if (endpoint.origin !== "https://api.deepseek.com" || endpoint.username || endpoint.password) return null;
  const rates = prices.get(provider?.model);
  if (!rates) return null;
  // Fixed UTC+8 avoids depending on the host timezone. Public holidays need no local database:
  // weekday peak windows retain the complete off-peak/peak range instead of guessing holidays.
  const beijing = new Date(measuredAt.getTime() + 8 * 60 * 60 * 1000);
  const weekday = beijing.getUTCDay(), hour = beijing.getUTCHours();
  const possiblePeak = weekday >= 1 && weekday <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  const period = possiblePeak ? "peak_or_holiday" : "off_peak";
  const knownCache = cache.hit_tokens !== null && cache.miss_tokens !== null;
  const inputMin = knownCache ? cache.hit_tokens! * rates[0] + cache.miss_tokens! * rates[1]
    : raw.prompt_tokens * rates[0];
  const inputMax = knownCache ? inputMin : raw.prompt_tokens * rates[1];
  const output = raw.completion_tokens * rates[2];
  const min = (inputMin + output) / 1000000;
  const max = (inputMax + output) / 1000000 * (possiblePeak ? 2 : 1);
  return { currency: "CNY", amount: knownCache && !possiblePeak ? min : null, min, max,
    price_date: "2026-11-09", period, basis: "reference" };
}

/** Normalize only supported usage fields; do not retain arbitrary provider response metadata. */
export function modelUsageDetails(raw: any, provider: any, measuredAt = new Date()) {
  const cache = cacheUsage(raw);
  const reported = reportedUsageCost(raw, provider);
  return { cache, cost: referenceCost(raw, provider, cache, measuredAt), ...(reported ? { reported_cost: reported } : {}) };
}
