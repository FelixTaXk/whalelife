import { api, escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";

export function renderPersonas(app) {
  const config = app.state.config;
  const people = config.personas;
  const selected =
    people.find((p) => p.id === app.state.personaSelection) || people[0];
  app.state.personaSelection = selected?.id;
  app.state.personaDrafts ||= {};
  const d = selected && app.state.personaDrafts[selected.id];
  if (d && !d.metaDirty)
    Object.assign(d, {
      name: selected.name,
      model: selected.model || "",
      configRevision: config.revision,
    });
  const models = config.models.filter(
    (m) =>
      m.type === "chat" &&
      m.enabled &&
      !m.configuration_error &&
      config.providers.find((p) => p.id === m.provider)?.enabled,
  );
  return `<div class="page-heading"><div><h1>人格配置</h1><p>编辑人格内容，保存后从下一轮对话生效。</p></div></div><div class="persona-layout"><aside class="panel persona-list">${people.map((p) => `<button class="connection-item ${p.id === selected?.id ? "active" : ""}" data-persona="${e(p.id)}"><span class="avatar">${e(p.name.slice(0, 1))}</span><span><strong>${e(p.name)}</strong><small>${p.id === app.state.status.persona ? "当前 Web 人格" : e(p.id)}</small></span></button>`).join("")}</aside><section class="panel persona-editor">${
    !selected
      ? "<p>尚未配置人格。</p>"
      : !d
        ? `<p>${e(app.state.personaLoadError || "正在读取人格内容…")}</p>${app.state.personaLoadError ? '<button class="btn" data-retry-persona>重试</button>' : ""}`
        : `
  <form id="persona-meta"><div class="panel-header"><h2>基本设置</h2><button class="btn small" type="submit">保存基本设置</button></div><div class="persona-meta-fields"><label class="form-field"><span>人格名称</span><input name="name" required maxlength="100" value="${e(d.name)}"></label><label class="form-field"><span>对话模型</span><select name="model"><option value="">跟随工作空间选择</option>${models.map((m) => `<option value="${e(m.id)}" ${d.model === m.id ? "selected" : ""}>${e(m.name)}</option>`).join("")}</select></label></div><p class="form-error" id="persona-meta-error" role="alert"></p></form>
  <form id="persona-prompt"><div class="panel-header"><div><h2>人格内容</h2><small>描述身份、性格、说话方式和行为要求；支持 Markdown。</small></div><button type="button" class="btn small link" data-reload-persona>重新读取</button></div><div class="persona-prompt-body"><textarea name="prompt" aria-label="人格内容" spellcheck="false" required>${e(d.prompt)}</textarea><div class="row persona-save-row"><span class="muted" id="persona-save-state">${d.dirty ? "有未保存的修改" : "已读取保存内容"}</span><button class="btn primary" type="submit">${icon("check")}保存人格内容</button></div><p class="form-error" id="persona-prompt-error" role="alert"></p></div></form>`
  }</section></div>`;
}
async function loadPersona(app, id) {
  if (app.state.personaLoading === id) return;
  app.state.personaLoading = id;
  app.state.personaLoadError = "";
  try {
    const data = await api("/api/persona?id=" + encodeURIComponent(id));
    app.state.personaDrafts[id] = { ...data, dirty: false, metaDirty: false };
  } catch (error) {
    app.state.personaLoadError = error.message;
  } finally {
    app.state.personaLoading = null;
    if (app.state.page === "personas") app.render();
  }
}
export function bindPersonas(app) {
  const root = app.content;
  root.querySelectorAll("[data-persona]").forEach(
    (b) =>
      (b.onclick = () => {
        app.state.personaSelection = b.dataset.persona;
        app.render();
      }),
  );
  const id = app.state.personaSelection;
  if (!id) return;
  const d = app.state.personaDrafts[id];
  root
    .querySelector("[data-retry-persona]")
    ?.addEventListener("click", () => loadPersona(app, id));
  if (!d) {
    if (!app.state.personaLoadError) void loadPersona(app, id);
    return;
  }
  const meta = root.querySelector("#persona-meta");
  meta.oninput = () => {
    d.name = meta.elements.name.value;
    d.model = meta.elements.model.value;
    d.metaDirty = true;
  };
  meta.onsubmit = async (event) => {
    event.preventDefault();
    const button = meta.querySelector("[type=submit]");
    button.disabled = true;
    const next = app.configDraft();
    next.revision = d.configRevision;
    next.personaNames = { [id]: meta.elements.name.value.trim() };
    next.personaModels[id] = meta.elements.model.value || null;
    try {
      await app.saveConfig(next);
      d.metaDirty = false;
      app.render();
    } catch (error) {
      meta.querySelector("#persona-meta-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  const form = root.querySelector("#persona-prompt");
  form.oninput = () => {
    d.prompt = form.elements.prompt.value;
    d.dirty = true;
    form.querySelector("#persona-save-state").textContent = "有未保存的修改";
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    const sent = form.elements.prompt.value;
    try {
      const result = await api("/api/persona", {
        id,
        prompt: sent,
        revision: d.revision,
      });
      d.revision = result.revision;
      d.dirty = d.prompt !== sent;
      form.querySelector("#persona-save-state").textContent = d.dirty
        ? "有未保存的修改"
        : "已保存，下轮对话生效";
      form.querySelector("#persona-prompt-error").textContent = "";
      app.toast("人格内容已保存");
    } catch (error) {
      form.querySelector("#persona-prompt-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  root.querySelector("[data-reload-persona]").onclick = () => {
    const reload = () => loadPersona(app, id);
    if (d.dirty || d.metaDirty)
      app.dialog(
        "重新读取人格？",
        "<p>这会放弃当前人格尚未保存的修改。</p>",
        async () => {
          setTimeout(reload, 0);
        },
        "放弃并重新读取",
      );
    else reload();
  };
}
