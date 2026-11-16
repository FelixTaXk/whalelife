/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
/** Local text-field adaptation. These settings are never model request parameters. */
export interface ReasoningCompatibility {
  response_field?: string;
  request_field?: string;
  fill_missing?: boolean;
}

const reserved = new Set([
  "__proto__", "prototype", "constructor", "role", "content", "tool_calls", "tool_call_id",
  "function_call", "function", "arguments", "name", "id", "index", "usage", "reasoning_tokens",
  "prompt_tokens", "completion_tokens", "total_tokens", "cost", "model", "messages", "tools",
  "tool_choice", "stream", "stream_options", "choices", "delta", "finish_reason", "error",
  "api_key", "authorization", "headers", "password", "secret", "token", "base_url", "url",
  "reasoning_details", "signature", "encrypted_content",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { status: 400 });
};
function field(value: unknown, response: boolean): string {
  if (typeof value !== "string" || !value || value.length > (response ? 160 : 64))
    return invalid("思考字段映射需填写有效字段名");
  const parts = value.split(".");
  if (parts.length > (response ? 4 : 1) || parts.some(part =>
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(part) || reserved.has(part.toLowerCase())))
    return invalid("思考字段映射仅支持安全的文本字段，不能覆盖正文、工具、用量、认证或结构化思考数据");
  return value;
}

/** Normalize absent/disabled settings without adding fields to existing model records. */
export function validateReasoningCompatibility(value: unknown): ReasoningCompatibility | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return invalid("思考兼容设置必须是对象");
  if (Object.keys(value).some(key => !["response_field", "request_field", "fill_missing"].includes(key)))
    return invalid("思考兼容设置包含不支持的选项");
  const result: ReasoningCompatibility = {};
  if (value.response_field !== undefined) result.response_field = field(value.response_field, true);
  if (value.request_field !== undefined) result.request_field = field(value.request_field, false);
  if (value.fill_missing !== undefined && typeof value.fill_missing !== "boolean")
    return invalid("缺失思考字段补空必须是布尔值");
  if (value.fill_missing === true) result.fill_missing = true;
  return Object.keys(result).length ? result : undefined;
}

function ownString(value: unknown, path: string): string | undefined {
  let current = value;
  for (const key of path.split(".")) {
    if (!record(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

/** Used for diagnostics as well as parsing; explicit mappings do not guess a fallback. */
export function readReasoningDelta(delta: unknown, config?: ReasoningCompatibility): string | undefined {
  return config?.response_field ? ownString(delta, config.response_field)
    : ownString(delta, "reasoning_content") ?? ownString(delta, "reasoning");
}

export class ReasoningAccumulator {
  private standard: string | undefined;
  private alias: string | undefined;
  private mapped: string | undefined;
  private config: ReasoningCompatibility | undefined;
  constructor(config?: ReasoningCompatibility) { this.config = validateReasoningCompatibility(config); }
  push(delta: unknown) {
    const standard = ownString(delta, "reasoning_content"), alias = ownString(delta, "reasoning");
    if (standard !== undefined) this.standard = (this.standard ?? "") + standard;
    if (alias !== undefined) this.alias = (this.alias ?? "") + alias;
    if (this.config?.response_field) {
      const mapped = ownString(delta, this.config.response_field);
      if (mapped !== undefined) this.mapped = (this.mapped ?? "") + mapped;
    }
  }
  value(fillForToolResponse = false): string | undefined {
    const selected = this.config?.response_field ? this.mapped : this.standard ?? this.alias;
    if (selected !== undefined) return selected;
    // An experimental fallback must not erase genuine standard/alias text merely
    // because an explicitly configured custom source was absent in this response.
    return fillForToolResponse && this.config?.fill_missing
      ? this.standard ?? this.alias ?? "" : undefined;
  }
}

/** Only assistant protocol fields are copied; caller-owned history is never modified. */
export function encodeReasoningMessages(messages: any, config?: ReasoningCompatibility): any {
  if (!config || !Array.isArray(messages)) return messages;
  const target = config.request_field ?? "reasoning_content";
  return messages.map((message: any) => {
    if (!record(message) || message.role !== "assistant") return message;
    let value = typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;
    const present = Object.hasOwn(message, target);
    if (target !== "reasoning_content" && present) {
      if (typeof message[target] !== "string" || (value !== undefined && message[target] !== value))
        return invalid("回传思考字段与现有消息字段冲突，请检查模型兼容设置");
      // A caller that already supplied the target field keeps its genuine value.
      value ??= message[target] as string;
    }
    // Filling is limited to a newly received tool response in ReasoningAccumulator.
    // Do not manufacture protocol data for caller-supplied historical messages.
    if (value === undefined) return message;
    const result = { ...message, [target]: value };
    if (target !== "reasoning_content") delete result.reasoning_content;
    return result;
  });
}
