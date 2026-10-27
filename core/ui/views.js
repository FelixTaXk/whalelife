import { api, escapeHTML as e, typeNames } from "./api.js";
import { icon, whale } from "./icons.js";

const names = {
  logger: "日志服务",
  memory: "文件记忆",
  llm: "模型连接",
  tools: "工具管理",
  approval: "审批接口",
  channels: "渠道接口",
  permission: "权限管理",
  facts: "事实记忆",
  chat: "对话引擎",
  web: "Web 控制台",
};
const statusName = (status) =>
  ({
    active: "运行中",
    stopped: "已停用",
    failed: "加载失败",
    loading: "加载中",
  })[status] || status;
const typeIcon = (type) =>
  type === "embedding" ? "vector" : type === "chat" ? "chat" : "sliders";
const activeChat = (app) => {
  const persona = app.state.config.personas.find(
    (p) => p.id === app.state.status.persona,
  );
  return app.state.config.models.find(
    (m) => m.id === (persona?.model || app.state.config.bindings.chat),
  );
};
export function renderOverview(app) {
  const { status: s, config: c } = app.state;
  const chat = activeChat(app);
  const embed = c.models.find((m) => m.id === c.bindings.embedding);
  const active = s.plugins.filter((p) => p.status === "active").length;
  return `<div class="page-heading"><div><div class="eyebrow">YOUR LOCAL WORKSPACE</div><h1>欢迎回来</h1><p>鲸鲸已就绪。模型、记忆与插件，都在这里。</p></div><div class="heading-actions"><span class="badge green"><i class="status-dot"></i>核心运行中</span></div></div>
 <div class="stats-grid">${[
   ["模型配置", c.models.length + "", "个模型可按用途选择", "cube"],
   [
     "当前对话",
     chat?.name || "尚未选择",
     chat?.model || "前往使用配置选择模型",
     "chat",
   ],
   [
     "记忆会话",
     s.memory.files + "",
     formatBytes(s.memory.bytes) + " 已保存",
     "database",
   ],
   ["运行中的插件", active + "", s.plugins.length + " 个插件已加载", "puzzle"],
 ]
   .map(
     ([name, value, foot, ico]) =>
       `<div class="panel stat-card"><span class="stat-icon">${icon(ico)}</span><small>${name}</small><div class="stat-value ${name === "当前对话" ? "text" : ""}">${e(value)}</div><div class="stat-foot">${e(foot)}</div></div>`,
   )
   .join("")}</div>
 <div class="overview-grid"><div><section class="panel welcome-panel"><div class="eyebrow">HELLO, WHALELIFE</div><h2>让鲸鲸拥有适合自己的能力</h2><p>接入模型服务，为对话和向量检索分别选择模型，再到聊天页面试一试。</p><div class="row"><a href="#models" class="btn primary">${icon("plus")}管理模型</a><a href="#chat" class="btn">开始聊天 ${icon("arrow")}</a></div><span class="brand-mark">${whale}</span></section><section class="panel" style="margin-top:22px"><div class="panel-header"><h2>模型分工</h2><a class="btn link small" href="#bindings">调整配置 ${icon("arrow")}</a></div><div class="panel-body">${[
   ["chat", "对话模型", chat],
   ["embedding", "向量模型", embed],
 ]
   .map(
     ([type, label, m]) =>
       `<div class="service-line"><span class="square-icon">${icon(typeIcon(type))}</span><div><div class="label">${label}</div><small>${e(m?.name || "尚未配置")}</small></div><span class="badge ${m ? "green" : ""}">${m ? "已选择" : "待选择"}</span></div>`,
   )
   .join("")}</div></section></div>
 <section class="panel"><div class="panel-header"><h2>工作空间状态</h2><span class="badge">本地</span></div><div class="panel-body">${[
   ["grid", "核心服务", "WhaleLife · M0", "运行中"],
   ["database", "记忆存储", s.memory.files + " 个会话已归档", "已连接"],
   ["chat", "当前人格", s.personaName || s.persona, "已启用"],
   [
     "lock",
     "会话权限",
     { off: "工具已关闭", ask: "安全工具可直接执行", full: "工具可直接执行" }[
       s.permission
     ] || s.permission,
     "已配置",
   ],
 ]
   .map(
     ([ico, title, detail, state]) =>
       `<div class="service-line"><span class="square-icon">${icon(ico)}</span><div><div class="label">${title}</div><small>${e(detail)}</small></div><span class="badge green">${state}</span></div>`,
   )
   .join(
     "",
   )}<div class="hint" style="margin-top:22px">${icon("info")}<span>连接测试结果可在模型服务页面查看。使用配置只会切换之后发起的请求。</span></div></div></section></div>`;
}
function formatBytes(bytes) {
  return bytes < 1024
    ? bytes + " B"
    : bytes < 1048576
      ? (bytes / 1024).toFixed(1) + " KB"
      : (bytes / 1048576).toFixed(1) + " MB";
}

