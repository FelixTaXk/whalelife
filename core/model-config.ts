import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.ts";

export const MODEL_TYPES = [
  "chat",
  "embedding",
  "rerank",
  "image",
  "stt",
  "tts",
  "custom",
] as const;
export type ModelType = (typeof MODEL_TYPES)[number];
export const MODEL_ROLES = [
  "chat",
  "embedding",
  "rerank",
  "image",
  "stt",
  "tts",
] as const;
type ModelRole = (typeof MODEL_ROLES)[number];
export interface ProviderConfig {
  id: string;
  name: string;
  protocol: "openai-compatible";
  base_url: string;
  api_key: string;
  enabled: boolean;
}
export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  model: string;
  type: ModelType;
  enabled: boolean;
  parameters: Record<string, unknown>;
}
export class ModelConfigError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ModelConfigError";
    this.status = status;
  }
}
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const parseConfig = (raw: string) => {
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new ModelConfigError("配置文件不是有效的 JSON，请修复后重试");
  }
};
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value);
function text(value: unknown, field: string, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new ModelConfigError(
      `${field}不能为空、包含控制字符或超过 ${max} 字符`,
    );
  return value.trim();
}
function id(value: unknown, field: string): string {
  if (!validId(value))
    throw new ModelConfigError(
      `${field}需为 1–80 个字母、数字、点、短横线或下划线，且以字母或数字开头`,
    );
  return value as string;
}
function baseURL(value: unknown): string {
  let url: URL;
  try {
    url = new URL(text(value, "API 地址", 2048));
  } catch {
    throw new ModelConfigError("API 地址必须是完整的 HTTP 或 HTTPS 地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ModelConfigError(
      "API 地址仅支持 HTTP/HTTPS，不可包含用户名、密码、查询参数或片段",
    );
  return url.href.replace(/\/+$/, "");
}
const RESERVED = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
  "input",
  "api_key",
  "api-key",
  "authorization",
  "headers",
  "base_url",
  "url",
  "__proto__",
  "prototype",
  "constructor",
  "password",
  "secret",
  "token",
]);
export function validateModelParameters(
  value: unknown,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!object(value)) throw new ModelConfigError("模型参数必须是 JSON 对象");
  const raw = JSON.stringify(value);
  if (raw.length > 16384) throw new ModelConfigError("模型参数不能超过 16 KiB");
  const visit = (entry: unknown, depth: number) => {
    if (depth > 12) throw new ModelConfigError("模型参数嵌套过深");
    if (typeof entry === "number" && !Number.isFinite(entry))
      throw new ModelConfigError("模型参数包含无效数字");
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child, depth + 1);
    } else if (object(entry))
      for (const [key, child] of Object.entries(entry)) {
        if (RESERVED.has(key.toLowerCase()))
          throw new ModelConfigError(
            "模型参数不能覆盖模型、消息、工具、请求地址或认证字段",
          );
        visit(child, depth + 1);
      }
    else if (
      !["string", "number", "boolean"].includes(typeof entry) &&
      entry !== null
    )
      throw new ModelConfigError("模型参数只支持 JSON 值");
  };
  visit(value, 0);
  return JSON.parse(raw);
}

// The selected legacy provider is migrated explicitly; array order never selects a model.
function normalize(config: any) {
  const legacy = Array.isArray(config.providers) ? config.providers : [];
  const migrating = !Array.isArray(config.models);
  const models: ModelDefinition[] = migrating
    ? []
    : structuredClone(config.models);
  const legacyModel = new Map<string, string>();
  for (const provider of legacy) {
    if (
      migrating &&
      typeof provider.model === "string" &&
      provider.model.trim()
    ) {
      const modelId = `${provider.id}-chat`;
      models.push({
        id: modelId,
        name: provider.model,
        provider: provider.id,
        model: provider.model,
        type: "chat",
        enabled: provider.enabled !== false,
        parameters: {},
      });
      legacyModel.set(provider.id, modelId);
    }
  }
  const providers: ProviderConfig[] = legacy.map((p: any) => ({
    id: p.id,
    name: p.name || p.id,
    protocol: p.protocol ?? "openai-compatible",
    base_url:
      typeof p.base_url === "string" ? p.base_url.replace(/\/+$/, "") : "",
    api_key: typeof p.api_key === "string" ? p.api_key : "",
    enabled: p.enabled !== false,
  }));
  const bindings: Record<ModelRole, string | null> = Object.fromEntries(
    MODEL_ROLES.map((role) => [role, config.model_bindings?.[role] ?? null]),
  ) as any;
  const personas = structuredClone(config.personas ?? {});
  if (migrating) {
    const selected = config.channels?.web?.persona;
    const chosen = legacyModel.get(personas[selected]?.provider) ?? null;
    bindings.chat = config.model_bindings?.chat ?? chosen;
    for (const [personaId, persona] of Object.entries<any>(personas)) {
      if (persona.model === undefined) {
        const previous = legacyModel.get(persona.provider) ?? null;
        persona.model =
          personaId === selected || previous === bindings.chat
            ? null
            : previous;
      }
    }
  }
  return { providers, models, bindings, personas };
}

