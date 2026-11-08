/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e, viewedSession, sessionName } from "./api.js";
const number = (value) => Number(value).toLocaleString();
const modeOf = (policy = {}) => policy.memory_mode ||
  (["short_term_days", "short_term_min_messages", "budget_tokens", "recent_lines", "include_summary", "long_term_enabled"].some(key => policy[key] !== undefined) ? "legacy" : "full");
const percentage = (value, limit) => limit > 0 && Number.isFinite(value) ? value.toFixed(2) + "%" : null;
export function renderContextMeter(value, compact = false) {
  const usage = value?.usage, estimate = value?.context_estimate,
    limit = value?.model?.context_window,
    percent = percentage(estimate ? estimate.percent : usage?.percent, limit),
    source = estimate ? "当前估算" : "最近实测";
  const measured = usage
    ? `最近请求实测：输入 ${number(usage.input_tokens)} + 输出 ${number(usage.output_tokens)} = ${number(usage.used_tokens)} tokens；${new Date(usage.measured_at).toLocaleString()}${usage.settings_changed ? "；设置已变更" : ""}`
    : "尚无此模型和人格的实测记录；下一次对话后显示服务返回的 token 用量。";
  if (compact) {
    const label = !value
      ? "正在读取上下文…"
      : value.error
        ? value.error
        : `上下文 ${percent || (limit ? "未统计" : "容量未知")} · ${source}${usage?.settings_changed ? " · 设置已变更" : ""}`;
    const detail = estimate
      ? `当前估算：输入 ${number(estimate.input_tokens)} + 预留输出 ${number(estimate.reserved_output_tokens)} tokens。${measured}`
      : `${measured}${usage && percent ? `；${number(usage.used_tokens)} / ${number(limit)} tokens · ${percent}` : ""}`;
    return `<div class="chat-context-compact"><span title="${e(detail)}">${e(label)}</span>${value && !value.error && !limit ? '<a href="#models">填写模型容量</a>' : '<a href="#memory">会话与上下文设置</a>'}</div>`;
  }
  if (!value) return '<p class="muted">正在读取上下文统计…</p>';
  if (value.error) return `<p class="muted">${e(value.error)}</p>`;
  return `<div class="context-meter"><div class="row"><strong>${percent || (limit ? "暂无占用统计" : "上下文容量未知")} · ${source}</strong><div class="spacer"></div><span>${e(value.model?.name || "当前模型")} · ${limit ? number(limit) + " tokens" : "上限未提供"}</span></div>${percent ? `<progress max="100" value="${Math.max(0, Math.min(100, estimate ? estimate.percent : usage.percent))}" aria-label="上下文${source}占用">${percent}</progress>` : ""}${estimate ? `<p>当前估算：输入 ${number(estimate.input_tokens)} + 预留输出 ${number(estimate.reserved_output_tokens)} = ${number(estimate.total_tokens)} tokens。包含已保存上下文；新输入与工具结果会继续增加占用。</p>` : ""}<p>${e(measured)}${!limit ? ' <a href="#models">填写模型上下文上限</a>后才能计算占比和判断压缩时机。' : ""}</p></div>`;
}
function renderModeFields(p, current, mode) {
  if (mode === "legacy") {
    const days = p.short_term_days ?? 7, minimum = p.short_term_min_messages ?? 100, window = current?.memory_window;
    return `<p class="muted">旧版兼容模式：保留原有设置。选择普通模式或日记模式并保存后，使用新的上下文规则。</p><div class="context-fields"><label>短期时间窗口（天）<input name="short_term_days" type="number" required min="1" max="3650" step="1" value="${e(days)}"></label><label>短期至少保留消息数<input name="short_term_min_messages" type="number" required min="1" max="10000" step="1" value="${e(minimum)}"></label><label>历史上下文预算（估算 token）<input name="budget_tokens" type="number" required min="100" max="10000000" step="1" value="${e(p.budget_tokens ?? 6000)}"></label></div><div class="row context-options"><label><input type="checkbox" name="include_summary" ${p.include_summary ? "checked" : ""}>启用短期压缩摘要</label><label><input type="checkbox" name="long_term_enabled" ${(p.long_term_enabled ?? p.include_summary !== false) ? "checked" : ""}>启用长期认知整理</label></div><p class="muted">仅同时满足“早于 ${e(days)} 天”且“超出最近 ${e(minimum)} 条”的消息进入长期范围；${e(minimum)} 条是保底，不是上限。历史预算仅裁剪带入内容，不改变长期归类。修改后下轮生效。</p>${window ? `<p class="muted">短期 ${e(window.short_term_messages)} 条 · 长期 ${e(window.long_term_messages)} 条；现存短期摘要 ${e(window.short_summary_chars)} 字符 · 长期概览 ${e(window.long_summary_chars)} 字符。</p>` : ""}<details><summary>旧版短期压缩与长期整理如何工作</summary><p class="muted">默认 7 天、至少 100 条：一个月仅 20 条时全部仍属短期；一天 300 条也全部属短期。历史预算不足时才在回复前压缩短期内容，摘要最多 200 字符，不生成认知。长期范围累计至少 10 条未处理消息后，可在回复后生成最多 200 字符的概览及最多 2 条认知，每条最多 80 字符。每轮最多一次整理调用；两类都待处理且预算足够时轮流整理，第一次先压缩短期。失败后逐步延长等待，再随聊天重试。两类共用每日预算，按实际返回用量结算，未知用量保留预留额度；不在空闲时循环运行。</p></details>`;
  }
  return `<p class="muted">${mode === "diary" ? "日记模式：占用达到触发比例时，将较早的原始对话写成一篇新日记，保留近期原文。已有日记按篇追加，不重新总结；原始档案始终保留。" : "普通模式：在模型容量内带入当前范围的完整有效历史，不自动生成摘要或日记。超出容量时会明确提示。"}</p><div data-diary-settings ${mode === "diary" ? "" : "hidden"}><div class="context-fields"><label>开始整理的占用比例（%）<input name="compression_trigger_percent" type="number" required min="10" max="95" step="1" value="${e(p.compression_trigger_percent ?? 80)}"></label><label>整理后的目标占用比例（%）<input name="compression_target_percent" type="number" required min="5" max="94" step="1" value="${e(p.compression_target_percent ?? 50)}"></label></div><div class="row"><button class="btn small" type="button" data-diary-defaults>恢复推荐值 80% / 50%</button><small>目标比例须低于触发比例。修改后点击保存才生效。</small></div></div>`;
}
function renderDiaryState(current) {
  const diary = current?.diary;
  if (!diary) return "";
  return `<div class="context-diary-state"><p class="muted">日记 ${number(diary.count ?? diary.entries?.length ?? 0)} 篇 · 覆盖 ${number(diary.covered_messages ?? 0)} 条原文 · 剩余 ${number(diary.remaining_messages ?? current.available_messages ?? 0)} 条原文 · ${number(diary.chars ?? 0)} 字符${diary.enabled === false ? "；已保存日记仅供查看" : ""}${Number.isFinite(diary.budget_remaining) ? `。今日整理剩余额度 ${number(diary.budget_remaining)} tokens` : ""}。</p>${diary.invalid ? '<p class="muted">部分日记的来源已变化，暂不带入上下文，需根据有效原文重建。</p>' : ""}${diary.notice ? `<p class="muted">${e(diary.notice)}</p>` : ""}${diary.paused ? `<p class="form-error">日记整理已暂停；保留原文与已保存日记。${diary.paused.reason ? e(diary.paused.reason) : ""}</p><button class="btn small" type="button" data-diary-retry>恢复日记整理</button>` : ""}</div>`;
}
export function renderContextPanel(app) {
  const s = app.state, current = s.memoryContext, selected = viewedSession(s);
  const items = s.sessions?.length ? s.sessions : s.memoryCatalog?.sessions?.items || [];
  const choices = [
    { id: selected, name: current?.name || sessionName(s, selected) },
    ...items.filter((x) => x.id !== selected),
  ];
  const p = current?.policy, mode = modeOf(p);
  return `<section class="panel panel-body session-context-panel"><div class="row"><h2>所选档案的上下文</h2><div class="spacer"></div><a href="#bindings" class="btn small">切换使用的会话</a></div><div class="context-session-select"><label for="context-session">查看会话档案</label><select id="context-session">${choices.map((item) => `<option value="${e(item.id)}" ${item.id === selected ? "selected" : ""}>${e(item.name || item.id)}${item.id === s.session ? "（正在使用）" : ""}</option>`).join("")}</select><small>仅切换查看的档案，不改变当前使用的会话。</small></div>${renderContextMeter(current)}${p ? `<form id="context-form"><div class="context-session-select"><label for="context-memory-mode">记忆模式</label><select id="context-memory-mode" name="memory_mode"><option value="full" ${mode === "full" ? "selected" : ""}>普通模式 · 完整上下文（默认）</option><option value="diary" ${mode === "diary" ? "selected" : ""}>日记模式 · 逐篇追加</option>${mode === "legacy" ? '<option value="legacy" selected>旧版兼容模式</option>' : ""}</select></div><div class="context-session-select"><label for="context-history-scope">历史范围</label><select id="context-history-scope" name="history_scope"><option value="persona" ${p.history_scope === "persona" ? "selected" : ""}>仅当前人格版本</option><option value="session" ${p.history_scope !== "persona" ? "selected" : ""}>此会话全部历史（含旧人格）</option></select></div><div id="context-mode-fields">${renderModeFields(p, current, mode)}</div><div class="row context-options"><label><input type="checkbox" name="history_enabled" ${(p.history_enabled ?? p.recent_lines !== 0) ? "checked" : ""}>带入历史消息</label><label><input type="checkbox" name="include_facts" ${p.include_facts ? "checked" : ""}>带入共享事实</label><div class="spacer"></div><button class="btn primary small" type="submit" ${s.chatBusy ? "disabled" : ""}>保存所选档案设置</button></div><p class="muted">当前范围内有 ${number(current.available_messages ?? 0)} 条有效历史消息（档案共 ${number(current.stored_messages ?? 0)} 条）。设置仅在点击保存后生效。</p>${renderDiaryState(current)}<p class="form-error" id="context-error" role="alert"></p></form>` : ""}</section>`;
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
  const modeSelect = app.content.querySelector("#context-memory-mode");
  const bindDefaults = () => {
    const reset = app.content.querySelector("[data-diary-defaults]");
    if (reset) reset.onclick = () => {
      form.querySelector('[name="compression_trigger_percent"]').value = "80";
      form.querySelector('[name="compression_target_percent"]').value = "50";
    };
  };
  if (modeSelect) modeSelect.onchange = () => {
    form.querySelector("#context-mode-fields").innerHTML = renderModeFields(
      app.state.memoryContext.policy, app.state.memoryContext, modeSelect.value);
    bindDefaults();
  };
  bindDefaults();
  const retry = app.content.querySelector("[data-diary-retry]");
  if (retry) retry.onclick = async () => {
    retry.disabled = true;
    try {
      if (loaded !== viewedSession(app.state)) throw Error("正在查看的档案已改变，请重新读取后操作");
      await api("/api/memory/diary/retry", { id: loaded });
      await reload();
    } catch (error) {
      form.querySelector("#context-error").textContent = error.message;
      retry.disabled = false;
    }
  };
  if (form)
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      const data = new FormData(form);
      try {
        if (loaded !== viewedSession(app.state)) throw Error("正在查看的档案已改变，请重新读取后操作");
        const mode = data.get("memory_mode");
        const context = {
          history_enabled: data.has("history_enabled"),
          include_facts: data.has("include_facts"),
          history_scope: data.get("history_scope"),
          ...(mode ? { memory_mode: mode } : {}),
          ...(mode === "full" || mode === "diary" ? {
            compression_trigger_percent: Number(data.get("compression_trigger_percent") ?? 80),
            compression_target_percent: Number(data.get("compression_target_percent") ?? 50),
          } : {
            short_term_days: Number(data.get("short_term_days")),
            short_term_min_messages: Number(data.get("short_term_min_messages")),
            budget_tokens: Number(data.get("budget_tokens")),
            include_summary: data.has("include_summary"),
            long_term_enabled: data.has("long_term_enabled"),
          }),
        };
        if ((mode === "full" || mode === "diary") &&
            (!Number.isInteger(context.compression_trigger_percent) ||
             !Number.isInteger(context.compression_target_percent) ||
             context.compression_target_percent < 5 || context.compression_trigger_percent < 10 || context.compression_trigger_percent > 95 ||
             context.compression_target_percent >= context.compression_trigger_percent))
          throw Error("整理比例须为整数：触发比例为 10%–95%，目标至少为 5% 且低于触发比例。");
        const value = await api("/api/session/context", {
          id: loaded,
          context,
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
