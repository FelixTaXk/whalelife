/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e, typeNames, uid } from "./api.js";
import { icon } from "./icons.js";

const types = [
  ["chat", "对话", "chat"],
  ["embedding", "嵌入", "vector"],
  ["rerank", "重排序", "sliders"],
  ["stt", "语音转文字", "chat"],
  ["tts", "文字转语音", "chat"],
  ["image", "图像", "cube"],
  ["custom", "其他", "sliders"],
];
const templates = [
  {
    id: "deepseek",
    label: "DeepSeek",
    types: ["chat"],
    protocol: "openai-compatible",
    base_url: "https://api.deepseek.com",
    example: "deepseek-chat",
    note: "DeepSeek 对话接口。填写你在该服务中实际使用的模型名称。",
    mark: "D",
  },
  {
    id: "dashscope",
    label: "阿里云百炼 · DashScope",
    types: ["embedding"],
    protocol: "dashscope",
    base_url: "https://dashscope.aliyuncs.com/api/v1",
    example: "text-embedding-v4",
    note: "使用 DashScope 原生嵌入接口。API 地址和 Key 必须属于同一地域；地址可以按你的服务文档修改。",
    mark: "百",
  },
  {
    id: "bailian-chat",
    label: "阿里云百炼",
    types: ["chat"],
    protocol: "openai-compatible",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    example: "填写百炼控制台中的模型名称",
    note: "使用百炼的 OpenAI 兼容对话接口。地址和 Key 必须属于同一地域。",
    mark: "百",
  },
  {
    id: "openai",
    label: "OpenAI",
    types: ["chat", "embedding"],
    protocol: "openai-compatible",
    base_url: "https://api.openai.com/v1",
    example: "",
    note: "填写 OpenAI API 提供的模型名称。嵌入模型和对话模型分开配置。",
    mark: "O",
  },
  {
    id: "local",
    label: "本地服务 · OpenAI 兼容",
    types: ["chat", "embedding"],
    protocol: "openai-compatible",
    base_url: "",
    example: "填写本地已安装的模型名称",
    note: "填写本地服务的 OpenAI 兼容地址（包含 /v1 等前缀）。无需认证的服务可将 Key 留空。",
    mark: "L",
  },
  {
    id: "custom",
    label: "自定义 · OpenAI 兼容",
    types: ["chat", "embedding", "rerank", "image", "stt", "tts", "custom"],
    protocol: "openai-compatible",
    base_url: "",
    example: "填写服务文档中的模型名称",
    note: "填写服务商提供的 OpenAI 兼容 API 根地址。请确认该地址支持当前模型类型。",
    mark: "+",
  },
  {
    id: "plugin",
    label: "自定义协议 · 由插件调用",
    types: ["chat", "embedding", "rerank", "image", "stt", "tts", "custom"],
    protocol: "custom",
    base_url: "",
    example: "填写服务商提供的模型名称",
    note: "保存连接后由相应插件调用。协议标识按插件说明填写；主干不会猜测此服务的请求格式。",
    mark: "+",
  },
];
export const templatesFor = (type) =>
  templates.filter((t) => t.types.includes(type));
function issueFor(config, model) {
  if (model.configuration_error) return model.configuration_error;
  const p = config.providers.find((p) => p.id === model.provider);
  if (!p) return "找不到这条配置对应的服务连接。";
  if (p.protocol === "dashscope" && model.type !== "embedding")
    return "DashScope 原生嵌入接口只能配置嵌入模型。";
  try {
    if (
      new URL(p.base_url).hostname === "api.deepseek.com" &&
      model.type !== "chat"
    )
      return "这条嵌入配置误用了 DeepSeek 对话连接。请配置实际提供嵌入模型的服务。";
  } catch {
    return "API 地址无效。";
  }
  return null;
}
export const visibleModels = (config, type) =>
  config.models.filter((m) => m.type === type && !issueFor(config, m));