export function renderBindings(app) {
  const c = app.state.config;
  const options = (type, selected, inherit = false) =>
    `<option value="">${inherit ? "使用工作空间的对话模型" : "未配置"}</option>` +
    c.models
      .filter(
        (m) =>
          m.type === type &&
          m.enabled &&
          !m.configuration_error &&
          c.providers.find((p) => p.id === m.provider)?.enabled,
      )
      .map(
        (m) =>
          `<option value="${e(m.id)}" ${m.id === selected ? "selected" : ""}>${e(m.name)} · ${e(c.providers.find((p) => p.id === m.provider)?.name || m.provider)}</option>`,
      )
      .join("");
  const field = (type, description) =>
    `<div class="binding-row"><div class="row">${icon(typeIcon(type))}<h3>${typeNames[type]}模型</h3></div><select name="binding_${type}" aria-label="${typeNames[type]}模型">${options(type, c.bindings[type])}</select><p>${description}</p></div>`;
  return `<form id="bindings-form"><div class="page-heading"><div><div class="eyebrow">MODEL ROUTING</div><h1>使用配置</h1><p>明确选择每种能力使用的模型。未配置的用途保持关闭。</p></div><div class="heading-actions"><button type="submit" class="btn primary">${icon("check")}保存配置</button></div></div><div class="info-banner">${icon("info")}选择已启用的模型，保存后从下一次请求开始生效。</div><div class="bindings-grid"><section class="panel"><div class="panel-header"><h2>工作空间模型</h2><a href="#models" class="btn small link">管理模型 ${icon("arrow")}</a></div><div class="panel-body">${field("chat", "用于鲸鲸的日常对话和会话摘要。")}${field("embedding", "为后续记忆检索选择向量模型。当前支持配置与向量接口测试，检索接入将在后续开发。")}${field("rerank", "为后续检索结果排序预留，可暂时不配置。")}<details style="margin-top:20px"><summary class="muted">更多模型用途</summary><div style="margin-top:20px">${field("image", "图像生成服务的模型选择。")}${field("stt", "语音识别服务的模型选择。")}${field("tts", "语音合成服务的模型选择。")}<p class="hint" style="margin-top:16px">图像、语音与重排序目前仅保存选择，相应能力尚未接入。</p></div></details></div></section><section class="panel"><div class="panel-header"><h2>人格配置</h2></div><div class="panel-body"><p>人格名称、专用模型和人格内容已集中到人格配置页。</p><a href="#personas" class="btn tonal" style="margin-top:18px">编辑人格 ${icon("arrow")}</a></div></section></div><p id="bindings-error" class="form-error" role="alert"></p></form>`;
}
export function bindBindings(app) {
  const form = document.querySelector("#bindings-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    const next = app.configDraft();
    const data = new FormData(form);
    for (const key of ["chat", "embedding", "rerank", "image", "stt", "tts"])
      next.bindings[key] = data.get("binding_" + key) || null;
    try {
      await app.saveConfig(next);
    } catch (error) {
      document.querySelector("#bindings-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

export function renderPlugins(app) {
  const plugins = app.state.status.plugins.filter((p) => !p.builtin);
  return `<div class="page-heading"><div><h1>插件管理</h1><p>管理扩展插件，按需启停和重载。</p></div><span class="badge">${plugins.length} 个扩展插件</span></div><div class="plugin-grid">${plugins.map((p) => `<article class="panel plugin-card ${p.id.includes("/") ? "child" : ""}"><div class="row">${icon("puzzle")}<h3>${e(p.name || p.id)}</h3><div class="spacer"></div><span class="badge ${p.status === "active" ? "green" : p.status === "failed" ? "red" : ""}">${statusName(p.status)}</span></div><code>${e(p.id)} · v${e(p.version || "0.1.0")}</code><p class="${p.error ? "plugin-error" : ""}">${e(p.error || p.description || "扩展插件")}</p><footer><button class="btn small" data-plugin-id="${e(p.id)}" data-plugin-action="${p.status === "active" ? "stop" : "start"}">${p.status === "active" ? "停用" : "启用"}</button><button class="btn small tonal" data-plugin-id="${e(p.id)}" data-plugin-action="reload">${icon("refresh")}重载</button>${p.id.includes("/") ? '<small style="margin-left:auto">子插件</small>' : ""}</footer></article>`).join("")}</div>${plugins.length ? "" : '<div class="panel empty">尚未安装扩展插件</div>'}`;
}
export function bindPlugins(app) {
  document.querySelectorAll("[data-plugin-action]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api("/api/plugin", {
            id: b.dataset.pluginId,
            action: b.dataset.pluginAction,
          });
          await app.refreshStatus();
          app.render();
          app.toast("插件状态已更新");
        } catch (error) {
          app.toast(error.message, true);
        } finally {
          b.disabled = false;
        }
      }),
  );
}

