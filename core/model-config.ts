import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "./logger.ts";
import { proxyURL, timeoutSeconds, withModelResponse } from "./model-http.ts";

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
  protocol: "openai-compatible" | "dashscope";
  base_url: string;
  api_key: string;
  enabled: boolean;
  timeout_seconds: number;
  proxy_url: string;
}
export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  model: string;
  type: ModelType;
  enabled: boolean;
  parameters: Record<string, unknown>;
  dimensions: number | null;
  context_window?: number | null;
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
  "context_window",
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
            "模型参数不能覆盖模型、消息、工具、请求地址、认证字段或上下文窗口",
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

function expectedDimensions(value: unknown, type: ModelType): number | null {
  if (value === undefined || value === null) return null;
  if (type !== "embedding")
    throw new ModelConfigError("预期向量维度仅适用于 Embedding 模型");
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 65536
  )
    throw new ModelConfigError("预期向量维度必须为空或 1–65536 的整数");
  return value;
}

function contextWindow(value: unknown, type: ModelType): number | null {
  if (value === undefined || value === null) return null;
  if (type !== "chat") throw new ModelConfigError("上下文窗口仅适用于对话模型");
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 10000000
  )
    throw new ModelConfigError(
      "上下文窗口必须为空或 1–10000000 的整数（token）",
    );
  return value;
}

function readProvider(
  p: any,
  old?: ProviderConfig,
  draft = false,
): ProviderConfig {
  if (!object(p)) throw new ModelConfigError("提供商配置格式无效");
  const providerId = draft && !p.id ? "draft-provider" : id(p.id, "提供商 ID");
  if (!["openai-compatible", "dashscope"].includes(p.protocol))
    throw new ModelConfigError("请选择 OpenAI 兼容或 DashScope 原生协议");
  if (typeof p.enabled !== "boolean")
    throw new ModelConfigError("提供商 enabled 必须是布尔值");
  const url = baseURL(p.base_url);
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
    (baseURL(old.base_url) !== url || old.protocol !== p.protocol)
  )
    throw new ModelConfigError(
      "修改 API 地址或协议后请重新输入密钥，或明确清除旧密钥",
    );
  if (supplied && p.clear_key === true)
    throw new ModelConfigError("不能同时输入新密钥并清除密钥");
  return {
    id: providerId,
    name: text(
      p.name ?? (draft ? (old?.name ?? "草稿提供商") : undefined),
      "提供商名称",
    ),
    protocol: p.protocol,
    base_url: url,
    enabled: p.enabled,
    api_key: p.clear_key === true ? "" : supplied || old?.api_key || "",
    timeout_seconds: timeoutSeconds(p.timeout_seconds),
    proxy_url: proxyURL(p.proxy_url),
  };
}

function readModel(
  m: any,
  draft = false,
  detectDimensions = false,
): ModelDefinition {
  if (!object(m)) throw new ModelConfigError("模型配置格式无效");
  if (!MODEL_TYPES.includes(m.type)) throw new ModelConfigError("模型用途无效");
  if (typeof m.enabled !== "boolean")
    throw new ModelConfigError("模型 enabled 必须是布尔值");
  return {
    id: draft && !m.id ? "draft-model" : id(m.id, "模型 ID"),
    name: text(m.name ?? (draft ? m.model : undefined), "模型显示名称"),
    provider: m.provider,
    model: text(m.model, "模型标识", 300),
    type: m.type,
    enabled: m.enabled,
    parameters: validateModelParameters(m.parameters),
    dimensions: detectDimensions
      ? null
      : expectedDimensions(m.dimensions, m.type),
    context_window: contextWindow(m.context_window, m.type),
  };
}

/** Validation is descriptive: old invalid records remain visible, never silently moved. */
export function modelConfigurationError(
  model: Pick<ModelDefinition, "type">,
  provider?: Pick<ProviderConfig, "protocol" | "base_url">,
): string | null {
  if (!provider) return "模型引用的提供商不存在";
  if (!["openai-compatible", "dashscope"].includes(provider.protocol))
    return "提供商协议不受支持";
  let host: string;
  try {
    host = new URL(provider.base_url).hostname.toLowerCase();
  } catch {
    return "提供商 API 地址无效";
  }
  if (
    (host === "deepseek.com" || host.endsWith(".deepseek.com")) &&
    model.type !== "chat"
  )
    return "DeepSeek 官方接口仅支持对话模型，不能作为 Embedding 等模型的服务；请选择对应的提供商";
  if (provider.protocol === "dashscope" && model.type !== "embedding")
    return "DashScope 原生协议当前仅支持 Embedding；对话模型请使用 OpenAI 兼容协议";
  return null;
}