function inferTemplate(provider, type) {
  if (!["openai-compatible", "dashscope"].includes(provider.protocol)) return "plugin";
  if (provider.protocol === "dashscope") return "dashscope";
  try {
    const h = new URL(provider.base_url).hostname;
    if (h === "api.deepseek.com" && type === "chat") return "deepseek";
    if (h === "api.openai.com") return "openai";
    if (h.includes("dashscope") && type === "chat") return "bailian-chat";
    if (["localhost", "127.0.0.1", "::1"].includes(h)) return "local";
  } catch {}
  return "custom";
}
function draftFor(app, model, repair = false) {
  const p =
    app.state.config.providers.find((p) => p.id === model.provider) || {};
  return {
    id: model.id,
    providerId: repair ? uid("provider") : p.id,
    type: model.type,
    name: model.name,
    providerName: p.name || model.name,
    model: model.model,
    template: repair ? "" : inferTemplate(p, model.type),
    protocol: repair ? "openai-compatible" : p.protocol,
    base_url: repair ? "" : p.base_url,
    api_key: "",
    has_key: !repair && p.has_key,
    clear_key: false,
    enabled: model.enabled && p.enabled,
    providerEnabled: repair || p.enabled !== false,
    timeout_seconds: String(p.timeout_seconds ?? 120),
    proxy_url: repair ? "" : p.proxy_url || "",
    dimensions: String(model.dimensions ?? ""),
    context_window: String(model.context_window ?? ""),
    parametersText: JSON.stringify(model.parameters || {}, null, 2),
    reasoningCompatibility: structuredClone(model.reasoning_compatibility || null),
    compatibilityOriginallyConfigured: !!model.reasoning_compatibility,
    compatibilityAssistant: "",
    use: app.state.config.bindings[model.type] === model.id,
    repair,
    dirty: repair,
    version: 0,
    revision: app.state.config.revision,
  };
}
function selectedDraft(app, models) {
  const draft = app.state.modelDraft;
  if (
    draft &&
    draft.type === app.state.modelFilter &&
    (draft.dirty || draft.revision === app.state.config.revision)
  )
    return draft;
  const selected =
    models.find((m) => m.id === app.state.modelSelection) || models[0];
  if (!selected) return null;
  app.state.modelSelection = selected.id;
  return (app.state.modelDraft = draftFor(app, selected));
}
export function renderModels(app) {
  // A full render replaces the request's form. Stop its diagnostic work as well
  // as rejecting late results; normal diagnostic updates only touch the DOM.
  app.state.modelDraft?.compatibilityRun?.abort();
  const config = app.state.config;
  const type = types.some(([id]) => id === app.state.modelFilter)
    ? app.state.modelFilter
    : "chat";
  app.state.modelFilter = type;
  const label = types.find(([id]) => id === type)[1];
  const models = visibleModels(config, type);
  const connections = models.filter(
    (m, i) => models.findIndex((x) => x.provider === m.provider) === i,
  );
  const errors = config.models.filter(
    (m) => m.type === type && issueFor(config, m),
  );
  const supported = true;
  const draft = supported ? selectedDraft(app, models) : null;
  return `<div class="model-type-toolbar"><div class="tabs capability-tabs" role="tablist" aria-label="模型类型">${types.map(([id, name, ico]) => `<button type="button" class="tab ${type === id ? "active" : ""}" role="tab" aria-selected="${type === id}" data-filter="${id}">${icon(ico)}${name}${["chat", "embedding"].includes(id) ? `<span class="count">${visibleModels(config, id).length}</span>` : "<small>插件调用</small>"}</button>`).join("")}</div><a href="#bindings" class="btn small" aria-label="模型使用设置">${icon("sliders")}使用设置</a></div>
    ${errors.length ? `<details class="model-repair-summary"><summary>${errors.length} 条配置待修复</summary><p>这些记录选用了不匹配的服务，暂不能使用。原记录仍保留。<button type="button" class="btn small link" data-issues>查看并修复</button></p></details>` : ""}
    <div class="panel connection-workbench" style="--connection-offset:${errors.length ? "220px" : "182px"}"><aside class="connection-list" aria-label="${label}服务连接"><div class="connection-list-title"><h2>${label}服务连接</h2>${supported ? `<button type="button" class="btn small link" data-add>${icon("plus")}新增</button>` : ""}</div>
    ${draft?.isNew ? `<button type="button" class="connection-item active"><span class="connection-logo">${icon("plus")}</span><span><strong>${e(draft.name)}</strong><small>尚未保存</small></span></button>` : ""}
    ${connections
      .map((m) => {
        const p = config.providers.find((p) => p.id === m.provider);
        const t = templates.find((t) => t.id === inferTemplate(p, type));
        const selected = draft?.providerId === p.id;
        return `<button type="button" class="connection-item ${selected ? "active" : ""}" data-connection="${e(m.id)}" aria-pressed="${selected}"><span class="connection-logo ${t?.id === "dashscope" ? "bailian" : ""}">${e(t?.mark || "+")}</span><span><strong>${e(p.name || m.name)}</strong><small>${models.filter((x) => x.provider === p.id).length} 个${label}模型</small></span></button>`;
      })
      .join("")}
    ${!models.length && !draft?.isNew ? `<p class="connection-list-empty">尚未添加${label}配置</p>` : ""}</aside>
    <section class="connection-editor">${draft ? renderEditor(app, draft) : `<div class="empty connection-empty"><span class="empty-icon">${icon(type === "embedding" ? "vector" : "cube")}</span><h2>${supported ? `尚未配置${label}服务` : `${label}能力尚未接入`}</h2><p>${type === "embedding" ? "选择提供嵌入模型的服务，填写其 API Key 和实际模型名称。" : supported ? "选择服务类型，填写连接和模型设置。" : "接入对应接口后，这里会提供可用的配置和测试。"}</p>${supported ? `<button type="button" class="btn primary" data-add>${icon("plus")}新增${label}配置</button>` : ""}</div>`}</section></div>`;
}
const row = (name, label, description, control) =>
  `<div class="setting-row"><div class="setting-description"><label for="setting-${name}">${label}</label>${description ? `<p>${description}</p>` : ""}</div><div class="setting-control">${control}</div></div>`;
const input = (d, name, extra = "") =>
  `<input id="setting-${name}" name="${name}" value="${e(d[name] ?? "")}" ${extra}>`;
