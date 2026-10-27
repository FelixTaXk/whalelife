import { api, escapeHTML as e, typeNames, uid } from "./api.js";
import { icon } from "./icons.js";

const types = [
  ["chat", "对话", "chat"],
  ["embedding", "嵌入", "vector"],
  ["rerank", "重排序", "sliders"],
  ["stt", "语音转文字", "chat"],
  ["tts", "文字转语音", "chat"],
  ["image", "图像", "cube"],
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
    types: ["chat", "embedding"],
    protocol: "openai-compatible",
    base_url: "",
    example: "填写服务文档中的模型名称",
    note: "填写服务商提供的 OpenAI 兼容 API 根地址。请确认该地址支持当前模型类型。",
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
    parametersText: JSON.stringify(model.parameters || {}, null, 2),
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
  const config = app.state.config;
  const type = types.some(([id]) => id === app.state.modelFilter)
    ? app.state.modelFilter
    : "chat";
  app.state.modelFilter = type;
  const label = types.find(([id]) => id === type)[1];
  const models = visibleModels(config, type);
  const errors = config.models.filter(
    (m) => m.type === type && issueFor(config, m),
  );
  const supported = ["chat", "embedding"].includes(type);
  const draft = supported ? selectedDraft(app, models) : null;
  return `<div class="model-type-toolbar"><div class="tabs capability-tabs" role="tablist" aria-label="模型类型">${types.map(([id, name, ico]) => `<button type="button" class="tab ${type === id ? "active" : ""}" role="tab" aria-selected="${type === id}" data-filter="${id}">${icon(ico)}${name}${["chat", "embedding"].includes(id) ? `<span class="count">${visibleModels(config, id).length}</span>` : "<small>未接入</small>"}</button>`).join("")}</div><a href="#bindings" class="btn small" aria-label="模型使用设置">${icon("sliders")}使用设置</a></div>
    ${errors.length ? `<details class="model-repair-summary"><summary>${errors.length} 条配置待修复</summary><p>这些记录选用了不匹配的服务，暂不能使用。原记录仍保留。<button type="button" class="btn small link" data-issues>查看并修复</button></p></details>` : ""}
    <div class="panel connection-workbench" style="--connection-offset:${errors.length ? "220px" : "182px"}"><aside class="connection-list" aria-label="${label}模型配置"><div class="connection-list-title"><h2>${label}模型配置</h2>${supported ? `<button type="button" class="btn small link" data-add>${icon("plus")}新增</button>` : ""}</div>
    ${draft?.isNew ? `<button type="button" class="connection-item active"><span class="connection-logo">${icon("plus")}</span><span><strong>${e(draft.name)}</strong><small>尚未保存</small></span></button>` : ""}
    ${models
      .map((m) => {
        const p = config.providers.find((p) => p.id === m.provider);
        const t = templates.find((t) => t.id === inferTemplate(p, type));
        return `<button type="button" class="connection-item ${draft?.id === m.id ? "active" : ""}" data-connection="${e(m.id)}" aria-pressed="${draft?.id === m.id}"><span class="connection-logo ${t?.id === "dashscope" ? "bailian" : ""}">${e(t?.mark || "+")}</span><span><strong>${e(m.name)}</strong><small>${e(m.model)}</small></span>${config.bindings[type] === m.id ? '<i class="status-dot" title="已选用"></i>' : ""}</button>`;
      })
      .join("")}
    ${!models.length && !draft?.isNew ? `<p class="connection-list-empty">尚未添加${label}配置</p>` : ""}</aside>
    <section class="connection-editor">${draft ? renderEditor(app, draft) : `<div class="empty connection-empty"><span class="empty-icon">${icon(type === "embedding" ? "vector" : "cube")}</span><h2>${supported ? `尚未配置${label}服务` : `${label}能力尚未接入`}</h2><p>${type === "embedding" ? "选择提供嵌入模型的服务，填写其 API Key 和实际模型名称。" : supported ? "选择服务类型，填写连接和模型设置。" : "接入对应接口后，这里会提供可用的配置和测试。"}</p>${supported ? `<button type="button" class="btn primary" data-add>${icon("plus")}新增${label}配置</button>` : ""}</div>`}</section></div>`;
}
const row = (name, label, description, control) =>
  `<div class="setting-row"><div class="setting-description"><label for="setting-${name}">${label}</label>${description ? `<p>${description}</p>` : ""}</div><div class="setting-control">${control}</div></div>`;
