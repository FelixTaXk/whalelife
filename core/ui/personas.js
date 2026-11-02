import { api, escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";

export function renderPersonas(app) {
  const c = app.state.config;
  app.state.personaDrafts ||= {};
  const creating = app.state.personaSelection === "new";
  const p =
    c.personas.find((p) => p.id === app.state.personaSelection) ||
    c.personas.find((p) => p.id === c.activePersona) ||
    c.personas[0];
  const selected = creating ? "new" : p?.id;
  app.state.personaSelection = selected;
  const d = app.state.personaDrafts[selected];
  const current = c.personas.find((p) => p.id === c.activePersona);
  const models = c.models.filter(
    (m) =>
      m.type === "chat" &&
      (c.providers.find((p) => p.id === m.provider)?.protocol ?? "openai-compatible") === "openai-compatible" &&
      m.enabled &&
      !m.configuration_error &&
      c.providers.find((p) => p.id === m.provider)?.enabled,
  );
  return `<div class="page-heading"><div><h1>人格配置</h1><p>当前聊天人格：<strong>${e(current?.name || "未指定")}</strong></p></div><button class="btn primary" data-new-persona>${icon("plus")}新建人格</button></div><div class="persona-layout"><aside class="panel persona-list">${creating ? '<div class="connection-item active"><strong>新建人格 · 未保存</strong></div>' : ""}${c.personas.map((p) => `<button class="connection-item ${p.id === selected ? "active" : ""}" data-persona="${e(p.id)}"><span class="avatar">${e(p.name.slice(0, 1))}</span><span><strong>${e(p.name)}</strong><small>${p.id === c.activePersona ? "当前聊天人格" : "未启用"}</small></span></button>`).join("")}</aside><section class="panel persona-editor">${
    !selected
      ? '<div class="panel-body">点击“新建人格”开始。</div>'
      : !d
        ? `<div class="panel-body">${e(app.state.personaLoadError || "正在读取人格…")}<button class="btn small" data-reload-persona>重新读取</button></div>`
        : `
  <form id="persona-form"><div class="panel-header"><h2>${creating ? "新建人格" : e(d.name)}</h2><button type="button" class="btn small link" data-reload-persona>放弃修改</button></div>
  ${d.configRevision !== c.revision ? '<div class="configuration-warning">配置已有更新。请重新读取后再保存，当前输入尚未丢弃。</div>' : ""}
  <div class="persona-meta-fields"><label class="form-field"><span>人格名称</span><input name="name" required maxlength="100" placeholder="例如：写作助手" value="${e(d.name)}"></label><label class="form-field"><span>对话模型</span><select name="model"><option value="">跟随工作空间选择</option>${models.map((m) => `<option value="${e(m.id)}" ${m.id === d.model ? "selected" : ""}>${e(m.name)}</option>`).join("")}</select></label></div>
  <div class="persona-prompt-body"><label for="persona-prompt-text"><strong>人格内容</strong></label><p class="hint">具体写明身份、性格、回答方式和行为要求。这段内容会作为系统提示词发送给模型。</p><textarea id="persona-prompt-text" name="prompt" aria-label="人格内容" spellcheck="false" required placeholder="例如：你是一位严谨的写作助手。回答简洁，先给结论，再说明理由。">${e(d.prompt)}</textarea>
  <p class="form-error" id="persona-error" role="alert"></p><div class="persona-save-row row"><span class="muted" id="persona-save-state">${d.dirty ? "有未保存的修改" : selected === c.activePersona ? "已保存 · 当前聊天正在使用" : "已保存 · 尚未指定为聊天人格"}</span><div class="row"><button class="btn" type="submit" value="save">保存</button><button class="btn primary" type="submit" value="activate">${icon("check")}保存并启用</button></div></div><p class="hint persona-help">保存：保留配置。保存并启用：同时指定给聊天，保持当前会话不变。</p>${!creating && selected === c.activePersona ? '<button type="button" class="btn small tonal" data-test-persona>开始新会话测试</button>' : ""}</div></form>`
  }</section></div>`;
}
async function loadPersona(app, id) {
  if (app.state.personaLoading === id) return;
  app.state.personaLoading = id;
  app.state.personaLoadError = "";
  try {
    await app.load();
    const p = app.state.config.personas.find((p) => p.id === id);
    const file = await api("/api/persona?id=" + encodeURIComponent(id));
    app.state.personaDrafts[id] = {
      ...file,
      name: p.name,
      model: p.model || "",
      configRevision: app.state.config.revision,
      dirty: false,
    };
  } catch (error) {
    app.state.personaLoadError = error.message;
  } finally {
    app.state.personaLoading = null;
    if (app.state.page === "personas") app.render();
  }
}
export function bindPersonas(app) {
  const root = app.content;
  root.querySelector("[data-new-persona]").onclick = () => {
    app.state.personaDrafts.new ||= {
      name: "",
      model: "",
      prompt: "",
      configRevision: app.state.config.revision,
      dirty: true,
    };
    app.state.personaSelection = "new";
    app.render();
  };
  root.querySelectorAll("[data-persona]").forEach(
    (b) =>
      (b.onclick = () => {
        app.state.personaSelection = b.dataset.persona;
        app.render();
      }),
  );
  const id = app.state.personaSelection,
    d = app.state.personaDrafts[id];
  if (!id) return;
  root.querySelector("[data-reload-persona]")?.addEventListener("click", () => {
    const reload = () => {
      if (id === "new") {
        delete app.state.personaDrafts.new;
        app.state.personaSelection = app.state.config.activePersona;
        app.render();
      } else void loadPersona(app, id);
    };
    if (d?.dirty)
      app.dialog(
        "放弃当前修改？",
        "<p>重新读取已保存的人格配置。</p>",
        async () => {
          setTimeout(reload, 0);
        },
        "放弃修改",
      );
    else reload();
  });
  if (!d) {
    if (!app.state.personaLoadError) void loadPersona(app, id);
    return;
  }
  const form = root.querySelector("#persona-form");
  form.oninput = () => {
    d.name = form.elements.name.value;
    d.model = form.elements.model.value;
    d.prompt = form.elements.prompt.value;
    d.dirty = true;
    form.querySelector("#persona-save-state").textContent = "有未保存的修改";
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (app.state.personaSaving) return;
    const activate = event.submitter?.value === "activate";
    const errorBox = form.querySelector("#persona-error");
    if (activate && app.state.chatBusy) {
      errorBox.textContent = "请等待当前回复结束后切换人格。";
      return;
    }
    const payload = {
      id: id === "new" ? undefined : id,
      name: form.elements.name.value.trim(),
      model: form.elements.model.value || null,
      prompt: form.elements.prompt.value,
      revision: d.revision,
      configRevision: d.configRevision,
      activate,
    };
    app.state.personaSaving = true;
    const controls = [...form.elements];
    controls.forEach((el) => (el.disabled = true));
    try {
      const result = await api("/api/persona/config", payload);
      app.state.config = result.config;
      app.state.personaDrafts[result.persona.id] = {
        ...result.persona,
        model: result.persona.model || "",
        configRevision: result.config.revision,
        dirty: false,
      };
      if (id === "new") delete app.state.personaDrafts.new;
      app.state.personaSelection = result.persona.id;
      await app.refreshStatus();
      app.render();
      app.toast(
        activate
          ? `已启用「${result.persona.name}」，继续使用当前会话`
          : "人格已保存",
      );
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      app.state.personaSaving = false;
      controls.forEach((el) => (el.disabled = false));
    }
  };
  root.querySelector("[data-test-persona]")?.addEventListener("click", async () => {
    if (d.dirty) {
      app.toast("请先保存修改，再测试人格。", true);
      return;
    }
    if (app.state.chatBusy) {
      app.toast("请等待当前回复结束。", true);
      return;
    }
    await app.newSession();
    location.hash = "chat";
  });
}