export function resolveChatModel(
  config: any,
  personaId?: string,
): ProviderConfig & {
  model: string;
  parameters: Record<string, unknown>;
  model_id?: string;
} {
  if (!Array.isArray(config.models)) {
    const item = personaId ? config.personas?.[personaId] : undefined;
    const provider = config.providers?.find(
      (p: any) => p.id === item?.provider,
    );
    if (!provider || !provider.model || provider.enabled === false)
      throw new ModelConfigError("请先在模型配置中为人格选择可用的对话模型");
    return {
      ...provider,
      parameters: validateModelParameters(provider.parameters),
    };
  }
  const selected =
    (personaId ? config.personas?.[personaId]?.model : null) ??
    config.model_bindings?.chat;
  return resolveModel(config, selected);
}

export function resolveModel(config: any, selected: string) {
  const model = config.models.find((m: any) => m.id === selected);
  if (!model || model.enabled === false || model.type !== "chat")
    throw new ModelConfigError("请先在模型配置中选择已启用的对话模型");
  const provider = config.providers.find((p: any) => p.id === model.provider);
  if (!provider || provider.enabled === false)
    throw new ModelConfigError("对话模型的提供商不存在或已停用");
  return {
    ...provider,
    model: model.model,
    model_id: model.id,
    parameters: validateModelParameters(model.parameters),
  };
}

