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
      await response.body?.cancel().catch(() => {});
      throw new ModelRequestError(`模型服务返回 HTTP ${response.status}`, 502);
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