export function renderChat(app) {
  const model = activeChat(app);
  const personaName = app.state.status.personaName || "助手";
  return `<div class="page-heading"><div><div class="eyebrow">PLAYGROUND</div><h1>和${e(personaName)}聊聊</h1><p>测试模型回复，也可以让鲸鲸记下一条事实。</p></div><div class="heading-actions"><button class="btn" id="new-session" ${app.state.chatBusy ? "disabled" : ""}>${icon("plus")}新会话</button></div></div><section class="panel chat-panel"><div class="chat-header"><span class="avatar">${e(personaName.slice(0, 1))}</span><div><h3>${e(app.state.status.personaName || "鲸鲸")}</h3><small>${e(model?.name || "请先选择对话模型")} <span>·</span> ${e(app.state.status.persona)}</small></div><div class="spacer"></div><a href="#bindings" class="btn small link">更换模型 ${icon("sliders")}</a></div><div id="messages" class="messages" aria-live="polite"></div><form id="chat-form" class="composer"><textarea id="chat-input" aria-label="聊天消息" placeholder="和${e(personaName)}说点什么…" rows="2"></textarea><div class="composer-footer"><small>Enter 发送 · Shift + Enter 换行</small><button id="send" class="btn primary small" type="submit" ${app.state.chatBusy || !app.chatConnected || !model ? "disabled" : ""}>${app.state.chatBusy ? "正在回复…" : "发送"} ${icon("send")}</button></div></form></section>`;
}
export function bindChat(app) {
  app.renderMessages();
  const input = document.querySelector("#chat-input");
  input.value = app.state.chatDraft || "";
  input.oninput = () => (app.state.chatDraft = input.value);
  input.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      document.querySelector("#chat-form").requestSubmit();
    }
  };
  document.querySelector("#chat-form").onsubmit = (event) => {
    event.preventDefault();
    app.sendMessage();
  };
  document.querySelector("#new-session").onclick = () => app.newSession();
}

export function renderLogs(app) {
  return `<div class="page-heading"><div><div class="eyebrow">OBSERVABILITY</div><h1>运行日志</h1><p>与启动窗口同源的实时日志，最近 1000 条。</p></div><div class="heading-actions"><span class="badge ${app.logConnected ? "green" : ""}"><i class="status-dot"></i>${app.logConnected ? "实时连接" : "等待连接"}</span></div></div><section class="panel panel-body"><div class="logs-toolbar"><div class="search-wrap">${icon("search")}<input type="search" id="log-search" aria-label="搜索日志" placeholder="搜索日志内容…" value="${e(app.state.logSearch || "")}"></div><select id="log-level" aria-label="日志级别">${[
    ["all", "所有级别"],
    ["INFO", "INFO"],
    ["WARN", "WARN"],
    ["ERROR", "ERROR"],
    ["DEBUG", "DEBUG"],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${(app.state.logLevel || "all") === value ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select><div class="spacer"></div><label class="checkbox-label" style="margin:0"><input type="checkbox" id="log-follow" ${app.state.logFollow ? "checked" : ""}>跟随最新</label><button id="log-export" class="btn small">${icon("download")}导出当前日志</button></div><div id="log-output" class="log-output" role="log" aria-label="实时日志"></div><div id="log-meta" class="log-meta"></div></section>`;
}
export function bindLogs(app) {
  const update = () => {
    app.state.logSearch = document.querySelector("#log-search").value;
    app.state.logLevel = document.querySelector("#log-level").value;
    app.state.logFollow = document.querySelector("#log-follow").checked;
    app.renderLogs();
  };
  document.querySelector("#log-search").oninput = update;
  document.querySelector("#log-level").onchange = update;
  document.querySelector("#log-follow").onchange = update;
  document.querySelector("#log-export").onclick = () => {
    const url = URL.createObjectURL(
      new Blob([app.filteredLogs().join("\n")], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "whalelife-logs.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  app.renderLogs();
}