export class ModelConfig {
  file: string;
  config: any;
  logger: Logger;
  revision: string;
  source: any;
  queue: Promise<unknown> = Promise.resolve();
  constructor(root: string, config: any, logger: Logger) {
    this.file = join(root, "config", "config.json");
    this.config = config;
    this.logger = logger;
    const raw = readFileSync(this.file, "utf8");
    this.revision = hash(raw);
    this.source = normalize(parseConfig(raw));
    this.apply();
  }
  private protectKeys(providers: Array<{ api_key?: unknown }>) {
    for (const provider of providers)
      if (
        typeof provider.api_key === "string" &&
        provider.api_key &&
        !this.logger.secrets.includes(provider.api_key)
      )
        this.logger.secrets.push(provider.api_key);
  }
  private apply() {
    this.protectKeys(this.source.providers);
    this.config.providers = this.source.providers;
    this.config.models = this.source.models;
    this.config.model_bindings = this.source.bindings;
    for (const [name, persona] of Object.entries<any>(this.source.personas))
      if (this.config.personas?.[name])
        this.config.personas[name].model = persona.model ?? null;
  }
  snapshot() {
    const raw = readFileSync(this.file, "utf8");
    if (hash(raw) !== this.revision) {
      this.source = normalize(parseConfig(raw));
      this.revision = hash(raw);
      this.apply();
      this.logger.info("模型配置已从磁盘刷新");
    }
    return {
      revision: this.revision,
      providers: this.source.providers.map(
        ({ api_key, ...p }: ProviderConfig) => ({
          ...p,
          has_key: Boolean(api_key),
        }),
      ),
      models: this.source.models.map((m: ModelDefinition) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        model: m.model,
        type: m.type,
        enabled: m.enabled !== false,
        parameters: validateModelParameters(m.parameters),
      })),
      bindings: { ...this.source.bindings },
      personas: Object.entries<any>(this.source.personas).map(([id, p]) => ({
        id,
        name: p.name || id,
        model: p.model ?? null,
      })),
    };
  }
  save(input: any) {
    if (Array.isArray(input?.providers)) this.protectKeys(input.providers);
    const task = this.queue.then(() => this.write(input));
    this.queue = task.catch(() => {});
    return task;
  }
  private async write(input: any) {
    const expectedRevision = input?.revision;
    const raw = await readFile(this.file, "utf8");
    if (
      !input ||
      expectedRevision !== this.revision ||
      hash(raw) !== expectedRevision
    )
      throw new ModelConfigError(
        "配置已被其他窗口或外部编辑修改，请刷新后重新编辑",
        409,
      );
    if (
      !Array.isArray(input.providers) ||
      !Array.isArray(input.models) ||
      !object(input.bindings) ||
      !object(input.personaModels)
    )
      throw new ModelConfigError("缺少提供商、模型、用途绑定或人格绑定配置");
    if (input.providers.length > 100 || input.models.length > 500)
      throw new ModelConfigError("提供商或模型数量过多");
    const disk = parseConfig(raw);
    const previous = normalize(disk);
    const providerIds = new Set<string>();
    const providers: ProviderConfig[] = input.providers.map((p: any) => {
      if (!object(p)) throw new ModelConfigError("提供商配置格式无效");
      const providerId = id(p.id, "提供商 ID");
      if (providerIds.has(providerId))
        throw new ModelConfigError("提供商 ID 不能重复");
      providerIds.add(providerId);
      if (p.protocol !== "openai-compatible")
        throw new ModelConfigError("当前支持 OpenAI 兼容协议");
      if (typeof p.enabled !== "boolean")
        throw new ModelConfigError("提供商 enabled 必须是布尔值");
      const url = baseURL(p.base_url);
      const old = previous.providers.find((o) => o.id === providerId);
      if (p.api_key !== undefined && typeof p.api_key !== "string")
        throw new ModelConfigError("API Key 必须是字符串");
      if (p.clear_key !== undefined && typeof p.clear_key !== "boolean")
        throw new ModelConfigError("clear_key 必须是布尔值");
      const supplied = typeof p.api_key === "string" ? p.api_key.trim() : "";
      if (supplied.length > 4096 || /[\r\n]/.test(supplied))
        throw new ModelConfigError("API Key 格式无效");
      if (
        old?.api_key &&
        !supplied &&
        p.clear_key !== true &&
        baseURL(old.base_url) !== url
      )
        throw new ModelConfigError(
          "修改 API 地址后请重新输入密钥，或明确清除旧密钥",
        );
      if (supplied && p.clear_key === true)
        throw new ModelConfigError("不能同时输入新密钥并清除密钥");
      return {
        id: providerId,
        name: text(p.name, "提供商名称"),
        protocol: "openai-compatible",
        base_url: url,
        enabled: p.enabled,
        api_key: p.clear_key === true ? "" : supplied || old?.api_key || "",
      };
    });
    const modelIds = new Set<string>();
    const models: ModelDefinition[] = input.models.map((m: any) => {
      if (!object(m)) throw new ModelConfigError("模型配置格式无效");
      const modelId = id(m.id, "模型 ID");
      if (modelIds.has(modelId)) throw new ModelConfigError("模型 ID 不能重复");
      modelIds.add(modelId);
      if (!MODEL_TYPES.includes(m.type))
        throw new ModelConfigError("模型用途无效");
      if (typeof m.enabled !== "boolean")
        throw new ModelConfigError("模型 enabled 必须是布尔值");
      if (!providerIds.has(m.provider))
        throw new ModelConfigError(
          "模型引用的提供商不存在；请先移除其模型再删除提供商",
        );
      return {
        id: modelId,
        name: text(m.name, "模型显示名称"),
        provider: m.provider,
        model: text(m.model, "模型标识", 300),
        type: m.type,
        enabled: m.enabled,
        parameters: validateModelParameters(m.parameters),
      };
    });
    const validateBinding = (
      selected: unknown,
      type: ModelType,
    ): string | null => {
      if (selected === null) return null;
      if (typeof selected !== "string")
        throw new ModelConfigError("每项模型用途需明确选择模型或留空");
      const model = models.find((m) => m.id === selected);
      if (
        !model ||
        model.type !== type ||
        !model.enabled ||
        !providers.find((p) => p.id === model.provider)?.enabled
      )
        throw new ModelConfigError(
          "绑定的模型必须存在、用途匹配，且模型和提供商均已启用；请先调整用途或人格绑定",
        );
      return selected;
    };
    const bindings = Object.fromEntries(
      MODEL_ROLES.map((role) => [
        role,
        validateBinding(input.bindings[role], role),
      ]),
    );
    const personas = disk.personas ?? {};
    for (const name of Object.keys(input.personaModels))
      if (!Object.hasOwn(personas, name))
        throw new ModelConfigError("人格绑定引用了不存在的人格");
    for (const [name, p] of Object.entries<any>(personas)) {
      if (!Object.hasOwn(input.personaModels, name))
        throw new ModelConfigError("缺少人格模型绑定");
      p.model = validateBinding(input.personaModels[name], "chat");
    }
    this.protectKeys(providers);
    const next = {
      ...disk,
      providers,
      models,
      model_bindings: bindings,
      personas,
    };
    const content = JSON.stringify(next, null, 2) + "\n";
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (hash(await readFile(this.file, "utf8")) !== expectedRevision)
        throw new ModelConfigError(
          "保存期间配置已被外部修改，请刷新后重试",
          409,
        );
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT")
          this.logger.warn("模型配置临时文件清理失败", { code: e.code });
      });
    }
    this.revision = hash(content);
    this.source = normalize(next);
    this.apply();
    this.logger.info("模型配置已保存", {
      providers: providers.length,
      models: models.length,
    });
    return this.snapshot();
  }
  private provider(providerId: string): ProviderConfig {
    const provider = this.config.providers.find(
      (p: ProviderConfig) => p.id === providerId,
    );
    if (!provider || !provider.enabled)
      throw new ModelConfigError("提供商不存在或已停用");
    if (provider.protocol !== "openai-compatible")
      throw new ModelConfigError("当前只支持 OpenAI 兼容的模型服务");
    return provider;
  }
  private async request(
    provider: ProviderConfig,
    endpoint: string,
    payload?: unknown,
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;
    let response: Response;
    try {
      response = await fetch(baseURL(provider.base_url) + endpoint, {
        method: payload === undefined ? "GET" : "POST",
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new ModelConfigError(
        "无法连接模型服务，请检查地址、网络和超时设置",
        502,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ModelConfigError(`模型服务返回 HTTP ${response.status}`, 502);
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw Error();
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ModelConfigError("模型服务返回了无效或过大的 JSON 响应", 502);
    }
  }
  async listModels(providerId: string) {
    const provider = this.provider(providerId);
    const data = await this.request(provider, "/models");
    if (!Array.isArray(data.data))
      throw new ModelConfigError("模型服务未返回兼容的模型列表", 502);
    return {
      models: [
        ...new Set<string>(
          data.data
            .filter((m: any) => typeof m?.id === "string" && m.id.length <= 300)
            .map((m: any) => m.id),
        ),
      ].sort(),
    };
  }
  async testModel(modelId: string) {
    const model: ModelDefinition | undefined = this.config.models.find(
      (m: ModelDefinition) => m.id === modelId,
    );
    if (!model || !model.enabled)
      throw new ModelConfigError("模型不存在或已停用");
    const provider = this.provider(model.provider);
    const start = Date.now();
    const parameters = validateModelParameters(model.parameters);
    if (model.type === "chat") {
      const data = await this.request(provider, "/chat/completions", {
        ...parameters,
        model: model.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        stream: false,
      });
      if (!Array.isArray(data.choices) || !data.choices[0]?.message)
        throw new ModelConfigError("服务未返回兼容的对话结果", 502);
      this.logger.info("对话模型测试通过", { model: model.id });
      return {
        ok: true,
        message: "对话模型连接成功",
        latency_ms: Date.now() - start,
      };
    }
    if (model.type === "embedding") {
      const data = await this.request(provider, "/embeddings", {
        ...parameters,
        encoding_format: "float",
        model: model.model,
        input: "WhaleLife connection test",
      });
      const vector = data.data?.[0]?.embedding;
      if (
        !Array.isArray(vector) ||
        !vector.length ||
        !vector.every((v: any) => typeof v === "number" && Number.isFinite(v))
      )
        throw new ModelConfigError("服务未返回有效的向量结果", 502);
      this.logger.info("向量模型测试通过", {
        model: model.id,
        dimensions: vector.length,
      });
      return {
        ok: true,
        message: "向量模型连接成功",
        latency_ms: Date.now() - start,
        dimensions: vector.length,
      };
    }
    throw new ModelConfigError(
      "该用途配置已支持保存；当前连通测试支持对话和向量模型",
    );
  }
}
