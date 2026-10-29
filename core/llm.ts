import type { Logger } from "./logger.ts";
import {
  modelConfigurationError,
  validateModelParameters,
} from "./model-config.ts";
import { withModelResponse } from "./model-http.ts";
export class LLM {
  logger: Logger;
  providers: any[];
  resolver?: (model: string) => any;
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
        },
        async (response) => {
          if (!response.body) throw Error("模型返回空响应");
          let buffer = "",
            text = "",
            usage: any;
          const calls: any[] = [];
          const decoder = new TextDecoder();
          let done = false;
          const consume = (line: string) => {
            if (!line.startsWith("data:")) return;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              done = true;
              return;
            }
            if (!data) return;
            let obj: any;
            try {
              obj = JSON.parse(data);
            } catch {
              throw Error("模型服务返回了无效的流式数据");
            }
            if (obj.error) throw Error("模型服务返回错误");
            usage = obj.usage ?? usage;
            const delta = obj.choices?.[0]?.delta;
            if (delta?.content) {
              text += delta.content;
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
          });
          return { text, toolCalls: calls.filter(Boolean), usage };
        },
        opts.signal,
      );
    } catch (error) {
      this.logger.error("LLM 请求失败", { error, ms: Date.now() - start });
      throw error;
    }
  }
}
