import { api, escapeHTML as e, viewedSession, sessionName } from "./api.js";
const number = (value) => Number(value).toLocaleString();
export function renderContextMeter(value, compact = false) {
  if (compact) {
    const usage = value?.usage,
      limit = value?.model?.context_window;
    const label = !value
      ? "正在读取上下文…"
      : value.error
        ? value.error
        : `上下文 ${usage ? number(usage.used_tokens) : "未统计"} / ${limit ? number(limit) : "上限未提供"} tokens${usage?.percent == null ? "" : ` · ${usage.percent.toFixed(2)}%`}${usage?.settings_changed ? " · 设置已变更" : ""}`;
    const detail = usage
      ? `最近请求：输入 ${number(usage.input_tokens)} + 输出 ${number(usage.output_tokens)} tokens；${new Date(usage.measured_at).toLocaleString()}`
      : "下一次对话后显示服务返回的用量；详细统计见记忆管理。";
    return `<div class="chat-context-compact"><span title="${e(detail)}">${e(label)}</span><a href="#memory">会话与上下文设置</a></div>`;
  }
  if (!value) return '<p class="muted">正在读取上下文统计…</p>';
  if (value.error) return `<p class="muted">${e(value.error)}</p>`;
  const limit = value.model.context_window,
    usage = value.usage;
  const percent = usage?.percent;
  return `<div class="context-meter"><div class="row"><strong>${e(value.model.name)} · 上下文上限 ${limit ? number(limit) + " tokens" : "未提供"}</strong><div class="spacer"></div><strong>${percent == null ? "暂无占用统计" : percent.toFixed(2) + "%"}</strong></div>${limit && usage ? `<progress max="100" value="${Math.min(100, percent)}" aria-label="上下文实际占用">${percent.toFixed(2)}%</progress>` : ""}<p>${usage ? `最近请求：输入 ${number(usage.input_tokens)} + 输出 ${number(usage.output_tokens)} = ${number(usage.used_tokens)} tokens · ${e(new Date(usage.measured_at).toLocaleString())}${usage.settings_changed ? "；上下文设置已变更，下轮请求后更新统计。" : ""}` : "尚无此模型和人格的实测记录；下一次对话后显示服务返回的 token 用量。"}${!limit ? ' <a href="#models">填写模型上下文上限</a>' : ""}</p></div>`;
}
export function renderContextPanel(app) {
  const s = app.state,
    current = s.memoryContext;
  const selected = viewedSession(s);
  const items = s.sessions?.length ? s.sessions : s.memoryCatalog?.sessions?.items || [];
  const choices = [
    { id: selected, name: current?.name || sessionName(s, selected) },
    ...items.filter((x) => x.id !== selected),
  ];
  const p = current?.policy,
    window = current?.memory_window,
    days = p?.short_term_days ?? 7,
    minimum = p?.short_term_min_messages ?? 100;
  return `<section class="panel panel-body session-context-panel"><div class="row"><h2>所选档案的上下文</h2><div class="spacer"></div><a href="#bindings" class="btn small">切换使用的会话</a></div><div class="context-session-select"><label for="context-session">查看会话档案</label><select id="context-session">${choices.map((item) => `<option value="${e(item.id)}" ${item.id === selected ? "selected" : ""}>${e(item.name || item.id)}${item.id === s.session ? "（正在使用）" : ""}</option>`).join("")}</select><small>仅切换查看的档案，不改变当前使用的会话。</small></div>${renderContextMeter(current)}${p ? `<form id="context-form"><div class="context-session-select"><label for="context-history-scope">历史范围</label><select id="context-history-scope" name="history_scope"><option value="persona" ${p.history_scope === "persona" ? "selected" : ""}>仅当前人格版本</option><option value="session" ${p.history_scope === "session" ? "selected" : ""}>此会话全部历史（含旧人格）</option></select></div><div class="context-fields"><label>短期时间窗口（天）<input name="short_term_days" type="number" required min="1" max="3650" step="1" value="${e(days)}"></label><label>短期至少保留消息数<input name="short_term_min_messages" type="number" required min="1" max="10000" step="1" value="${e(minimum)}"></label><label>历史上下文预算（估算 token）<input name="budget_tokens" type="number" required min="100" max="10000000" step="1" value="${e(p.budget_tokens)}"></label></div><div class="row context-options"><label><input type="checkbox" name="history_enabled" ${(p.history_enabled ?? p.recent_lines !== 0) ? "checked" : ""}>带入历史消息</label><label><input type="checkbox" name="include_summary" ${p.include_summary ? "checked" : ""}>启用短期压缩摘要</label><label><input type="checkbox" name="long_term_enabled" ${(p.long_term_enabled ?? p.include_summary !== false) ? "checked" : ""}>启用长期认知整理</label><label><input type="checkbox" name="include_facts" ${p.include_facts ? "checked" : ""}>带入共享事实</label><div class="spacer"></div><button class="btn primary small" type="submit" ${s.chatBusy ? "disabled" : ""}>保存所选档案设置</button></div><p class="muted">仅同时满足“早于 ${e(days)} 天”且“超出最近 ${e(minimum)} 条”的消息进入长期范围；${e(minimum)} 条是保底，不是上限。历史预算仅裁剪带入内容，不改变长期归类。修改后下轮生效。</p><p class="muted">当前范围内有 ${e(current.available_messages)} 条历史消息（档案共 ${e(current.stored_messages)} 条）。${window ? `短期 ${e(window.short_term_messages)} 条 · 长期 ${e(window.long_term_messages)} 条；现存短期摘要 ${e(window.short_summary_chars)} 字符 · 长期概览 ${e(window.long_summary_chars)} 字符。` : ""}</p><details><summary>短期压缩与长期整理如何工作</summary><p class="muted">默认 7 天、至少 100 条：一个月仅 20 条时全部仍属短期；一天 300 条也全部属短期。历史预算不足时才在回复前压缩短期内容，摘要最多 200 字符，不生成认知。长期范围累计至少 10 条未处理消息后，可在回复后生成最多 200 字符的概览及最多 2 条认知，每条最多 80 字符。每轮最多一次整理调用，短期压缩优先；两类整理共用每日记忆预算，不在空闲时循环运行。关闭长期整理只停止后续提炼，已有记忆仍可召回；带入历史时仍可使用已有长期概览。</p></details><p class="form-error" id="context-error" role="alert"></p></form>` : ""}</section>`;
}
export function bindContextSettings(app, reload) {
  const select = app.content.querySelector("#context-session");
  if (select)
    select.onchange = async () => {
      try {
        app.state.memorySession = select.value;
        app.state.memoryContext = null;
        await reload();
      } catch (error) {
        app.toast(error.message, true);
      }
    };
  const form = app.content.querySelector("#context-form");
  const loaded = app.state.memoryLoadedSession;
  if (form)
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      const data = new FormData(form);
      try {
        if (loaded !== viewedSession(app.state)) throw Error("正在查看的档案已改变，请重新读取后操作");
        const value = await api("/api/session/context", {
          id: loaded,
          context: {
            history_enabled: data.has("history_enabled"),
            short_term_days: Number(data.get("short_term_days")),
            short_term_min_messages: Number(data.get("short_term_min_messages")),
            budget_tokens: Number(data.get("budget_tokens")),
            include_facts: data.has("include_facts"),
            include_summary: data.has("include_summary"),
            long_term_enabled: data.has("long_term_enabled"),
            history_scope: data.get("history_scope"),
          },
        });
        if (loaded === viewedSession(app.state)) app.state.memoryContext = value;
        if (loaded === app.state.session) app.state.sessionContext = value;
        await reload();
        app.toast("所选档案的上下文已保存，该会话下轮生效");
      } catch (error) {
        form.querySelector("#context-error").textContent = error.message;
        button.disabled = false;
      }
    };
}
