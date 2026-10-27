import { api, escapeHTML as e } from "./api.js";
const number = (value) => Number(value).toLocaleString();
export function renderContextMeter(value) {
  if (!value) return '<p class="muted">正在读取上下文统计…</p>';
  if (value.error) return `<p class="muted">${e(value.error)}</p>`;
  const limit = value.model.context_window,
    usage = value.usage;
  const percent = usage?.percent;
  return `<div class="context-meter"><div class="row"><strong>${e(value.model.name)} · 上下文上限 ${limit ? number(limit) + " tokens" : "未提供"}</strong><div class="spacer"></div><strong>${percent == null ? "暂无占用统计" : percent.toFixed(2) + "%"}</strong></div>${limit && usage ? `<progress max="100" value="${Math.min(100, percent)}" aria-label="上下文实际占用">${percent.toFixed(2)}%</progress>` : ""}<p>${usage ? `最近请求：输入 ${number(usage.input_tokens)} + 输出 ${number(usage.output_tokens)} = ${number(usage.used_tokens)} tokens · ${e(new Date(usage.measured_at).toLocaleString())}${usage.settings_changed ? "；上下文设置已变更，下轮请求后更新统计。" : ""}` : "尚无此模型和人格的实测记录；下一次对话后显示服务返回的 token 用量。"}${!limit ? ' <a href="#models">填写模型上下文上限</a>' : ""}</p></div>`;
}
export function renderContextPanel(app) {
  const s = app.state,
    current = s.sessionContext;
  const items = s.memoryCatalog?.sessions.items || [];
  const choices = [
    { id: s.session, name: current?.name || s.session },
    ...items.filter((x) => x.id !== s.session),
  ];
  const p = current?.policy;
  return `<section class="panel panel-body session-context-panel"><div class="row"><h2>当前会话上下文</h2><div class="spacer"></div><a href="#chat" class="btn small">继续聊天</a></div><div class="context-session-select"><label for="context-session">当前会话</label><select id="context-session" ${s.chatBusy ? "disabled" : ""}>${choices.map((item) => `<option value="${e(item.id)}">${e(item.name || item.id)}</option>`).join("")}</select><small>也可在会话档案中选择任意会话继续。</small></div>${renderContextMeter(current)}${p ? `<form id="context-form"><div class="context-fields"><label>带入的历史消息数<input name="recent_lines" type="number" required min="0" max="1000" value="${p.recent_lines}"></label><label>历史上下文预算（估算 token）<input name="budget_tokens" type="number" required min="100" max="10000000" value="${p.budget_tokens}"></label><label>历史范围<select name="history_scope"><option value="persona" ${p.history_scope === "persona" ? "selected" : ""}>仅当前人格版本</option><option value="session" ${p.history_scope === "session" ? "selected" : ""}>此会话全部历史（含旧人格）</option></select></label></div><div class="row context-options"><label><input type="checkbox" name="include_facts" ${p.include_facts ? "checked" : ""}>带入共享事实</label><label><input type="checkbox" name="include_summary" ${p.include_summary ? "checked" : ""}>带入滚动摘要</label><div class="spacer"></div><button class="btn primary small" type="submit" ${s.chatBusy ? "disabled" : ""}>保存当前会话设置</button></div><p class="muted">当前范围内有 ${current.available_messages} 条历史消息（档案共 ${current.stored_messages} 条）。预算控制历史内容的裁剪，模型的实际占用以上方请求统计为准。修改后下轮生效。</p><p class="form-error" id="context-error" role="alert"></p></form>` : ""}</section>`;
}
export function bindContextSettings(app, reload) {
  const select = app.content.querySelector("#context-session");
  if (select)
    select.onchange = async () => {
      try {
        await app.useSession(select.value);
        await reload();
      } catch (error) {
        app.toast(error.message, true);
      }
    };
  const form = app.content.querySelector("#context-form");
  if (form)
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      const data = new FormData(form);
      try {
        app.state.sessionContext = await api("/api/session/context", {
          id: app.state.session,
          context: {
            recent_lines: Number(data.get("recent_lines")),
            budget_tokens: Number(data.get("budget_tokens")),
            include_facts: data.has("include_facts"),
            include_summary: data.has("include_summary"),
            history_scope: data.get("history_scope"),
          },
        });
        await reload();
        app.toast("当前会话上下文已保存，下轮生效");
      } catch (error) {
        form.querySelector("#context-error").textContent = error.message;
        button.disabled = false;
      }
    };
}
