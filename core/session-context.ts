/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { modelUsageDetails } from "./model-usage.ts";
export type ContextPolicy = {
  /** Automatic creation only; existing valid diaries remain part of history when disabled. */
  diary_enabled?: boolean;
  /** Omitted by old clients; explicit legacy settings keep their historical semantics. */
  memory_mode?: "full" | "diary" | "legacy";
  compression_trigger_percent?: number;
  compression_target_percent?: number;
  history_enabled: boolean;
  short_term_days: number;
  short_term_min_messages: number;
  long_term_enabled: boolean;
  budget_tokens: number;
  include_facts: boolean;
  include_summary: boolean;
  history_scope: "persona" | "session";
};
export function contextPolicy(config: any, saved: any = {}): ContextPolicy {
  const legacy = (value: any) => ["recent_lines", "budget_tokens", "include_summary", "long_term_enabled",
    "short_term_days", "short_term_min_messages"].some(key => value[key] !== undefined);
  const selected = (value: any) => value.diary_enabled !== undefined
    ? (value.diary_enabled ? "diary" : "full")
    : value.memory_mode ?? (legacy(value) ? "legacy" : undefined);
  const mode = selected(saved) ?? selected(config) ?? "full";
  return {
    memory_mode: mode,
    // Omit the new switch for legacy round trips so old clients preserve their explicit contract.
    ...(mode === "legacy" ? {} : { diary_enabled: mode === "diary" }),
    compression_trigger_percent: saved.compression_trigger_percent ?? config.compression_trigger_percent ?? 80,
    compression_target_percent: saved.compression_target_percent ?? config.compression_target_percent ?? 50,
    history_enabled: saved.history_enabled ?? config.history_enabled ??
      (saved.recent_lines ?? config.recent_lines) !== 0,
    short_term_days: saved.short_term_days ?? config.short_term_days ?? 7,
    short_term_min_messages: saved.short_term_min_messages ?? config.short_term_min_messages ?? 100,
    long_term_enabled: saved.long_term_enabled ?? config.long_term_enabled ?? saved.include_summary ?? true,
    budget_tokens: saved.budget_tokens ?? config.budget_tokens ?? 6000,
    include_facts: saved.include_facts ?? true,
    include_summary: saved.include_summary ?? config.include_summary ?? true,
    history_scope: saved.history_scope ?? config.history_scope ?? "session",
  };
}
export function validateContext(input: any): ContextPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("上下文选项无效");
  if (input.diary_enabled !== undefined && typeof input.diary_enabled !== "boolean")
    throw Error("自动日记开关必须为布尔值");
  if (input.recent_lines !== undefined && (!Number.isInteger(input.recent_lines) ||
      input.recent_lines < 0 || input.recent_lines > 1000)) throw Error("旧历史条数无效");
  const policy = contextPolicy({}, input);
  if (!["full", "diary", "legacy"].includes(policy.memory_mode!)) throw Error("记忆模式无效");
  const trigger = policy.compression_trigger_percent!, target = policy.compression_target_percent!;
  if (!Number.isFinite(trigger) || trigger < 10 || trigger > 95 ||
      !Number.isFinite(target) || target < 5 || target >= trigger)
    throw Error("日记触发比例应为10–95%，压后目标应为5%以上且低于触发比例");
  if (!Number.isInteger(policy.short_term_days) || policy.short_term_days < 1 || policy.short_term_days > 3650)
    throw Error("短期时间窗口应为1–3650天");
  if (!Number.isInteger(policy.short_term_min_messages) || policy.short_term_min_messages < 1 || policy.short_term_min_messages > 10000)
    throw Error("短期保底消息数应为1–10000条");
  if (
    !Number.isInteger(policy.budget_tokens) ||
    policy.budget_tokens < 100 ||
    policy.budget_tokens > 10000000
  )
    throw Error("历史上下文预算应为 100–10000000 的整数");
  if (
    typeof input.include_facts !== "boolean" ||
    (policy.memory_mode === "legacy" && typeof input.include_summary !== "boolean") ||
    typeof policy.history_enabled !== "boolean" ||
    typeof policy.long_term_enabled !== "boolean" ||
    !["persona", "session"].includes(input.history_scope)
  )
    throw Error("上下文选项无效");
  return policy;
}
/** Keep a chronological prefix cursor safe: undated/out-of-order recent rows form a barrier. */
export function memoryWindow(rows: any[], policy: ContextPolicy, now = Date.now()) {
  const messages = rows.filter((row) => row.type === "message");
  const limit = Math.max(0, messages.length - policy.short_term_min_messages);
  const cutoff = now - policy.short_term_days * 86400000;
  let boundary = 0;
  while (boundary < limit) {
    const time = Date.parse(messages[boundary].ts);
    if (!Number.isFinite(time) || time >= cutoff) break;
    boundary++;
  }
  return { long: messages.slice(0, boundary), short: messages.slice(boundary) };
}
export function matchingHistory(rows: any[], revision: string, scope: string) {
  if (scope === "session") return rows;
  let boundary = rows.length - 1;
  while (boundary >= 0 && rows[boundary].persona_revision === revision)
    boundary--;
  return rows.slice(boundary + 1);
}
export function requestUsage(raw: any, provider: any, limit: number | null) {
  const valid = (n: any) => Number.isSafeInteger(n) && n >= 0;
  if (!valid(raw?.prompt_tokens) || !valid(raw?.completion_tokens)) return null;
  const used = raw.prompt_tokens + raw.completion_tokens;
  const measuredAt = new Date();
  return {
    model_id: provider.model_id || provider.model,
    model: provider.model,
    provider_id: provider.id,
    input_tokens: raw.prompt_tokens,
    output_tokens: raw.completion_tokens,
    used_tokens: used,
    context_window: limit,
    percent: limit ? (used / limit) * 100 : null,
    measured_at: measuredAt.toISOString(),
    ...modelUsageDetails(raw, provider, measuredAt),
  };
}