function contextCapacityMessage(d) {
  const manual = Number(d.context_window);
  const configured = Number.isSafeInteger(manual) && manual > 0 && manual <= 10000000;
  const parts = configured
    ? [`手动上限：${manual.toLocaleString()} token${d.dirty ? "（保存后生效）" : ""}。`]
    : [];
  if (d.capacityLoading) parts.push("正在读取当前模型的服务上限…");
  else if (d.capacityError) parts.push(`读取失败：${d.capacityError}。可手动填写上下文容量。`);
  else if (d.capacityResult?.tokens)
    parts.push(`服务返回：${d.capacityResult.tokens.toLocaleString()} token${configured ? "，当前优先采用手动值" : "（自动）"}。`);
  else if (d.capacityResult)
    parts.push("服务未提供此模型的上下文容量，可按服务商文档手动填写。");
  else if (!configured) parts.push("服务上限尚未读取；未知时不会显示占用百分比。");
  return parts.join(" ");
}
function compatibilityMappingText(d) {
  const mapping = d.reasoningCompatibility;
  return mapping?.response_field || mapping?.request_field
    ? `读取：${mapping.response_field || "现有字段识别"}；回传：${mapping.request_field || "reasoning_content"}`
    : "未设置专用映射，使用现有字段识别规则。";
}
function renderCompatibility(app, d) {
  if (d.type !== "chat" || d.protocol !== "openai-compatible") return "";
  const assistants = visibleModels(app.state.config, "chat").filter((m) => {
    const provider = app.state.config.providers.find((p) => p.id === m.provider);
    return m.enabled && provider?.enabled && provider.protocol === "openai-compatible";
  });
  return `<section class="model-compatibility" aria-labelledby="compatibility-heading"><div class="settings-section-title"><h3 id="compatibility-heading">接口兼容</h3><span>${e(d.name || d.model || "当前模型")}${d.reasoningCompatibility ? " · 已配置" : ""}</span></div>
    <p class="hint">使用中转站或其他兼容接口时，可在这里处理当前模型的思考字段差异。</p>
    <label for="compatibility-assistant">辅助分析模型</label><div class="compatibility-actions"><select id="compatibility-assistant" name="compatibilityAssistant"><option value="">使用当前模型</option>${assistants.map((m) => `<option value="${e(m.id)}" ${d.compatibilityAssistant === m.id ? "selected" : ""}>${e(m.name)}</option>`).join("")}</select><button type="button" class="btn tonal" data-ai-compatibility ${d.compatibilityLoading || app.state.modelSaving ? "disabled" : ""}>${d.compatibilityLoading ? "分析并验证中…" : "AI 辅助兼容配置"}</button><button type="button" class="btn small" data-cancel-compatibility ${d.compatibilityLoading ? "" : "hidden"}>取消检测</button></div>
    <p class="hint">最多调用模型 4 次，会产生用量；只用合成测试，不写入聊天。验证通过后填入草稿，保存后生效。</p>
    <div class="compatibility-mapping"><span id="compatibility-mapping">${e(compatibilityMappingText(d))}</span><button type="button" class="btn small link" data-clear-compatibility ${d.reasoningCompatibility?.response_field || d.reasoningCompatibility?.request_field ? "" : "disabled"}>清除映射</button></div>
    <label class="setting-toggle"><input name="compatibilityFill" type="checkbox" ${d.reasoningCompatibility?.fill_missing === true ? "checked" : ""}><span>缺失思考字段补空（实验性）</span></label><p class="hint">已有思考正文保持原样；接口仍可能拒绝空值。AI 辅助配置不会自动开启此项。</p>
    <div id="compatibility-result" class="connection-result ${d.compatibilityError ? "error" : ""}" role="status">${e(d.compatibilityLoading ? "正在分析并验证工具续轮…" : d.compatibilityMessage || "")}</div></section>`;
}
function renderEditor(app, d) {
  const embedding = d.type === "embedding";
  const supported = d.type === "chat" ? d.protocol === "openai-compatible"
    : d.type === "embedding" && ["openai-compatible", "dashscope"].includes(d.protocol);
  const t = templates.find((t) => t.id === d.template);
  const existing = app.state.config.models.find((m) => m.id === d.id);
  const shared = app.state.config.models.filter(
    (m) => m.provider === d.providerId && m.id !== d.id,
  );
  return `<form id="connection-form"><header class="connection-editor-header"><div><h2>${e(d.providerName || "新服务连接")}</h2><p>${e(d.base_url || "填写下面的连接设置")}</p></div><div class="row"><button type="button" class="btn link" data-probe-draft ${supported ? "" : "disabled"}>${icon("bolt")}测试当前模型</button><button type="submit" class="btn primary" id="connection-save" ${d.dirty && !app.state.modelSaving ? "" : "disabled"}>${icon("check")}保存</button></div></header>
    <div class="connection-settings"><div class="settings-section-title"><h3>设置</h3><span id="draft-state">${d.dirty ? "有未保存的修改" : "已保存"}</span></div>
    ${d.repair ? '<div class="configuration-warning repair-note">旧记录已保留。请选择正确的服务类型并填写该服务的 Key；旧 DeepSeek 密钥不会转移到新地址。</div>' : ""}
    ${d.revision !== app.state.config.revision ? '<div class="configuration-warning repair-note">已保存的配置发生了变化。当前未保存的内容仍保留；请先放弃修改，再根据最新配置重新编辑。</div>' : ""}
    ${renderCompatibility(app, d)}
    <div class="service-notice">${icon("info")}<p>${e(t?.note || "选择要连接的服务，然后填写实际模型名称。")}</p></div>
    ${renderConnectionModels(app, d)}
    <h3 class="model-section-heading">服务连接</h3>
    ${row("providerName", "连接名称", "这个连接下的模型共用地址、密钥、代理和超时。", input(d, "providerName", 'required maxlength="200"'))}
    ${row(
      "template",
      "服务类型",
      "决定使用的接口格式。",
      `<select id="setting-template" name="template" required>${!d.template ? '<option value="">请选择服务类型</option>' : ""}${templatesFor(
        d.type,
      )
        .map(
          (t) =>
            `<option value="${t.id}" ${d.template === t.id ? "selected" : ""}>${e(t.label)}</option>`,
        )
        .join("")}</select>`,
    )}
    ${d.template === "plugin" ? row("protocol", "协议标识", "按插件文档填写，例如 custom、anthropic。小写字母开头，最多64个字母、数字、点、短横线或下划线。", input(d, "protocol", 'required pattern="[a-z][a-z0-9._-]{0,63}" maxlength="64"')) : ""}
    ${row("api_key", "API Key", d.has_key ? "已保存密钥。留空保留；更换地址或接口后需重新填写。" : "填写此服务的密钥。无需认证的本地服务可留空。", `<div class="secret-input">${input(d, "api_key", 'type="password" autocomplete="new-password" placeholder="' + (d.has_key ? "留空保留已保存的 Key" : "填写 API Key") + '"')}<button type="button" class="icon-btn" data-toggle-key aria-label="显示 API Key" aria-pressed="false">${icon("eye")}</button></div>${d.has_key ? `<label class="key-clear"><input name="clear_key" type="checkbox" ${d.clear_key ? "checked" : ""}>清除已保存的 Key</label>` : ""}`)}
    ${row("base_url", "API Base URL", "API 根地址，包含服务要求的路径前缀。", input(d, "base_url", 'type="url" required placeholder="https://服务地址/v1"'))}
    ${row("timeout_seconds", "超时时间", "请求最长等待时间，单位：秒。", input(d, "timeout_seconds", 'type="number" required min="1" max="600" step="1"'))}
    ${row("proxy_url", "代理地址", "可选，仅用于此连接。支持 HTTP / HTTPS 代理。", input(d, "proxy_url", 'type="url" placeholder="http://127.0.0.1:7890"'))}
    <h3 class="model-section-heading">当前模型设置</h3>
    ${d.type === "chat" ? row("context_window", "模型上下文容量", "一次请求可容纳的总 token，不是单次输出上限。留空使用服务返回的容量；手动填写后优先采用手动值，保存后生效。", `<div class="dimension-input">${input(d, "context_window", 'type="number" min="1" max="10000000" step="1" placeholder="留空自动读取 / 手动填写"')}<button type="button" class="btn tonal" data-fetch-context ${d.protocol === "openai-compatible" && !d.capacityLoading ? "" : "disabled"}>${d.capacityLoading ? "读取中…" : "自动获取"}</button></div><p id="context-capacity-result" class="hint" role="status">${e(contextCapacityMessage(d))}</p>`) : ""}
    ${row("name", "当前模型名称", "用于使用配置中的模型选择；在上方列表切换要编辑的模型。", input(d, "name", 'required maxlength="200" placeholder="例如：百炼向量"'))}
    ${row("enabled", "启用", "允许使用这条模型配置。", `<label class="setting-toggle"><input id="setting-enabled" name="enabled" type="checkbox" ${d.enabled ? "checked" : ""}><span>启用此配置</span></label>`)}
    ${row("model", embedding ? "嵌入模型" : "模型 ID", `服务商提供的实际模型名称，与上方配置名称分开。${embedding ? "例如 text-embedding-v4。" : "请以服务文档中的名称为准。"}`, input(d, "model", `required maxlength="300" placeholder="${e(t?.example || (embedding ? "例如 text-embedding-3-small" : "填写实际模型名称"))}"`))}
    ${embedding ? row("dimensions", "嵌入维度", "记录模型实际返回的向量长度，用于检查结果是否一致。留空后点击自动检测。", `<div class="dimension-input">${input(d, "dimensions", 'type="number" min="1" max="65536" step="1" placeholder="尚未检测"')}<button type="button" class="btn tonal" data-detect ${supported ? "" : "disabled"}>自动检测</button></div>`) : ""}
    ${supported ? row("use", embedding ? "选为嵌入模型" : "选为对话模型", embedding ? "保存后记录此选择。记忆向量检索尚未接入。" : "保存后用于新的对话请求；人格单独指定的模型仍优先。", `<label class="setting-toggle"><input id="setting-use" name="use" type="checkbox" ${d.use ? "checked" : ""}><span>使用此配置</span></label>`) : ""}
    <details class="request-parameters"><summary>高级请求参数（可选）</summary><p>仅在服务文档要求时填写 JSON。${embedding ? `如模型支持缩减维度，可通过 ${d.protocol === "dashscope" ? "dimension" : "dimensions"} 指定请求维度，然后重新检测实际结果。` : "例如 temperature。"}</p><textarea name="parametersText" aria-label="高级请求参数" rows="5" spellcheck="false">${e(d.parametersText)}</textarea></details>
    ${shared.length ? `<details class="shared-connection-note"><summary>共用此连接的其他模型（${shared.length}）</summary>${shared.map((m) => `<p><strong>${e(m.name)}</strong> · ${e(m.model)} · ${e(typeNames[m.type])}${issueFor(app.state.config, m) ? `<br><span class="form-error">${e(issueFor(app.state.config, m))}</span>` : ""}</p>`).join("")}</details>` : ""}
    <div id="connection-result" class="connection-result ${d.probeError ? "error" : ""}" role="status">${e(d.probeMessage || "")}</div><div id="connection-error" class="form-error" role="alert"></div>
    <footer class="connection-footer"><button type="button" class="btn small" data-discard>放弃修改</button>${existing ? `<button type="button" class="btn small danger" data-delete>${icon("trash")}删除此配置</button>` : ""}</footer>
    </div></form>`;
}
function capture(form, d) {
  const data = new FormData(form);
  for (const name of [
    "name",
    "providerName",
    "template",
    "protocol",
    "base_url",
    "api_key",
    "model",
    "timeout_seconds",
    "proxy_url",
    "dimensions",
    "context_window",
    "parametersText",
    "compatibilityAssistant",
  ])
    if (data.has(name)) d[name] = String(data.get(name));
  for (const name of ["enabled", "clear_key", "use"]) d[name] = data.has(name);
  if (d.type === "chat" && d.protocol === "openai-compatible") {
    const compatibility = { ...d.reasoningCompatibility };
    if (data.has("compatibilityFill")) compatibility.fill_missing = true;
    else delete compatibility.fill_missing;
    d.reasoningCompatibility = Object.keys(compatibility).length ? compatibility : null;
  }
}
function renderConnectionModels(app, d) {
  const models = visibleModels(app.state.config, d.type).filter(
    (m) => m.provider === d.providerId,
  );
  return `<section class="connection-models"><div class="settings-section-title"><h3>已配置的模型 <span class="badge">${models.length}</span></h3><div class="row"><button type="button" class="btn small tonal" data-fetch-models ${!["openai-compatible", "dashscope"].includes(d.protocol) ? 'disabled title="此协议请自定义添加模型，或使用对应插件获取模型列表"' : ""}>${icon("download")}获取模型列表</button><button type="button" class="btn small" data-custom-model>${icon("plus")}自定义模型</button></div></div>${d.protocol === "dashscope" ? '<p class="hint">此连接使用百炼原生嵌入接口，获取文本嵌入模型。千问对话和识图模型请在“对话”中配置百炼兼容接口。</p>' : ""}${models.map((m) => `<button type="button" class="configured-model ${d.id === m.id ? "selected" : ""}" data-edit-model="${e(m.id)}"><span><strong>${e(m.name)}</strong><small>${e(m.model)}</small></span><span class="badge ${m.enabled ? "green" : ""}">${m.enabled ? "已启用" : "已停用"}</span>${app.state.config.bindings[d.type] === m.id ? '<span class="badge">当前使用</span>' : ""}<span class="btn small link">编辑 ${icon("sliders")}</span></button>`).join("") || '<p class="muted">填写下方连接后，获取模型列表并勾选添加，也可手动填写模型。</p>'}</section>`;
}
export function configWithModels(next, d, choices) {
  if (d.isNew && !d.model.trim()) {
    const { provider } = payloadFor(d);
    provider.name = d.providerName || d.name;
    next.revision = d.revision;
    next.providers.push(provider);
  } else next = configWithDraft(next, d);
  for (const choice of choices) {
    const model = String(choice.model || "").trim();
    if (!model || model.length > 300)
      throw Error("模型 ID 不能为空或超过 300 字符");
    if (
      next.models.some(
        (m) =>
          m.provider === d.providerId && m.type === d.type && m.model === model,
      )
    )
      continue;
    next.models.push({
      id: uid("model"),
      provider: d.providerId,
      type: d.type,
      model,
      name: choice.name?.trim() || model,
      enabled: true,
      parameters: {},
      dimensions: null,
    });
  }
  return next;
}
async function addModels(app, d, choices) {
  if (!choices.length) throw Error("请至少选择一个模型");
  if (app.state.modelSaving) throw Error("配置正在保存，请稍后重试");
  d.compatibilityRun?.abort();
  app.state.modelSaving = true;
  try {
    const next = configWithModels(app.configDraft(), d, choices);
    const selected = next.models.find(
      (m) =>
        m.provider === d.providerId &&
        m.type === d.type &&
        m.model === choices[0].model,
    );
    await app.saveConfig(next);
    app.state.modelDraft = null;
    app.state.modelSelection = selected?.id;
    app.render();
  } finally {
    app.state.modelSaving = false;
    refreshCompatibilityButton(app);
  }
}
async function fetchModels(app, form, d) {
  capture(form, d);
  const version = d.version;
  const button = form.querySelector("[data-fetch-models]");
  button.disabled = true;
  const errorBox = form.querySelector("#connection-error");
  errorBox.textContent = "";
  try {
    const { provider } = payloadFor(d);
    const { models } = await api("/api/model-config/models/draft", {
      provider,
    });
    if (app.state.modelDraft !== d || d.version !== version) return;
    const existing = new Set(
      app.state.config.models
        .filter((m) => m.provider === d.providerId && m.type === d.type)
        .map((m) => m.model),
    );
    app.dialog(
      `添加${typeNames[d.type] || d.type}模型`,
      `<p>从此连接返回的列表中选择模型，可一次添加多个。列表可能包含不同用途，请确认所选模型支持当前用途。</p><input id="model-list-search" type="search" aria-label="搜索模型" placeholder="搜索模型 ID"><div class="row model-picker-tools"><span>${models.length} 个模型</span><button type="button" class="btn small" id="model-select-visible">全选当前结果</button></div><div class="model-picker">${models.map((m) => `<label class="model-choice" data-model-name="${e(m.toLowerCase())}"><input type="checkbox" name="model" value="${e(m)}" ${existing.has(m) ? "disabled checked" : ""}><span>${e(m)}</span>${existing.has(m) ? "<small>已添加</small>" : ""}</label>`).join("") || '<p class="empty">服务未返回模型，可使用自定义模型添加。</p>'}</div>`,
      async (data) =>
        addModels(
          app,
          d,
          data.getAll("model").map((model) => ({ model })),
        ),
      "添加选中模型",
    );
    document.querySelector("#model-list-search").oninput = (event) => {
      const query = event.target.value.trim().toLowerCase();
      document
        .querySelectorAll("[data-model-name]")
        .forEach(
          (row) => (row.hidden = !row.dataset.modelName.includes(query)),
        );
    };
    document.querySelector("#model-select-visible").onclick = () => {
      document.querySelectorAll("[data-model-name]").forEach((row) => {
        const checkbox = row.querySelector("input");
        if (!row.hidden && !checkbox.disabled) checkbox.checked = true;
      });
    };
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
function customModel(app, form, d) {
  capture(form, d);
  app.dialog(
    "在此连接中添加模型",
    `<label for="custom-model-id">模型 ID</label><input id="custom-model-id" name="model" required maxlength="300" placeholder="服务商提供的实际模型名称"><label for="custom-model-name">显示名称（可选）</label><input id="custom-model-name" name="name" maxlength="200"><p>使用当前连接的地址和密钥。添加后可在模型列表中编辑参数${d.type === "embedding" ? "并检测嵌入维度" : ""}。</p>`,
    async (data) =>
      addModels(app, d, [
        {
          model: String(data.get("model")).trim(),
          name: String(data.get("name") || ""),
        },
      ]),
    "添加模型",
  );
}
function markDirty(app, form, d) {
  capture(form, d);
  d.compatibilityRun?.abort();
  d.compatibilityMessage = "";
  d.compatibilityError = false;
  const compatibilityOutput = form.querySelector("#compatibility-result");
  if (compatibilityOutput) compatibilityOutput.textContent = "";
  d.dirty = true;
  d.version++;
  d.probeMessage = "";
  d.probeError = false;
  d.capacityResult = null;
  d.capacityError = "";
  const capacityOutput = form.querySelector("#context-capacity-result");
  if (capacityOutput) capacityOutput.textContent = contextCapacityMessage(d);
  form.querySelector("#draft-state").textContent = "有未保存的修改";
  form.querySelector("#connection-save").disabled = false;
  form.querySelector("#connection-result").textContent = "";
  form.querySelector("#connection-error").textContent = "";
}
function refreshCompatibilityButton(app) {
  const button = app.content.querySelector("#connection-form")?.querySelector("[data-ai-compatibility]");
  if (button) button.disabled = !!app.state.modelSaving || !!app.state.modelDraft?.compatibilityLoading;
}
function leaveDraft(app, action) {
  if (app.state.modelSaving) return;
  const leave = () => { app.state.modelDraft?.compatibilityRun?.abort(); action(); };
  if (!app.state.modelDraft?.dirty) return leave();
  app.dialog(
    "放弃未保存的修改？",
    "<p>当前配置尚未保存。放弃后再切换。</p>",
    async () => {
      setTimeout(leave, 0);
    },
    "放弃并继续",
  );
}
export function bindModels(app) {
  const root = app.content;
  root.querySelectorAll("[data-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        if (app.state.modelFilter === b.dataset.filter) return;
        leaveDraft(app, () => {
          app.state.modelDraft = null;
          app.state.modelFilter = b.dataset.filter;
          app.render();
        });
      }),
  );
  root.querySelectorAll("[data-connection]").forEach(
    (b) =>
      (b.onclick = () => {
        if (app.state.modelDraft?.id === b.dataset.connection) return;
        leaveDraft(app, () => {
          app.state.modelDraft = null;
          app.state.modelSelection = b.dataset.connection;
          app.render();
        });
      }),
  );
  root
    .querySelectorAll("[data-add]")
    .forEach(
      (b) => (b.onclick = () => leaveDraft(app, () => chooseTemplate(app))),
    );
  root
    .querySelector("[data-issues]")
    ?.addEventListener("click", () => showIssues(app));
  const form = root.querySelector("#connection-form");
  if (!form) return;
  const d = app.state.modelDraft;
  root.querySelectorAll("[data-edit-model]").forEach(
    (b) =>
      (b.onclick = () =>
        leaveDraft(app, () => {
          app.state.modelDraft = null;
          app.state.modelSelection = b.dataset.editModel;
          app.render();
        })),
  );
  root
    .querySelector("[data-fetch-models]")
    ?.addEventListener("click", () => fetchModels(app, form, d));
  root
    .querySelector("[data-custom-model]")
    ?.addEventListener("click", () => customModel(app, form, d));
  form
    .querySelector("[data-fetch-context]")
    ?.addEventListener("click", () => fetchContextCapacity(app, form, d));
  form.oninput = (event) => {
    if (event?.target?.name === "compatibilityAssistant") {
      capture(form, d);
      d.compatibilityRun?.abort();
      d.version++;
      d.compatibilityMessage = "";
      d.compatibilityError = false;
      const output = form.querySelector("#compatibility-result");
      if (output) output.textContent = "";
      return;
    }
    markDirty(app, form, d);
  };
  if (d.type === "chat" && d.protocol === "openai-compatible") {
    form.querySelector("[data-ai-compatibility]")?.addEventListener("click", () => assistCompatibility(app, form, d));
    form.querySelector("[data-cancel-compatibility]")?.addEventListener("click", () => d.compatibilityRun?.abort());
    form.querySelector("[data-clear-compatibility]")?.addEventListener("click", () => {
      markDirty(app, form, d);
      d.reasoningCompatibility = d.reasoningCompatibility?.fill_missing ? { fill_missing: true } : null;
      form.querySelector("#compatibility-mapping").textContent = compatibilityMappingText(d);
      form.querySelector("[data-clear-compatibility]").disabled = true;
    });
  }
  form.querySelector("[name=template]").onchange = () => {
    const t = templates.find((t) => t.id === form.elements.template.value);
    if (!t) return;
    capture(form, d);
    d.compatibilityRun?.abort();
    d.protocol = t.protocol;
    d.base_url = t.base_url;
    d.api_key = "";
    d.dimensions = "";
    d.dirty = true;
    d.version++;
    d.probeMessage = "";
    d.capacityResult = null;
    d.capacityError = "";
    d.compatibilityMessage = "";
    if (d.protocol !== "openai-compatible") d.reasoningCompatibility = null;
    app.render();
  };
  const protocolInput = form.querySelector("[name=protocol]");
  if (protocolInput) protocolInput.onchange = () => { markDirty(app, form, d); app.render(); };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (app.state.modelSaving) return;
    d.compatibilityRun?.abort();
    capture(form, d);
    const button = form.querySelector("#connection-save");
    button.disabled = true;
    app.state.modelSaving = true;
    const compatibilityButton = form.querySelector("[data-ai-compatibility]");
    if (compatibilityButton) compatibilityButton.disabled = true;
    try {
      const next = configWithDraft(app.configDraft(), d);
      await app.saveConfig(next);
      app.state.modelDraft = null;
      app.state.modelSelection = d.id;
      app.render();
    } catch (error) {
      form.querySelector("#connection-error").textContent = error.message;
      button.disabled = false;
    } finally {
      app.state.modelSaving = false;
      refreshCompatibilityButton(app);
    }
  };
  form
    .querySelector("[data-toggle-key]")
    ?.addEventListener("click", (event) => {
      const field = form.elements.api_key;
      const visible = field.type === "password";
      field.type = visible ? "text" : "password";
      const button = event.currentTarget;
      button.setAttribute(
        "aria-label",
        visible ? "隐藏 API Key" : "显示 API Key",
      );
      button.setAttribute("aria-pressed", String(visible));
      button.innerHTML = icon(visible ? "eyeOff" : "eye");
    });
  form.querySelector("[data-probe-draft]").onclick = () =>
    probe(app, form, d, false);
  form
    .querySelector("[data-detect]")
    ?.addEventListener("click", () => probe(app, form, d, true));
  form.querySelector("[data-discard]").onclick = () =>
    leaveDraft(app, () => {
      app.state.modelDraft = null;
      app.render();
    });
  form
    .querySelector("[data-delete]")
    ?.addEventListener("click", () => deleteConnection(app, d));
}
async function fetchContextCapacity(app, form, d) {
  capture(form, d);
  const version = d.version;
  const button = form.querySelector("[data-fetch-context]");
  const output = form.querySelector("#context-capacity-result");
  if (!d.model.trim()) {
    d.capacityError = "请先填写实际模型 ID";
    output.textContent = contextCapacityMessage(d);
    return;
  }
  button.disabled = true;
  d.capacityLoading = true;
  d.capacityError = "";
  d.capacityResult = null;
  output.textContent = contextCapacityMessage(d);
  try {
    const { provider } = payloadFor(d);
    const result = await api("/api/model-config/models/draft", { provider });
    if (app.state.modelDraft !== d || d.version !== version) return;
    const values = (result.details || [])
      .filter((model) => model.id === d.model.trim())
      .map((model) => model.context_window)
      .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 10000000);
    d.capacityResult = { tokens: values.length ? Math.min(...values) : null };
  } catch (error) {
    if (app.state.modelDraft !== d || d.version !== version) return;
    d.capacityError = error.message;
  } finally {
    d.capacityLoading = false;
    button.disabled = d.protocol !== "openai-compatible";
    if (app.state.modelDraft === d) {
      const currentForm = app.content.querySelector("#connection-form");
      const currentButton = currentForm?.querySelector("[data-fetch-context]");
      const currentOutput = currentForm?.querySelector("#context-capacity-result");
      if (currentButton) {
        currentButton.disabled = d.protocol !== "openai-compatible";
        currentButton.textContent = "自动获取";
      }
      if (currentOutput) currentOutput.textContent = contextCapacityMessage(d);
    }
  }
}
function payloadFor(d) {
  let parameters;
  try {
    parameters = JSON.parse(d.parametersText || "{}");
  } catch {
    throw Error("高级请求参数必须是有效的 JSON 对象。");
  }
  if (
    !parameters ||
    Array.isArray(parameters) ||
    typeof parameters !== "object"
  )
    throw Error("高级请求参数必须是 JSON 对象。");
  return {
    provider: {
      id: d.providerId,
      protocol: d.protocol,
      base_url: d.base_url.trim(),
      api_key: d.api_key.trim(),
      clear_key: d.clear_key,
      enabled: d.providerEnabled !== false || d.enabled,
      timeout_seconds: Number(d.timeout_seconds),
      proxy_url: d.proxy_url.trim(),
    },
    model: {
      id: d.id,
      name: d.name.trim(),
      provider: d.providerId,
      model: d.model.trim(),
      type: d.type,
      enabled: d.enabled,
      parameters,
      dimensions: d.dimensions === "" ? null : Number(d.dimensions),
      context_window:
        d.type === "chat" && d.context_window ? Number(d.context_window) : null,
      ...(d.type === "chat" && d.protocol === "openai-compatible" && d.reasoningCompatibility
        ? { reasoning_compatibility: { ...d.reasoningCompatibility } }
        : d.compatibilityOriginallyConfigured ? { reasoning_compatibility: null } : {}),
    },
  };
}
async function assistCompatibility(app, form, d) {
  if (app.state.modelSaving || d.compatibilityLoading || !form.reportValidity()) return;
  capture(form, d);
  const output = form.querySelector("#compatibility-result");
  const button = form.querySelector("[data-ai-compatibility]");
  const cancel = form.querySelector("[data-cancel-compatibility]");
  let payload;
  try { payload = payloadFor(d); }
  catch (error) { output.textContent = error.message; output.classList.add("error"); return; }
  const assistantModelId = d.compatibilityAssistant || "";
  const fingerprint = JSON.stringify({ payload, assistantModelId });
  const version = d.version, revision = app.state.config.revision;
  const controller = new AbortController();
  const current = () => {
    if (app.state.modelDraft !== d || d.compatibilityRun !== controller || d.version !== version ||
        app.state.config.revision !== revision || form.isConnected === false || app.content.querySelector("#connection-form") !== form) return false;
    try {
      const now = { ...d, reasoningCompatibility: d.reasoningCompatibility && { ...d.reasoningCompatibility } };
      capture(form, now);
      return JSON.stringify({ payload: payloadFor(now), assistantModelId: now.compatibilityAssistant || "" }) === fingerprint;
    } catch { return false; }
  };
  d.compatibilityRun = controller;
  d.compatibilityLoading = true;
  d.compatibilityMessage = "";
  d.compatibilityError = false;
  button.disabled = true;
  button.textContent = "分析并验证中…";
  cancel.hidden = false;
  output.classList.remove("error");
  output.textContent = "正在分析并验证工具续轮…";
  const onNavigate = () => controller.abort();
  globalThis.addEventListener?.("hashchange", onNavigate, { once: true });
  try {
    // Keep this diagnostic request cancellable without changing other API callers.
    payload.provider.enabled = true;
    payload.model.enabled = true;
    const response = await fetch("/api/model-config/compatibility", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ ...payload, ...(assistantModelId ? { assistantModelId } : {}) }),
    });
    const result = await response.json();
    if (controller.signal.aborted) throw Error("检测已取消");
    if (!current()) return;
    if (!response.ok) throw Error(result.error || "兼容检测请求失败");
    const usage = result.usage;
    const count = Number.isSafeInteger(result.requests) ? ` · ${result.requests} 次请求` : "";
    const tokens = Number.isSafeInteger(usage?.input_tokens) && Number.isSafeInteger(usage?.output_tokens)
      ? ` · ${usage.input_tokens.toLocaleString()} 输入 / ${usage.output_tokens.toLocaleString()} 输出 token` : "";
    if (result.verified !== true) {
      d.compatibilityMessage = `${result.message || "未能验证兼容映射，当前设置未改变。"}${count}${tokens}`;
      d.compatibilityError = true;
      return;
    }
    const mapping = result.compatibility;
    if (typeof mapping?.response_field !== "string" || !mapping.response_field ||
        typeof mapping?.request_field !== "string" || !mapping.request_field)
      throw Error("检测返回的映射不完整，当前设置未改变。");
    d.reasoningCompatibility = { response_field: mapping.response_field, request_field: mapping.request_field,
      ...(d.reasoningCompatibility?.fill_missing === true ? { fill_missing: true } : {}) };
    d.dirty = true;
    d.version++;
    d.compatibilityMessage = `${result.message || "工具续轮验证通过"}${count}${tokens}。映射已填入草稿，请保存后使用。`;
    d.compatibilityError = false;
    form.querySelector("#compatibility-mapping").textContent = compatibilityMappingText(d);
    form.querySelector("[data-clear-compatibility]").disabled = false;
    form.querySelector("#connection-save").disabled = false;
    form.querySelector("#draft-state").textContent = "兼容映射尚未保存";
  } catch (error) {
    if (!current()) return;
    d.compatibilityMessage = controller.signal.aborted ? "检测已取消，当前映射未改变。" : error.message;
    d.compatibilityError = !controller.signal.aborted;
  } finally {
    globalThis.removeEventListener?.("hashchange", onNavigate);
    if (d.compatibilityRun === controller) {
      delete d.compatibilityRun;
      d.compatibilityLoading = false;
      if (app.state.modelDraft === d) {
        const activeForm = app.content.querySelector("#connection-form");
        const activeButton = activeForm?.querySelector("[data-ai-compatibility]");
        const activeCancel = activeForm?.querySelector("[data-cancel-compatibility]");
        if (activeButton) { activeButton.disabled = !!app.state.modelSaving; activeButton.textContent = "AI 辅助兼容配置"; }
        if (activeCancel) activeCancel.hidden = true;
        const activeOutput = activeForm?.querySelector("#compatibility-result");
        if (activeOutput && activeForm.isConnected !== false) {
          activeOutput.textContent = d.compatibilityMessage || "设置或页面已更改，请重新检测。";
          activeOutput.classList.toggle("error", !!d.compatibilityError);
        }
      }
    }
  }
}
export function configWithDraft(next, d) {
  const { provider, model } = payloadFor(d);
  next.revision = d.revision;
  const oldProvider = next.providers.find((p) => p.id === provider.id);
  provider.name = d.providerName || oldProvider?.name || d.name;
  // Activating one model must not activate siblings hidden by a disabled legacy connection.
  if (oldProvider?.enabled === false && provider.enabled)
    next.models = next.models.map((m) =>
      m.provider === provider.id && m.id !== model.id
        ? { ...m, enabled: false }
        : m,
    );
  next.providers = oldProvider
    ? next.providers.map((p) =>
        p.id === provider.id ? { ...p, ...provider } : p,
      )
    : [...next.providers, provider];
  const exists = next.models.some((m) => m.id === model.id);
  next.models = exists
    ? next.models.map((m) => (m.id === model.id ? model : m))
    : [...next.models, model];
  if (d.use) next.bindings[d.type] = d.id;
  else if (next.bindings[d.type] === d.id) next.bindings[d.type] = null;
  return next;
}
async function probe(app, form, d, detectDimensions) {
  if (!form.reportValidity()) return;
  capture(form, d);
  const version = d.version;
  const controls = form.querySelectorAll("[data-probe-draft], [data-detect]");
  controls.forEach((b) => (b.disabled = true));
  const output = form.querySelector("#connection-result");
  output.classList.remove("error");
  output.textContent = detectDimensions
    ? "正在请求嵌入接口并检测维度…"
    : "正在测试当前表单中的设置…";
  try {
    const payload = payloadFor(d);
    payload.provider.enabled = true;
    payload.model.enabled = true;
    const result = await api("/api/model-config/probe", {
      ...payload,
      detectDimensions,
    });
    if (app.state.modelDraft !== d || d.version !== version) return;
    if (detectDimensions) {
      d.dimensions = String(result.dimensions);
      form.elements.dimensions.value = d.dimensions;
      d.dirty = true;
      d.version++;
      form.querySelector("#connection-save").disabled = false;
      form.querySelector("#draft-state").textContent = "检测结果尚未保存";
    }
    d.probeMessage = `${result.message} · ${result.latency_ms} ms${result.dimensions ? ` · ${result.dimensions} 维` : ""}${detectDimensions ? "。已填入嵌入维度，请保存。" : "。测试未修改已保存的配置。"}`;
    d.probeError = false;
  } catch (error) {
    if (app.state.modelDraft !== d || d.version !== version) return;
    d.probeMessage = error.message;
    d.probeError = true;
  } finally {
    controls.forEach((b) => (b.disabled = false));
    if (app.state.modelDraft === d) {
      output.textContent = d.probeMessage || "设置已更改，请重新测试。";
      output.classList.toggle("error", !!d.probeError);
    }
  }
}
function chooseTemplate(app) {
  const type = app.state.modelFilter;
  const label = type === "embedding" ? "嵌入" : "对话";
  app.dialog(
    `新增${label}配置`,
    `<p class="template-intro">选择提供${label}模型的服务，然后填写连接参数。</p><div class="service-template-grid">${templatesFor(
      type,
    )
      .map(
        (t) =>
          `<button type="button" class="service-template" data-template="${t.id}"><span class="connection-logo ${t.id === "dashscope" ? "bailian" : ""}">${e(t.mark)}</span><strong>${e(t.label)}</strong><small>${t.protocol === "dashscope" ? "DashScope 原生嵌入接口" : t.protocol === "openai-compatible" ? "OpenAI 兼容接口" : "由插件解释协议"}</small>${icon("arrow")}</button>`,
      )
      .join("")}</div>`,
    null,
  );
  document.querySelectorAll("[data-template]").forEach(
    (b) =>
      (b.onclick = () => {
        const t = templates.find((t) => t.id === b.dataset.template);
        app.state.modelDraft = {
          id: uid("model"),
          providerId: uid("provider"),
          type,
          name: `${t.label.split(" · ")[0]} ${label}`,
          providerName: t.label.split(" · ")[0],
          model: "",
          template: t.id,
          protocol: t.protocol,
          base_url: t.base_url,
          api_key: "",
          has_key: false,
          clear_key: false,
          enabled: true,
          timeout_seconds: "120",
          proxy_url: "",
          dimensions: "",
          parametersText: "{}",
          use: false,
          isNew: true,
          dirty: true,
          version: 0,
          revision: app.state.config.revision,
        };
        app.closeDialog();
        app.render();
      }),
  );
}
function showIssues(app) {
  const models = app.state.config.models.filter((m) =>
    issueFor(app.state.config, m),
  );
  app.dialog(
    "需要修复的旧配置",
    `<p class="template-intro">记录保留在本机，但不能用于请求。修复时需要填写正确服务的连接和密钥。</p>${models.map((m) => `<div class="invalid-model"><strong>${e(m.name)}</strong><p>${e(issueFor(app.state.config, m))}</p><button type="button" class="btn small tonal" data-repair="${e(m.id)}">修复配置</button></div>`).join("")}`,
    null,
  );
  document.querySelectorAll("[data-repair]").forEach(
    (b) =>
      (b.onclick = () => {
        const m = models.find((m) => m.id === b.dataset.repair);
        app.closeDialog();
        leaveDraft(app, () => {
          app.state.modelFilter = m.type;
          app.state.modelDraft = draftFor(app, m, true);
          app.render();
        });
      }),
  );
}
function deleteConnection(app, d) {
  app.dialog(
    "删除模型配置",
    `<p>删除「${e(d.name)}」？已选用的模型需要先在使用设置中取消选择。</p>`,
    async () => {
      d.compatibilityRun?.abort();
      const next = app.configDraft();
      next.revision = d.revision;
      const original = next.models.find((m) => m.id === d.id);
      next.models = next.models.filter((m) => m.id !== d.id);
      if (
        original &&
        !next.models.some((m) => m.provider === original.provider)
      )
        next.providers = next.providers.filter(
          (p) => p.id !== original.provider,
        );
      await app.saveConfig(next);
      app.state.modelDraft = null;
      app.render();
    },
    "删除配置",
    true,
  );
}