function modelRecord(model: ModelDefinition) {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    model: model.model,
    type: model.type,
    enabled: model.enabled !== false,
    parameters: model.parameters ?? {},
    dimensions: model.dimensions ?? null,
    context_window: model.context_window ?? null,
  };
}

// The selected legacy provider is migrated explicitly; array order never selects a model.
function normalize(config: any) {
  const legacy = Array.isArray(config.providers) ? config.providers : [];
  const migrating = !Array.isArray(config.models);
  const models: ModelDefinition[] = migrating
    ? []
    : structuredClone(config.models).map((m: ModelDefinition) => ({
        ...m,
        dimensions: m.dimensions ?? null,
        context_window: m.context_window ?? null,
      }));
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
        dimensions: null,
        context_window: null,
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
    timeout_seconds: p.timeout_seconds ?? 120,
    proxy_url: p.proxy_url ?? "",
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
  return {
    providers,
    models,
    bindings,
    personas,
    activePersona: config.channels?.web?.persona,
  };
}

export function resolveChatModel(
  config: any,
  personaId?: string,
): ProviderConfig & {
  model: string;
  parameters: Record<string, unknown>;
  model_id?: string;
  context_window: number | null;
} {
  if (!Array.isArray(config.models)) {
    const item = personaId ? config.personas?.[personaId] : undefined;
    const provider = config.providers?.find(
      (p: any) => p.id === item?.provider,
    );
    if (!provider || !provider.model || provider.enabled === false)
      throw new ModelConfigError("请先在模型配置中为人格选择可用的对话模型");
    const error = modelConfigurationError(
      { type: "chat" },
      { ...provider, protocol: provider.protocol ?? "openai-compatible" },
    );
    if (error) throw new ModelConfigError(error);
    return {
      ...provider,
      parameters: validateModelParameters(provider.parameters),
      context_window: null,
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
  const error = modelConfigurationError(model, provider);
  if (error) throw new ModelConfigError(error);
  return {
    ...provider,
    model: model.model,
    model_id: model.id,
    parameters: validateModelParameters(model.parameters),
    context_window: contextWindow(model.context_window, model.type),
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
    this.config.personas = structuredClone(this.source.personas);
    if (this.config.channels?.web)
      this.config.channels.web.persona = this.source.activePersona;
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
        dimensions: m.dimensions ?? null,
        context_window: m.context_window ?? null,
        configuration_error: modelConfigurationError(
          m,
          this.source.providers.find(
            (p: ProviderConfig) => p.id === m.provider,
          ),
        ),
      })),
      bindings: { ...this.source.bindings },
      activePersona: this.source.activePersona,
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
  savePersona(input: any) {
    const task = this.queue.then(async () => {
      this.snapshot();
      const raw = await readFile(this.file, "utf8");
      const expected = input?.configRevision;
      const conflict = () =>
        new ModelConfigError(
          "配置或人格已在其他窗口修改，请重新读取后编辑",
          409,
        );
      if (expected !== this.revision || hash(raw) !== expected)
        throw conflict();
      if (
        typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        Buffer.byteLength(input.prompt) > 32768
      )
        throw new ModelConfigError("人格内容不能为空，且不能超过 32 KiB");
      if (input.activate !== undefined && typeof input.activate !== "boolean")
        throw new ModelConfigError("启用选项必须为布尔值");
      const disk = parseConfig(raw);
      disk.providers = structuredClone(this.source.providers);
      disk.models = structuredClone(this.source.models);
      disk.model_bindings = { ...this.source.bindings };
      disk.personas = structuredClone(this.source.personas);
      const creating = input.id === undefined;
      const personaId = creating
        ? `persona_${randomUUID().replaceAll("-", "")}`
        : id(input.id, "人格 ID");
      if (!creating && !Object.hasOwn(disk.personas ?? {}, personaId))
        throw new ModelConfigError("人格不存在");
      const name = text(input.name, "人格名称", 100);
      const selected = input.model ?? null;
      if (selected !== null) resolveModel(this.config, selected);
      if (input.activate)
        resolveModel(this.config, selected ?? this.source.bindings.chat);
      const previous = disk.personas?.[personaId];
      const file = creating
        ? resolve(
            dirname(this.file),
            "..",
            disk.memory?.root ?? "memory",
            "personas",
            personaId + ".md",
          )
        : resolve(dirname(this.file), "..", previous.file);
      const original = creating ? null : await readFile(file, "utf8");
      if (!creating && hash(original!) !== input.revision) throw conflict();
      disk.personas ??= {};
      disk.personas[personaId] = {
        ...(previous ?? { file, permission: "ask" }),
        name,
        model: selected,
      };
      if (input.activate) disk.channels.web.persona = personaId;
      const content = JSON.stringify(disk, null, 2) + "\n";
      const temp = file + "." + randomUUID() + ".tmp";
      const configTemp = this.file + "." + randomUUID() + ".tmp";
      let promptWritten = false;
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temp, input.prompt, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await writeFile(configTemp, content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        if (hash(await readFile(this.file, "utf8")) !== expected)
          throw conflict();
        if (!creating && hash(await readFile(file, "utf8")) !== input.revision)
          throw conflict();
        await rename(temp, file);
        promptWritten = true;
        if (hash(await readFile(this.file, "utf8")) !== expected)
          throw conflict();
        await rename(configTemp, this.file);
      } catch (error) {
        // Roll back only our own prompt write if publishing configuration failed.
        if (
          promptWritten &&
          hash(await readFile(file, "utf8")) === hash(input.prompt)
        ) {
          if (creating) await unlink(file);
          else {
            await writeFile(temp, original!, "utf8");
            await rename(temp, file);
          }
        }
        throw error;
      } finally {
        await unlink(temp).catch(() => {});
        await unlink(configTemp).catch(() => {});
      }
      this.revision = hash(content);
      this.source = normalize(disk);
      this.apply();
      this.logger.info(creating ? "人格已创建" : "人格已保存", {
        persona: personaId,
        active: this.config.channels.web.persona === personaId,
      });
      return {
        config: this.snapshot(),
        persona: {
          id: personaId,
          name,
          model: selected,
          prompt: input.prompt,
          revision: hash(input.prompt),
        },
      };
    });
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
      const old = previous.providers.find((o) => o.id === p?.id);
      const provider = readProvider(p, old);
      if (providerIds.has(provider.id))
        throw new ModelConfigError("提供商 ID 不能重复");
      providerIds.add(provider.id);
      return provider;
    });
    const modelIds = new Set<string>();
    const models: ModelDefinition[] = input.models.map((m: any) => {
      const model = readModel(m);
      if (modelIds.has(model.id))
        throw new ModelConfigError("模型 ID 不能重复");
      modelIds.add(model.id);
      if (!providerIds.has(model.provider))
        throw new ModelConfigError(
          "模型引用的提供商不存在；请先移除其模型再删除提供商",
        );
      const provider = providers.find((p) => p.id === model.provider)!;
      const error = modelConfigurationError(model, provider);
      if (error) {
        const old = previous.models.find((m) => m.id === model.id);
        const oldProvider = previous.providers.find(
          (p) => p.id === old?.provider,
        );
        const unchanged =
          old &&
          oldProvider &&
          modelConfigurationError(old, oldProvider) &&
          isDeepStrictEqual(modelRecord(old), modelRecord(model)) &&
          oldProvider.protocol === provider.protocol &&
          baseURL(oldProvider.base_url) === provider.base_url;
        if (!unchanged) throw new ModelConfigError(error);
      }
      return model;
    });
    const validateBinding = (
      selected: unknown,
      type: ModelType,
    ): string | null => {
      if (selected === null) return null;
      if (typeof selected !== "string")
        throw new ModelConfigError("每项模型用途需明确选择模型或留空");
      const model = models.find((m) => m.id === selected);
      const provider = providers.find((p) => p.id === model?.provider);
      if (
        !model ||
        model.type !== type ||
        !model.enabled ||
        !provider?.enabled ||
        modelConfigurationError(model, provider)
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
      if (input.personaNames && Object.hasOwn(input.personaNames, name))
        p.name = text(input.personaNames[name], "人格名称", 100);
    }
    if (input.activePersona !== undefined) {
      if (
        typeof input.activePersona !== "string" ||
        !Object.hasOwn(personas, input.activePersona)
      )
        throw new ModelConfigError("当前人格必须选择已存在的人格");
      disk.channels ??= {};
      disk.channels.web ??= {};
      disk.channels.web.persona = input.activePersona;
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
    if (!["openai-compatible", "dashscope"].includes(provider.protocol))
      throw new ModelConfigError("提供商协议不受支持");
    return provider;
  }
  private async request(
    provider: ProviderConfig,
    endpoint: string,
    payload?: unknown,
  ) {
    return withModelResponse(provider, endpoint, payload, async (response) => {
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
    });
  }
  async listModels(providerId: string) {
    const provider = this.provider(providerId);
    return this.fetchModels(provider);
  }
  async listDraftModels(input: any) {
    if (!object(input?.provider))
      throw new ModelConfigError("请提供服务连接设置");
    this.protectKeys([input.provider]);
    this.snapshot();
    const old = this.source.providers.find(
      (p: ProviderConfig) => p.id === input.provider.id,
    );
    const provider = readProvider(input.provider, old, true);
    this.protectKeys([provider]);
    return this.fetchModels(provider);
  }
  private async fetchModels(provider: ProviderConfig) {
    if (provider.protocol !== "openai-compatible")
      throw new ModelConfigError(
        "DashScope 原生协议请手动填写模型标识，或使用 OpenAI 兼容地址获取模型列表",
      );
    const data = await this.request(provider, "/models");
    if (!Array.isArray(data.data))
      throw new ModelConfigError("模型服务未返回兼容的模型列表", 502);
    return {
      details: data.data
        .filter((m: any) => typeof m?.id === "string" && m.id.length <= 300)
        .map((m: any) => ({
          id: m.id,
          context_window:
            Number.isSafeInteger(m.context_window) &&
            m.context_window > 0 &&
            m.context_window <= 10000000
              ? m.context_window
              : null,
        })),
      models: [
        ...new Set<string>(
          data.data
            .filter((m: any) => typeof m?.id === "string" && m.id.length <= 300)
            .map((m: any) => m.id),
        ),
      ].sort(),
    };
  }
  async testModel(modelId: string, detectDimensions = false) {
    if (typeof detectDimensions !== "boolean")
      throw new ModelConfigError("detectDimensions 必须是布尔值");
    const model: ModelDefinition | undefined = this.config.models.find(
      (m: ModelDefinition) => m.id === modelId,
    );
    if (!model || !model.enabled)
      throw new ModelConfigError("模型不存在或已停用");
    const provider = this.provider(model.provider);
    return this.testDefinition(provider, model, detectDimensions);
  }
  async probeDraft(input: any) {
    if (!object(input) || !object(input.provider) || !object(input.model))
      throw new ModelConfigError("请提供当前表单的提供商与模型配置");
    if (
      input.detectDimensions !== undefined &&
      typeof input.detectDimensions !== "boolean"
    )
      throw new ModelConfigError("detectDimensions 必须是布尔值");
    this.protectKeys([input.provider]);
    this.snapshot();
    const old = this.source.providers.find(
      (p: ProviderConfig) => p.id === input.provider.id,
    );
    const provider = readProvider(input.provider, old, true);
    this.protectKeys([provider]);
    const model = readModel(
      { ...input.model, provider: provider.id },
      true,
      input.detectDimensions === true,
    );
    return this.testDefinition(
      provider,
      model,
      input.detectDimensions === true,
    );
  }
  private async testDefinition(
    provider: ProviderConfig,
    model: ModelDefinition,
    detectDimensions: boolean,
  ) {
    if (!provider.enabled || !model.enabled)
      throw new ModelConfigError("提供商和模型必须启用后才能测试");
    const error = modelConfigurationError(model, provider);
    if (error) throw new ModelConfigError(error);
    const expected = detectDimensions
      ? null
      : expectedDimensions(model.dimensions, model.type);
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
      const native = provider.protocol === "dashscope";
      const data = await this.request(
        provider,
        native
          ? "/services/embeddings/text-embedding/text-embedding"
          : "/embeddings",
        native
          ? {
              model: model.model,
              input: { texts: ["WhaleLife connection test"] },
              parameters,
            }
          : {
              ...parameters,
              encoding_format: "float",
              model: model.model,
              input: "WhaleLife connection test",
            },
      );
      const vector = native
        ? data.output?.embeddings?.[0]?.embedding
        : data.data?.[0]?.embedding;
      if (
        !Array.isArray(vector) ||
        !vector.length ||
        !vector.every((v: any) => typeof v === "number" && Number.isFinite(v))
      )
        throw new ModelConfigError("服务未返回有效的向量结果", 502);
      if (expected !== null && vector.length !== expected)
        throw new ModelConfigError(
          `向量维度不匹配：配置预期 ${expected}，服务实际返回 ${vector.length}；请检测维度后更新配置`,
          502,
        );
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
