import { api, escapeHTML as e, typeNames, uid } from "./api.js";
import { icon } from "./icons.js";

const typeIcon = (type) =>
  type === "embedding" ? "vector" : type === "chat" ? "chat" : "sliders";
const types = [
  ["all", "全部模型", "cube"],
  ["chat", "对话", "chat"],
  ["embedding", "向量 / Embedding", "vector"],
  ["rerank", "重排序", "sliders"],
  ["other", "其他", "bolt"],
];
const matches = (model, filter) =>
  filter === "all" ||
  model.type === filter ||
  (filter === "other" && !["chat", "embedding", "rerank"].includes(model.type));
const providerName = (provider) => provider.name || provider.id;
function host(base) {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

export function renderModels(app) {
  const config = app.state.config;
  const filter = app.state.modelFilter || "all";
  if (!config.providers.some((p) => p.id === app.state.provider))
    app.state.provider = config.providers[0]?.id;
  const selected = config.providers.find((p) => p.id === app.state.provider);
  const query = (app.state.modelSearch || "").toLowerCase();
  const models = config.models.filter(
    (m) =>
      m.provider === selected?.id &&
      matches(m, filter) &&
      (m.name + " " + m.model).toLowerCase().includes(query),
  );
  return `<div class="page-heading"><div><div class="eyebrow">MODELS & PROVIDERS</div><h1>模型服务</h1><p>连接不同的模型服务，为对话和向量检索准备合适的模型。</p></div><div class="heading-actions"><button class="btn primary" data-action="add-provider">${icon("plus")}新增提供商</button></div></div>
    <div class="tabs" role="tablist" aria-label="模型用途">${types.map(([id, label, ico]) => `<button class="tab ${filter === id ? "active" : ""}" role="tab" aria-selected="${filter === id}" data-filter="${id}">${icon(ico)}${label}<span class="count">${config.models.filter((m) => matches(m, id)).length}</span></button>`).join("")}</div>
    <div class="panel model-workbench"><aside class="provider-list" aria-label="提供商列表"><div class="section-label">模型提供商 <span class="count">${config.providers.length}</span></div>${config.providers.map((p) => `<button class="provider-item ${p.id === selected?.id ? "active" : ""}" data-provider="${e(p.id)}" aria-pressed="${p.id === selected?.id}"><span class="provider-logo">${e(providerName(p).slice(0, 1).toUpperCase())}</span><span class="provider-text"><strong>${e(providerName(p))}</strong><small>${config.models.filter((m) => m.provider === p.id).length} 个模型 · ${p.enabled ? "已启用" : "已停用"}</small></span>${icon("chevron")}</button>`).join("")}<div class="provider-note">同一连接可以添加多个模型。<br>密钥只保存在本机配置中。</div></aside>
    <div class="provider-detail">${
      selected
        ? `<div class="provider-header"><div class="provider-title"><span class="provider-logo">${e(providerName(selected).slice(0, 1).toUpperCase())}</span><div><h2>${e(providerName(selected))}</h2><small>OpenAI 兼容服务</small></div></div><div class="row"><button class="btn small" data-action="edit-provider">${icon("edit")}编辑连接</button><button class="icon-btn" data-action="delete-provider" aria-label="删除提供商" title="删除提供商">${icon("trash")}</button></div></div>
      <div class="connection-meta"><div><small>API 地址</small><p>${e(selected.base_url)}</p></div><div><small>访问凭据</small><span class="badge ${selected.has_key ? "green" : ""}">${icon("lock")}${selected.has_key ? "已保存密钥" : "未设置密钥"}</span></div></div>
      <div class="model-toolbar"><span class="section-label">已配置模型 <span class="count">${models.length}</span></span><div class="spacer"></div><div class="search-wrap">${icon("search")}<input type="search" id="model-search" aria-label="搜索模型" placeholder="搜索模型…" value="${e(app.state.modelSearch || "")}"></div><button class="btn small" data-action="fetch-models">${icon("download")}获取模型</button><button class="btn small tonal" data-action="add-model">${icon("plus")}添加模型</button></div>
      <div class="model-grid">${models.map((m) => modelCard(app, m)).join("")}</div>${!models.length ? `<div class="empty"><span class="empty-icon">${icon(typeIcon(filter))}</span><h3>${query ? "没有匹配的模型" : filter === "embedding" ? "还没有向量模型" : "还没有此类模型"}</h3><p>${query ? "试试其他模型名称。" : "添加模型后，可在「使用配置」中选择它的用途。"}</p>${!query ? '<button class="btn tonal" data-action="add-model">添加模型</button>' : ""}</div>` : ""}
      <div class="hint model-hint">${icon("info")}<span>模型 ID 由服务提供方确定。对话与向量模型可分别测试；新增模型不会自动替换当前选择。</span></div>`
        : `<div class="empty"><span class="empty-icon">${icon("cube")}</span><h3>连接你的第一个模型服务</h3><p>填写服务地址和访问凭据，再添加你想使用的模型。</p><button class="btn primary" data-action="add-provider">新增提供商</button></div>`
    }</div></div>`;
}

function modelCard(app, model) {
  const selected = Object.entries(app.state.config.bindings)
    .filter(([, id]) => id === model.id)
    .map(([type]) => typeNames[type]);
  const probe = app.state.probes[model.id];
  return `<article class="model-card"><div class="card-head"><span class="type-icon">${icon(typeIcon(model.type))}</span><h3>${e(model.name || model.model)}</h3><div class="spacer"></div><span class="status-dot" style="${model.enabled ? "" : "background:#b9bdc8"}" title="${model.enabled ? "已启用" : "已停用"}"></span></div><code>${e(model.model)}</code><div class="row"><span class="badge purple">${typeNames[model.type] || "其他"}</span>${selected.length ? `<span class="badge green">当前选择</span>` : ""}${!model.enabled ? '<span class="badge">已停用</span>' : ""}</div><div class="card-foot"><button class="btn small link" data-test="${e(model.id)}" ${!model.enabled ? "disabled" : ""}>${icon("bolt")}测试连接</button><div class="spacer"></div><button class="icon-btn" data-edit-model="${e(model.id)}" aria-label="编辑模型 ${e(model.name)}">${icon("edit")}</button><button class="icon-btn" data-delete-model="${e(model.id)}" aria-label="删除模型 ${e(model.name)}">${icon("trash")}</button></div><div class="probe-result ${probe?.error ? "error" : ""}" data-probe="${e(model.id)}">${probe ? e(probe.message) : "尚未测试"}</div></article>`;
}

export function bindModels(app) {
  const root = app.content;
  root.querySelectorAll("[data-filter]").forEach(
    (button) =>
      (button.onclick = () => {
        app.state.modelFilter = button.dataset.filter;
        app.render();
      }),
  );
  root.querySelectorAll("[data-provider]").forEach(
    (button) =>
      (button.onclick = () => {
        app.state.provider = button.dataset.provider;
        app.render();
      }),
  );
  const search = root.querySelector("#model-search");
  if (search)
    search.oninput = () => {
      const cursor = search.selectionStart;
      app.state.modelSearch = search.value;
      app.render();
      const next = root.querySelector("#model-search");
      next.focus();
      next.setSelectionRange(cursor, cursor);
    };
  root.querySelectorAll("[data-action]").forEach(
    (button) =>
      (button.onclick = () => {
        const action = button.dataset.action;
        if (action === "add-provider") providerDialog(app);
        if (action === "edit-provider")
          providerDialog(
            app,
            app.state.config.providers.find((p) => p.id === app.state.provider),
          );
        if (action === "add-model") modelDialog(app);
        if (action === "fetch-models") fetchModels(app, button);
        if (action === "delete-provider") deleteProvider(app);
      }),
  );
  root.querySelectorAll("[data-edit-model]").forEach(
    (button) =>
      (button.onclick = () =>
        modelDialog(
          app,
          app.state.config.models.find(
            (m) => m.id === button.dataset.editModel,
          ),
        )),
  );
  root
    .querySelectorAll("[data-delete-model]")
    .forEach(
      (button) =>
        (button.onclick = () => deleteModel(app, button.dataset.deleteModel)),
    );
  root
    .querySelectorAll("[data-test]")
    .forEach(
      (button) =>
        (button.onclick = () => testModel(app, button.dataset.test, button)),
    );
}

function providerDialog(app, provider) {
  const current = provider || {
    name: "",
    base_url: "",
    enabled: true,
    protocol: "openai-compatible",
  };
  app.dialog(
    provider ? "编辑模型连接" : "新增提供商",
    `
    <label class="form-field"><span>提供商名称</span><input name="name" required maxlength="100" placeholder="例如：DeepSeek、我的本地服务" value="${e(current.name)}"></label>
    <label class="form-field"><span>API 地址</span><input name="base_url" type="url" required placeholder="https://api.example.com/v1" value="${e(current.base_url)}"><small>填写 OpenAI 兼容的 API 根地址，包含服务要求的 /v1 等前缀。</small></label>
    <label class="form-field"><span>API 密钥 ${current.has_key ? '<span class="badge green">已保存</span>' : ""}</span><input name="api_key" type="password" autocomplete="new-password" placeholder="${current.has_key ? "留空保留原密钥" : "无密钥的本地服务可留空"}"><small>密钥不会从服务器回传。更换服务地址时，请重新填写密钥或明确清除。</small></label>
    ${current.has_key ? '<label class="checkbox-label"><input type="checkbox" name="clear_key">清除已保存的密钥</label>' : ""}
    <label class="checkbox-label"><input type="checkbox" name="enabled" ${current.enabled ? "checked" : ""}>启用此连接</label>`,
    async (form) => {
      const next = app.configDraft();
      const entry = {
        id: provider?.id || uid("provider"),
        name: form.get("name").trim(),
        base_url: form.get("base_url").trim(),
        protocol: "openai-compatible",
        enabled: form.has("enabled"),
        api_key: form.get("api_key"),
        clear_key: form.has("clear_key"),
      };
      if (provider)
        next.providers = next.providers.map((p) =>
          p.id === provider.id ? entry : p,
        );
      else next.providers.push(entry);
      await app.saveConfig(next);
      app.state.provider = entry.id;
      app.render();
    },
    "保存连接",
  );
}

export function modelDialog(app, model, remoteModel) {
  const current = model || {
    name: remoteModel || "",
    model: remoteModel || "",
    type: ["chat", "embedding", "rerank"].includes(app.state.modelFilter)
      ? app.state.modelFilter
      : "chat",
    provider: app.state.provider,
    enabled: true,
    parameters: {},
  };
  app.dialog(
    model ? "编辑模型" : "添加模型",
    `
    <label class="form-field"><span>显示名称</span><input name="name" required maxlength="100" placeholder="给模型起一个容易识别的名字" value="${e(current.name)}"></label>
    <label class="form-field"><span>模型 ID</span><input name="model" required maxlength="200" placeholder="服务提供方的模型名称" value="${e(current.model)}"><small>例如 deepseek-chat、text-embedding-3-small；以你所连接的服务为准。</small></label>
    <div class="form-row"><label class="form-field"><span>模型用途</span><select name="type">${Object.entries(
      typeNames,
    )
      .map(
        ([id, name]) =>
          `<option value="${id}" ${current.type === id ? "selected" : ""}>${name}</option>`,
      )
      .join(
        "",
      )}</select></label><label class="form-field"><span>所属提供商</span><select name="provider">${app.state.config.providers.map((p) => `<option value="${e(p.id)}" ${current.provider === p.id ? "selected" : ""}>${e(providerName(p))}</option>`).join("")}</select></label></div>
    <label class="checkbox-label"><input type="checkbox" name="enabled" ${current.enabled ? "checked" : ""}>启用此模型</label>
    <details><summary>高级请求参数</summary><label class="form-field"><textarea name="parameters" rows="5" aria-label="高级请求参数 JSON" spellcheck="false">${e(JSON.stringify(current.parameters || {}, null, 2))}</textarea><small>可填写服务支持的参数，例如 temperature、max_tokens 或 dimensions。连接凭据与模型选择由上面的字段管理。</small></label></details>`,
    async (form) => {
      let parameters;
      try {
        parameters = JSON.parse(form.get("parameters") || "{}");
      } catch {
        throw Error("高级请求参数需要是有效的 JSON 对象");
      }
      const next = app.configDraft();
      const entry = {
        id: model?.id || uid("model"),
        name: form.get("name").trim(),
        model: form.get("model").trim(),
        type: form.get("type"),
        provider: form.get("provider"),
        enabled: form.has("enabled"),
        parameters,
      };
      if (model)
        next.models = next.models.map((m) => (m.id === model.id ? entry : m));
      else next.models.push(entry);
      await app.saveConfig(next);
      app.state.provider = entry.provider;
      app.state.modelFilter = entry.type;
      app.render();
    },
    "保存模型",
  );
}

function deleteProvider(app) {
  const provider = app.state.config.providers.find(
    (p) => p.id === app.state.provider,
  );
  const count = app.state.config.models.filter(
    (m) => m.provider === provider.id,
  ).length;
  app.dialog(
    "删除提供商",
    `<p>删除「${e(providerName(provider))}」的连接配置。</p><p class="hint" style="margin-top:10px">${count ? "这个连接下还有 " + count + " 个模型，请先删除或转移这些模型。" : "此操作不会删除提供商账户或远程模型。"}</p>`,
    async () => {
      const next = app.configDraft();
      next.providers = next.providers.filter((p) => p.id !== provider.id);
      await app.saveConfig(next);
    },
    "删除连接",
    true,
  );
}
function deleteModel(app, id) {
  const model = app.state.config.models.find((m) => m.id === id);
  app.dialog(
    "删除模型配置",
    `<p>删除「${e(model.name)}」的配置？</p><p class="hint" style="margin-top:10px">如果模型正在使用，请先到「使用配置」切换选择。</p>`,
    async () => {
      const next = app.configDraft();
      next.models = next.models.filter((m) => m.id !== id);
      await app.saveConfig(next);
    },
    "删除模型",
    true,
  );
}
async function fetchModels(app, button) {
  const providerId = app.state.provider;
  button.disabled = true;
  try {
    const result = await api("/api/model-config/models", {
      providerId,
    });
    if (app.state.provider !== providerId || app.state.page !== "models")
      return;
    app.dialog(
      "从服务中选择模型",
      `<p class="hint" style="margin-bottom:15px">选择一个模型，然后确认它的用途。${result.models.length ? "" : "该服务未返回可用模型，你仍可手动添加。"}</p><div>${result.models.map((id, index) => `<button type="button" class="select-model-item" data-remote-model="${index}">${e(id)}</button>`).join("")}</div>`,
      null,
    );
    document.querySelectorAll("[data-remote-model]").forEach(
      (b) =>
        (b.onclick = () => {
          const name = result.models[Number(b.dataset.remoteModel)];
          app.closeDialog();
          modelDialog(app, undefined, name);
        }),
    );
  } catch (error) {
    app.toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}
async function testModel(app, id, button) {
  const revision = app.state.config.revision;
  button.disabled = true;
  const output = app.content.querySelector(`[data-probe="${CSS.escape(id)}"]`);
  if (output) output.textContent = "正在连接…";
  try {
    const result = await api("/api/model-config/test", { modelId: id });
    if (app.state.config.revision !== revision) return;
    app.state.probes[id] = {
      message: `${result.message} · ${result.latency_ms} ms${result.dimensions ? " · " + result.dimensions + " 维" : ""}`,
    };
  } catch (error) {
    if (app.state.config.revision === revision)
      app.state.probes[id] = { message: error.message, error: true };
  } finally {
    if (app.state.page === "models") app.render();
  }
}