const input = (d, name, extra = "") =>
  `<input id="setting-${name}" name="${name}" value="${e(d[name] ?? "")}" ${extra}>`;
function renderEditor(app, d) {
  const embedding = d.type === "embedding";
  const supported = ["chat", "embedding"].includes(d.type);
  const t = templates.find((t) => t.id === d.template);
  const existing = app.state.config.models.find((m) => m.id === d.id);
  const shared = app.state.config.models.filter(
    (m) => m.provider === d.providerId && m.id !== d.id,
  ).length;
  return `<form id="connection-form"><header class="connection-editor-header"><div><h2>${e(d.name || "新模型配置")}</h2><p>${e(d.base_url || "填写下面的连接设置")}</p></div><div class="row"><button type="button" class="btn link" data-probe-draft ${supported ? "" : "disabled"}>${icon("bolt")}测试</button><button type="submit" class="btn primary" id="connection-save" ${d.dirty && !app.state.modelSaving ? "" : "disabled"}>${icon("check")}保存</button></div></header>
    <div class="connection-settings"><div class="settings-section-title"><h3>设置</h3><span id="draft-state">${d.dirty ? "有未保存的修改" : "已保存"}</span></div>
    ${d.repair ? '<div class="configuration-warning repair-note">旧记录已保留。请选择正确的服务类型并填写该服务的 Key；旧 DeepSeek 密钥不会转移到新地址。</div>' : ""}
    ${d.revision !== app.state.config.revision ? '<div class="configuration-warning repair-note">已保存的配置发生了变化。当前未保存的内容仍保留；请先放弃修改，再根据最新配置重新编辑。</div>' : ""}
    <div class="service-notice">${icon("info")}<p>${e(t?.note || "选择要连接的服务，然后填写实际模型名称。")}</p></div>
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
    ${row("name", "配置名称", "由你命名，方便在列表和使用设置中识别。", input(d, "name", 'required maxlength="200" placeholder="例如：百炼向量"'))}
    ${row("enabled", "启用", "允许使用这条模型配置。", `<label class="setting-toggle"><input id="setting-enabled" name="enabled" type="checkbox" ${d.enabled ? "checked" : ""}><span>启用此配置</span></label>`)}
    ${row("api_key", "API Key", d.has_key ? "已保存密钥。留空保留；更换地址或接口后需重新填写。" : "填写此服务的密钥。无需认证的本地服务可留空。", `<div class="secret-input">${input(d, "api_key", 'type="password" autocomplete="new-password" placeholder="' + (d.has_key ? "留空保留已保存的 Key" : "填写 API Key") + '"')}<button type="button" class="icon-btn" data-toggle-key aria-label="显示 API Key" aria-pressed="false">${icon("eye")}</button></div>${d.has_key ? `<label class="key-clear"><input name="clear_key" type="checkbox" ${d.clear_key ? "checked" : ""}>清除已保存的 Key</label>` : ""}`)}
    ${row("base_url", "API Base URL", "API 根地址，包含服务要求的路径前缀。", input(d, "base_url", 'type="url" required placeholder="https://服务地址/v1"'))}
    ${row("model", embedding ? "嵌入模型" : "对话模型", `服务商提供的实际模型名称，与上方配置名称分开。${embedding ? "例如 text-embedding-v4。" : "请以服务文档中的名称为准。"}`, input(d, "model", `required maxlength="300" placeholder="${e(t?.example || (embedding ? "例如 text-embedding-3-small" : "填写实际模型名称"))}"`))}
    ${embedding ? row("dimensions", "嵌入维度", "记录模型实际返回的向量长度，用于检查结果是否一致。留空后点击自动检测。", `<div class="dimension-input">${input(d, "dimensions", 'type="number" min="1" max="65536" step="1" placeholder="尚未检测"')}<button type="button" class="btn tonal" data-detect>自动检测</button></div>`) : ""}
    ${row("timeout_seconds", "超时时间", "请求最长等待时间，单位：秒。", input(d, "timeout_seconds", 'type="number" required min="1" max="600" step="1"'))}
    ${row("proxy_url", "代理地址", "可选，仅用于此连接。支持 HTTP / HTTPS 代理。", input(d, "proxy_url", 'type="url" placeholder="http://127.0.0.1:7890"'))}
    ${supported ? row("use", embedding ? "选为嵌入模型" : "选为对话模型", embedding ? "保存后记录此选择。记忆向量检索尚未接入。" : "保存后用于新的对话请求；人格单独指定的模型仍优先。", `<label class="setting-toggle"><input id="setting-use" name="use" type="checkbox" ${d.use ? "checked" : ""}><span>使用此配置</span></label>`) : ""}
    <details class="request-parameters"><summary>高级请求参数（可选）</summary><p>仅在服务文档要求时填写 JSON。${embedding ? `如模型支持缩减维度，可通过 ${d.protocol === "dashscope" ? "dimension" : "dimensions"} 指定请求维度，然后重新检测实际结果。` : "例如 temperature。"}</p><textarea name="parametersText" aria-label="高级请求参数" rows="5" spellcheck="false">${e(d.parametersText)}</textarea></details>
    ${shared ? `<p class="shared-connection-note">此连接的地址、密钥、代理和超时也用于另外 ${shared} 条配置。需要独立连接时，请新增配置。</p>` : ""}
    <div id="connection-result" class="connection-result ${d.probeError ? "error" : ""}" role="status">${e(d.probeMessage || "")}</div><div id="connection-error" class="form-error" role="alert"></div>
    <footer class="connection-footer"><button type="button" class="btn small" data-discard>放弃修改</button>${existing ? `<button type="button" class="btn small danger" data-delete>${icon("trash")}删除此配置</button>` : ""}</footer>
    </div></form>`;
}
function capture(form, d) {
  const data = new FormData(form);
  for (const name of [
    "name",
    "template",
    "base_url",
    "api_key",
    "model",
    "timeout_seconds",
    "proxy_url",
    "dimensions",
    "parametersText",
  ])
    if (data.has(name)) d[name] = String(data.get(name));
  for (const name of ["enabled", "clear_key", "use"]) d[name] = data.has(name);
}
function markDirty(app, form, d) {
  capture(form, d);
  d.dirty = true;
  d.version++;
  d.probeMessage = "";
  d.probeError = false;
  form.querySelector("#draft-state").textContent = "有未保存的修改";
  form.querySelector("#connection-save").disabled = false;
  form.querySelector("#connection-result").textContent = "";
  form.querySelector("#connection-error").textContent = "";
}
function leaveDraft(app, action) {
  if (app.state.modelSaving) return;
  if (!app.state.modelDraft?.dirty) return action();
  app.dialog(
    "放弃未保存的修改？",
    "<p>当前配置尚未保存。放弃后再切换。</p>",
    async () => {
      setTimeout(action, 0);
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
  form.oninput = () => markDirty(app, form, d);
  form.querySelector("[name=template]").onchange = () => {
    const t = templates.find((t) => t.id === form.elements.template.value);
    if (!t) return;
    capture(form, d);
    d.protocol = t.protocol;
    d.base_url = t.base_url;
    d.api_key = "";
    d.dimensions = "";
    d.dirty = true;
    d.version++;
    d.probeMessage = "";
    app.render();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (app.state.modelSaving) return;
    capture(form, d);
    const button = form.querySelector("#connection-save");
    button.disabled = true;
    app.state.modelSaving = true;
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
    },
  };
}
export function configWithDraft(next, d) {
  const { provider, model } = payloadFor(d);
  next.revision = d.revision;
  const oldProvider = next.providers.find((p) => p.id === provider.id);
  provider.name = oldProvider?.name || d.name;
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
          `<button type="button" class="service-template" data-template="${t.id}"><span class="connection-logo ${t.id === "dashscope" ? "bailian" : ""}">${e(t.mark)}</span><strong>${e(t.label)}</strong><small>${t.protocol === "dashscope" ? "DashScope 原生嵌入接口" : "OpenAI 兼容接口"}</small>${icon("arrow")}</button>`,
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
