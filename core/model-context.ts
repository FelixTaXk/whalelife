/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";

const MAX_CONTEXT_TOKENS = 10000000;
const MAX_CACHE_ENTRIES = 128;

export function validContextTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value > 0 && value <= MAX_CONTEXT_TOKENS;
}

/** Only explicit whole-context fields qualify; input/output generation limits do not. */
export function modelContextMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const values: number[] = [];
  for (const entry of [record, record.top_provider, record.model_info]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const fields = entry as Record<string, unknown>;
    for (const name of ["context_window", "context_length", "max_context_length", "max_model_len"])
      if (validContextTokens(fields[name])) values.push(fields[name]);
  }
  // A service may report both a catalog ceiling and a smaller serving limit.
  return values.length ? Math.min(...values) : null;
}

export interface ModelContextLimit {
  tokens: number | null;
  source: "configured" | "provider" | "unknown";
}
export type ModelContextCache = Map<string, { value: number | null; until: number }>;
type ContextProvider = {
  id?: string;
  model?: string;
  model_id?: string;
  protocol?: string;
  base_url?: string;
  api_key?: string;
  proxy_url?: string;
  timeout_seconds?: number;
  context_window?: unknown;
  parameters?: Record<string, unknown>;
};
type ModelDiscovery = {
  revision?: string;
  listModels(providerId: string, signal?: AbortSignal): Promise<{
    details?: Array<{ id: string; context_window: number | null }>;
  }>;
};
const caches = new WeakMap<ModelDiscovery, ModelContextCache>();

export async function resolveModelContext(
  options: {
    provider: ContextProvider;
    modelConfig?: ModelDiscovery;
    signal?: AbortSignal;
    refresh?: boolean;
  },
  cache?: ModelContextCache,
): Promise<ModelContextLimit> {
  const { provider, modelConfig, signal, refresh } = options;
  signal?.throwIfAborted();
  if (validContextTokens(provider.context_window))
    return { tokens: provider.context_window, source: "configured" };
  if (!modelConfig || !provider.id || !provider.model)
    return { tokens: null, source: "unknown" };
  if (!cache) {
    cache = caches.get(modelConfig);
    if (!cache) caches.set(modelConfig, cache = new Map());
  }
  // Hash the complete connection identity: credentials must neither leak into cache
  // keys nor allow a response from a previous credential/endpoint to be reused.
  const key = createHash("sha256").update(JSON.stringify([
    provider.id, provider.model_id, provider.model, provider.protocol,
    provider.base_url, provider.api_key, provider.proxy_url,
    provider.timeout_seconds, provider.parameters, provider.context_window,
    modelConfig.revision,
  ])).digest("hex");
  const cached = cache.get(key);
  if (!refresh && cached && cached.until > Date.now())
    return { tokens: cached.value, source: cached.value === null ? "unknown" : "provider" };
  let value: number | null = null;
  try {
    const result = await modelConfig.listModels(provider.id, signal);
    // Aliases and nearby model names can have different capacities.
    const matches = result.details?.filter((model) => model.id === provider.model) ?? [];
    const limits = matches.map((model) => model.context_window).filter(validContextTokens);
    if (limits.length) value = Math.min(...limits);
  } catch {
    // Missing metadata and discovery failures both allow the configured fallback.
  }
  signal?.throwIfAborted();
  const now = Date.now();
  for (const [entry, saved] of cache) if (saved.until <= now) cache.delete(entry);
  cache.delete(key);
  cache.set(key, { value, until: now + (value === null ? 60000 : 3600000) });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return { tokens: value, source: value === null ? "unknown" : "provider" };
}
