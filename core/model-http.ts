/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { ProxyAgent } from "undici";

export interface ModelTransport {
  base_url: string;
  api_key?: string;
  timeout_seconds?: number;
  proxy_url?: string;
}

export class ModelRequestError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "ModelRequestError";
    this.status = status;
  }
}

/** Only emit recognised diagnostic categories, never a provider's arbitrary text/request echo. */
export function modelErrorMessage(status: number | undefined, body: any, secret = "", headerId?: string | null) {
  const error = body?.error, message = typeof error?.message === "string" ? error.message.slice(0, 8192) : "";
  let reason = "";
  if (/reasoning_content/i.test(message) && /thinking|passed back|missing|must|思考|缺少/i.test(message))
    reason = "思考模式要求回传完整 reasoning_content，请检查工具续轮协议";
  else if (/context.{0,30}(length|window)|maximum.{0,30}token|too many tokens/i.test(message)) reason = "请求超出模型上下文限制";
  else if (/invalid.{0,20}(api.?key|authentication)|unauthorized/i.test(message)) reason = "服务拒绝了认证信息";
  else if (/insufficient.{0,20}(quota|balance)|quota.{0,20}exceed/i.test(message)) reason = "服务额度或余额不足";
  else if (/rate.{0,10}limit/i.test(message)) reason = "服务请求频率受限";
  else if (/(tool|function).{0,40}(invalid|schema)|invalid.{0,30}(tool|function)/i.test(message)) reason = "服务拒绝了工具定义或调用格式";
  const known = new Set(["invalid_request_error", "authentication_error", "permission_error", "rate_limit_error", "server_error", "insufficient_quota", "context_length_exceeded", "invalid_api_key"]);
  const type = [error?.type, error?.code].find(x => typeof x === "string" && known.has(x));
  const candidate = headerId ?? body?.request_id ?? error?.request_id ?? message.match(/request_id:\s*([a-f\d-]{36})/i)?.[1];
  const requestId = typeof candidate === "string" && /^(?:[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}|req_[a-z\d]{8,80})$/i.test(candidate) &&
    (!secret || !candidate.includes(secret)) ? candidate : undefined;
  const details = [reason, type, requestId ? "request_id=" + requestId : ""].filter(Boolean).join("；");
  return (status === undefined ? "模型服务返回错误" : `模型服务返回 HTTP ${status}`) + (details ? "：" + details : "");
}

async function boundedErrorBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const limit = 16 * 1024, decoder = new TextDecoder();
  let size = 0, raw = "";
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 1000);
  timer.unref();
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, limit - size);
      size += chunk.length;
      raw += decoder.decode(chunk, { stream: true });
    }
    raw += decoder.decode();
    try { return JSON.parse(raw); } catch { return undefined; }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

export function timeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return 120;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 600
  )
    throw new ModelRequestError("请求超时必须为 1–600 秒的整数", 400);
  return value;
}

export function proxyURL(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string")
    throw new ModelRequestError("代理地址必须是 HTTP 或 HTTPS 地址", 400);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ModelRequestError("代理地址必须是完整的 HTTP 或 HTTPS 地址", 400);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ModelRequestError(
      "代理地址仅支持 HTTP/HTTPS 主机及端口，不可包含凭据、路径或查询参数",
      400,
    );
  return url.origin;
}

/** A request-scoped dispatcher avoids changing networking for unrelated services. */
export async function withModelResponse<T>(
  provider: ModelTransport,
  endpoint: string,
  payload: unknown | undefined,
  consume: (response: Response) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  externalSignal?.throwIfAborted();
  const seconds = timeoutSeconds(provider.timeout_seconds);
  const proxy = proxyURL(provider.proxy_url);
  let url: URL;
  try {
    url = new URL(provider.base_url);
  } catch {
    throw new ModelRequestError("模型 API 地址无效", 400);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ModelRequestError(
      "模型 API 地址不可包含凭据、查询参数或片段",
      400,
    );
  const dispatcher = proxy
    ? new ProxyAgent({ uri: proxy, proxyTunnel: true })
    : undefined;
  const timeout = AbortSignal.timeout(seconds * 1000);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeout])
    : timeout;
  const checkAbort = () => {
    if (!signal.aborted) return;
    if (externalSignal?.aborted && signal.reason === externalSignal.reason)
      throw signal.reason;
    throw new ModelRequestError(
      `模型请求超时（${seconds} 秒），请检查服务或调整超时时间`,
      504,
    );
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;
  try {
    let response: Response;
    try {
      const init: RequestInit & { dispatcher?: ProxyAgent } = {
        method: payload === undefined ? "GET" : "POST",
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        redirect: "error",
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      };
      response = await fetch(
        provider.base_url.replace(/\/+$/, "") + endpoint,
        init,
      );
    } catch {
      checkAbort();
      throw new ModelRequestError(
        "无法连接模型服务，请检查 API 地址、代理和网络",
        502,
      );
    }
    if (!response.ok) {
      let body: unknown;
      try { body = await boundedErrorBody(response); } catch { /* retain the HTTP status on truncated/erroring bodies */ }
      checkAbort();
      throw new ModelRequestError(modelErrorMessage(response.status, body, provider.api_key,
        response.headers.get("x-request-id") ?? response.headers.get("request-id")), 502);
    }
    try {
      return await consume(response);
    } catch (error) {
      checkAbort();
      throw error;
    }
  } finally {
    if (dispatcher) await dispatcher.destroy();
  }
}
