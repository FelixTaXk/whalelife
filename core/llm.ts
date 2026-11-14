/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Logger } from "./logger.ts";
import {
  modelConfigurationError,
  validateModelParameters,
} from "./model-config.ts";
import { withModelResponse, modelErrorMessage } from "./model-http.ts";
import type { Diagnostics } from "./diagnostics.ts";
/** Completed transcript rows have no protocol reasoning. Quote them as history for these APIs. */
export function thinkingToolHistory(provider: any, tools: unknown[]) {
  if (!tools.length || provider.parameters?.thinking?.type === "disabled") return false;
  let host = "";
  try { host = new URL(provider.base_url).hostname.toLowerCase(); } catch { /* validated before transport */ }
  return provider.parameters?.thinking?.type === "enabled" ||
    host === "api.deepseek.com" || /^deepseek[-/]/i.test(provider.model ?? "");
}
export class LLM {
  logger: Logger;
  providers: any[];
  resolver?: (model: string) => any;
  diagnostics?: Diagnostics;
  constructor(
    logger: Logger,
    providers: any[] = [],
    resolver?: (model: string) => any,
  ) {
    this.logger = logger;
    this.providers = providers;
    this.resolver = resolver;
  }
  async chat(opts: any) {
    opts = {
      ...opts,
      provider:
        opts.provider ??
        (opts.model &&
          (this.resolver
            ? this.resolver(opts.model)
            : this.providers.find(
                (p) => p.id === opts.model || p.model === opts.model,
              ))),
    };
    if (
      !opts.provider ||
      !opts.provider.model ||
      opts.provider.enabled === false
    )
      throw Error("请先明确选择可用的对话模型");
    const configurationError = modelConfigurationError(
      { type: "chat" },
      {
        ...opts.provider,
        protocol: opts.provider.protocol ?? "openai-compatible",
      },
    );
    if (configurationError) throw Error(configurationError);
    if ((opts.provider.protocol ?? "openai-compatible") !== "openai-compatible")
      throw Error("此模型协议由插件调用，不能用于主干对话");
    const parameters = validateModelParameters(opts.provider.parameters);
    const start = Date.now();
    this.logger.info("LLM 请求", { model: opts.provider.model });
    try {
      return await withModelResponse(
        opts.provider,
        "/chat/completions",
        {
          ...parameters,
          ...(Number.isSafeInteger(opts.max_tokens) && opts.max_tokens > 0
            ? { max_tokens: opts.max_tokens }
            : {}),
          model: opts.provider.model,
          messages: opts.messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(opts.tools?.length ? { tools: opts.tools } : {}),
          ...(opts.tool_choice === "none" ? { tool_choice: "none" } : {}),
        },
        async (response, trace) => {
          if (!response.body) throw Error("模型返回空响应");
          let buffer = "",
            text = "",
            reasoning: string | undefined,
            finishReason: string | undefined,
            usage: any;
          const calls: any[] = [];
          const decoder = new TextDecoder();
          let done = false;
          const consume = (line: string) => {
            if (!line.startsWith("data:")) return;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              trace?.emit("response.chunk", { phase: "sse", raw: data });
              done = true;
              return;
            }
            if (!data) return;
            let obj: any;
            try {
              obj = JSON.parse(data);
            } catch {
              trace?.emit("response.chunk", { phase: "sse", raw: data, parse_error: true });
              throw Error("模型服务返回了无效的流式数据");
            }
            const observed = obj?.choices?.[0]?.delta;
            trace?.emit("response.chunk", { phase: "sse", raw: obj,
              ...(observed?.content === undefined ? {} : { text: observed.content }),
              ...(observed?.reasoning_content === undefined ? {} : { reasoning: observed.reasoning_content }),
              ...(observed?.tool_calls === undefined ? {} : { tool_calls: observed.tool_calls }) });
            if (obj?.usage !== undefined && obj?.usage !== null)
              trace?.emit("request.usage", { usage: obj.usage, mode: "snapshot", stage: "interim" });
            if (obj.error) throw Error(modelErrorMessage(undefined, obj, opts.provider.api_key));
            usage = obj.usage ?? usage;
            const choice = obj.choices?.[0];
            if (typeof choice?.finish_reason === "string") {
              trace?.finish({ finish_reason: choice.finish_reason });
              // Only log known protocol labels; an arbitrary value may contain private text.
              finishReason = ["stop", "length", "content_filter", "tool_calls", "insufficient_system_resource", "aborted"]
                .includes(choice.finish_reason) ? choice.finish_reason : "unknown";
            }
            const delta = choice?.delta;
            if (typeof delta?.reasoning_content === "string")
              reasoning = (reasoning ?? "") + delta.reasoning_content;
            trace?.finish({ ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) });
            if (delta?.content) {
              text += delta.content;
              trace?.finish({ text });
              opts.onChunk?.(delta.content);
            }
            for (const c of delta?.tool_calls ?? []) {
              const item = (calls[c.index] ??= {
                id: "",
                name: "",
                arguments: "",
              });
              if (c.id) item.id = c.id;
              if (c.function?.name) item.name += c.function.name;
              if (c.function?.arguments) item.arguments += c.function.arguments;
            }
            trace?.finish({ text, tool_calls: calls.filter(Boolean) });
          };
          for await (const bytes of response.body) {
            buffer += decoder.decode(bytes, { stream: true });
            let pos;
            while ((pos = buffer.indexOf("\n")) >= 0) {
              consume(buffer.slice(0, pos).trim());
              buffer = buffer.slice(pos + 1);
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) consume(buffer.trim());
          if (!done) throw Error("模型流意外中断");
          this.logger.info("LLM 完成", {
            model: opts.provider.model,
            ms: Date.now() - start,
            usage,
            ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
          });
          if (usage !== undefined) trace?.emit("request.usage", { usage, mode: "snapshot", stage: "final" });
          trace?.finish({ text, tool_calls: calls.filter(Boolean),
            ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) });
          return { text, toolCalls: calls.filter(Boolean), usage,
            ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
            ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) };
        },
        opts.signal,
        this.diagnostics,
      );
    } catch (error) {
      this.logger.error("LLM 请求失败", { error, ms: Date.now() - start });
      throw error;
    }
  }
}
