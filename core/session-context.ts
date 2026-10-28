export type ContextPolicy = {
  recent_lines: number;
  budget_tokens: number;
  include_facts: boolean;
  include_summary: boolean;
  history_scope: "persona" | "session";
};
export function contextPolicy(config: any, saved: any = {}): ContextPolicy {
  return {
    recent_lines: saved.recent_lines ?? config.recent_lines ?? 30,
    budget_tokens: saved.budget_tokens ?? config.budget_tokens ?? 6000,
    include_facts: saved.include_facts ?? true,
    include_summary: saved.include_summary ?? true,
    history_scope: saved.history_scope ?? config.history_scope ?? "session",
  };
}
export function validateContext(input: any): ContextPolicy {
  if (
    !input ||
    !Number.isInteger(input.recent_lines) ||
    input.recent_lines < 0 ||
    input.recent_lines > 1000
  )
    throw Error("历史消息条数应为 0–1000 的整数");
  if (
    !Number.isInteger(input.budget_tokens) ||
    input.budget_tokens < 100 ||
    input.budget_tokens > 10000000
  )
    throw Error("历史上下文预算应为 100–10000000 的整数");
  if (
    typeof input.include_facts !== "boolean" ||
    typeof input.include_summary !== "boolean" ||
    !["persona", "session"].includes(input.history_scope)
  )
    throw Error("上下文选项无效");
  return contextPolicy({}, input);
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
  return {
    model_id: provider.model_id || provider.model,
    model: provider.model,
    provider_id: provider.id,
    input_tokens: raw.prompt_tokens,
    output_tokens: raw.completion_tokens,
    used_tokens: used,
    context_window: limit,
    percent: limit ? (used / limit) * 100 : null,
    measured_at: new Date().toISOString(),
  };
}
