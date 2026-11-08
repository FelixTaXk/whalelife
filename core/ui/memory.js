/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e, viewedSession, sessionName } from "./api.js";
import { icon } from "./icons.js";
import { renderContextPanel, bindContextSettings } from "./context.js";
const bytes = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const time = (value) => (value ? new Date(value).toLocaleString() : "—");
const summaryStatus = {
  ready: "可用", pending: "等待生成", needs_rebuild: "需要重建", failed: "整理失败",
  update_failed: "更新失败，沿用有效正文", other_scope: "其他历史范围", legacy: "旧版摘要", archived: "已存档",
};
const summaryTitle = (item) => item.mode === "diary" ? "日记" : item.mode === "short" || item.id.startsWith("s_") ? "短期摘要" : "长期概览";
const summaryNote = (item) => `<p class="muted">${e(item.status_message || "")}</p>${item.mode === "diary" ? `<small>覆盖 ${e(item.covered_messages ?? item.source_ids?.length ?? 0)} 条原文 · ${e(item.chars ?? 0)} 字符 · 范围：${item.scope === "session" ? "此会话全部历史" : "指定人格版本"}</small>${item.time_range?.start ? `<small>原始记录时间：${e(time(item.time_range.start))} 至 ${e(time(item.time_range.end))}${item.time_range.incomplete ? "（部分时间缺失）" : ""}</small>` : '<small>原始记录时间未记录</small>'}` : ""}${item.last_error ? `<p class="form-error">${e(item.last_error)}</p>` : ""}${item.retry_at ? `<small>下次可重试时间：${time(item.retry_at)}；将在后续对话满足整理条件时尝试。</small>` : ""}`;
const tabs = [
  ["local-facts", "独立事实"],
  ["facts", "共享事实"],
  ["knowledge", "记忆检索"],
  ["spaces", "共享空间"],
  ["sessions", "会话档案"],
  ["summaries", "日记与摘要"],
  ["backups", "备份与恢复"],
];
const KNOWLEDGE_PAGE_SIZE = 25;
const KNOWLEDGE_SIZE_STORAGE = "whaleMemoryPageSize";
function integerInRange(value, min, max) {
  const number = String(value ?? "").trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
function knowledgeLimit(state) {
  if (integerInRange(state.knowledgeLimit, 1, 100) === null) {
    let saved;
    try { saved = localStorage.getItem(KNOWLEDGE_SIZE_STORAGE); } catch {}
    state.knowledgeLimit = integerInRange(saved, 1, 100) ?? KNOWLEDGE_PAGE_SIZE;
  }
  return state.knowledgeLimit;
}
const knowledgeKey = (state, session) => JSON.stringify([session, state.knowledgeQuery || "", !!state.knowledgeArchived, knowledgeLimit(state)]);
function knowledgePage(data, requestedOffset = 0, requestedLimit = KNOWLEDGE_PAGE_SIZE) {
  const offset = Number.isSafeInteger(data?.offset) && data.offset >= 0 ? data.offset : requestedOffset;
  const limit = Number.isSafeInteger(data?.limit) && data.limit > 0 ? data.limit : requestedLimit;
  const total = Number.isSafeInteger(data?.total) && data.total >= 0 ? data.total : offset + (data?.items?.length || 0);
  return { offset, limit, total };
}
function disableKnowledgePaging(app) {
  app.content?.querySelectorAll("[data-knowledge-page]").forEach(button => { button.disabled = true; });
  app.content?.querySelectorAll("[data-knowledge-control]").forEach(control => { control.disabled = true; });
}

export async function loadMemory(app, { knowledgeOnly = false } = {}) {
  const tab = app.state.memoryTab || "facts";
  const session = app.state.memorySession ||= app.state.session;
  const limit = knowledgeLimit(app.state);
  const key = knowledgeKey(app.state, session);
  if (app.state.knowledgePageKey !== key) app.state.knowledgeOffset = 0;
  app.state.knowledgePageKey = key;
  const offset = app.state.knowledgeOffset || 0;
  const pageOnly = knowledgeOnly && tab === "knowledge" &&
    app.state.memoryLoadedTab === tab && app.state.memoryLoadedSession === session;
  const request = (app.state.memoryRequest =
    (app.state.memoryRequest || 0) + 1);
  app.state.memoryLoading = true;
  app.state.memoryError = "";
  disableKnowledgePaging(app);
  try {
    const query = new URLSearchParams({
      search: app.state.memorySearch || "",
      offset: String(app.state.memoryOffset || 0),
      limit: "25",
    });
    const [catalog, details, context] = await Promise.all([
      pageOnly ? Promise.resolve(app.state.memoryCatalog) : api("/api/memory?" + query),
      tab === "sessions"
        ? Promise.resolve(null)
        : tab === "local-facts"
          ? api("/api/memory/local-facts?id=" + encodeURIComponent(session))
          : ["knowledge", "spaces"].includes(tab)
            ? api(
                "/api/memory/knowledge?" +
                  new URLSearchParams({
                    id: session,
                    query:
                      tab === "knowledge" ? app.state.knowledgeQuery || "" : "",
                    archived: String(
                      tab === "knowledge" && !!app.state.knowledgeArchived,
                    ),
                    offset: String(tab === "knowledge" ? offset : 0),
                    limit: String(tab === "knowledge" ? limit : KNOWLEDGE_PAGE_SIZE),
                  }),
              )
            : api("/api/memory/" + tab),
      pageOnly ? Promise.resolve(app.state.memoryContext) : api(
        "/api/session/context?id=" + encodeURIComponent(session),
      ).catch((error) => ({ error: error.message })),
    ]);
    if (request !== app.state.memoryRequest || session !== viewedSession(app.state) ||
        tab !== (app.state.memoryTab || "facts") || (tab === "knowledge" && key !== knowledgeKey(app.state, session)))
      return;
    app.state.memoryCatalog = catalog;
    app.state.memoryContext = context;
    app.state.memoryDetails = tab === "knowledge" ? { ...details, ...knowledgePage(details, offset, limit) } : details;
    if (tab === "knowledge") app.state.knowledgeOffset = app.state.memoryDetails.offset;
    app.state.memoryLoadedTab = tab;
    app.state.memoryLoadedSession = session;
    if (tab === "local-facts") {
      app.state.localFactsDrafts = Object.assign(
        Object.create(null),
        app.state.localFactsDrafts,
      );
      if (!Object.hasOwn(app.state.localFactsDrafts, session))
        app.state.localFactsDrafts[session] = {
          text: details.text,
          revision: details.revision,
        };
    }
    if (tab === "facts" && app.state.memoryFactsDraft === undefined) {
      app.state.memoryFactsDraft = details.text;
      app.state.memoryFactsRevision = details.revision;
    }
  } catch (error) {
    if (request === app.state.memoryRequest && session === viewedSession(app.state) && tab === (app.state.memoryTab || "facts") &&
        (tab !== "knowledge" || key === knowledgeKey(app.state, session)))
      app.state.memoryError = error.message;
  } finally {
    if (request === app.state.memoryRequest) {
      app.state.memoryLoading = false;
      if (app.state.page === "memory") app.render();
    }
  }
}
export function renderMemory(app) {
  const s = app.state,
    c = s.memoryCatalog,
    tab = s.memoryTab || "facts";
  return `<div class="page-heading"><div><div class="eyebrow">MEMORY</div><h1>记忆管理</h1><p>管理会话事实、记忆检索和共享范围，查看档案与备份。</p></div><div class="heading-actions"><button class="btn" data-memory-refresh ${s.memoryLoading ? "disabled" : ""}>${icon("refresh")}刷新</button><button class="btn primary" data-memory-backup>${icon("database")}创建备份</button></div></div>
    <div class="info-banner"><div>当前正在使用：<strong>${e(sessionName(s))}</strong><small> · ${e(s.session)}</small>。下方选择仅用于查看和管理档案。</div><a href="#bindings" class="btn small link">前往使用配置切换</a></div>
    ${
      c
        ? `<div class="stats-grid">${[
            ["共享事实", c.facts.count, "跨会话共享"],
            ["会话档案", c.sessions.count, bytes(c.sessions.bytes)],
            ["日记与摘要", c.summaries.count, bytes(c.summaries.bytes)],
            [
              "所选档案上下文占用",
              !s.memoryContext?.model?.context_window || (s.memoryContext?.context_estimate?.percent ?? s.memoryContext?.usage?.percent) == null
                ? "—"
                : (s.memoryContext.context_estimate?.percent ?? s.memoryContext.usage.percent).toFixed(2) + "%",
              s.memoryContext?.model?.context_window
                ? `${s.memoryContext.context_estimate ? "当前估算" : "最近实测"} · 上限 ${s.memoryContext.model.context_window.toLocaleString()} tokens`
                : "容量未知，请在模型服务中填写",
            ],
          ]
            .map(
              ([label, n, desc]) =>
                `<div class="panel stat-card"><small>${label}</small><div class="stat-value">${e(n)}</div><div class="stat-foot">${e(desc)}</div></div>`,
            )
            .join(
              "",
            )}</div><p class="memory-location">本机文件占用 ${bytes(c.bytes)} · 存储位置：${e(c.root)} · 最近更新 ${time(c.updated_at)}${c.busy ? " · 有对话正在进行" : ""}</p>`
        : ""
    }
    ${renderContextPanel(app)}
    <div class="tabs" role="tablist" aria-label="记忆类型">${tabs.map(([id, label]) => `<button class="tab ${id === tab ? "active" : ""}" role="tab" aria-selected="${id === tab}" data-memory-tab="${id}" ${s.memoryLoading ? "disabled" : ""}>${label}</button>`).join("")}</div>
    ${s.memoryError ? `<p class="form-error" role="alert">${e(s.memoryError)}</p>` : ""}
    <section class="panel panel-body memory-panel">${s.memoryLoadedTab !== tab || s.memoryLoadedSession !== viewedSession(s) ? '<p class="empty">正在读取记忆…</p>' : renderTab(app, tab)}</section>`;
}
function renderTab(app, tab) {
  const s = app.state,
    data = s.memoryDetails;
  if (tab === "local-facts") {
    const draft = Object.hasOwn(s.localFactsDrafts || {}, viewedSession(s))
      ? s.localFactsDrafts[viewedSession(s)]
      : data;
    const count = Array.from(draft.text || "").length;
    return `<h2>所选档案的独立事实</h2><p class="muted">初始为空，切换人格时保留。你和 AI 都可以编辑；整份内容最多 100 个字符，标点、空格和换行也计入。共享事实对 AI 只读。</p><textarea id="memory-local-facts" aria-label="所选档案独立事实" rows="4" spellcheck="false" aria-describedby="local-facts-count">${e(draft.text || "")}</textarea><div class="row memory-actions"><small id="local-facts-count" class="${count > 100 ? "form-error" : "muted"}" aria-live="polite">${count} / 100 字符${count > 100 ? "，超出上限，无法保存" : ""}</small><div class="spacer"></div><button class="btn" data-local-facts-reload>重新读取</button><button class="btn primary" data-local-facts-save ${count > 100 ? "disabled" : ""}>保存独立事实</button></div>${
      data.history?.length
        ? `<details class="memory-local-history"><summary>恢复历史版本</summary><div class="row"><select id="local-facts-history" aria-label="选择独立事实历史版本">${data.history
            .map(
              (item, index) =>
                `<option value="${index}">${e(time(item.at))} · ${e(
                  Array.from(item.text || "（空白）")
                    .slice(0, 36)
                    .join(""),
                )}</option>`,
            )
            .join(
              "",
            )}</select><button class="btn small" data-local-facts-history>载入编辑框</button></div><small class="muted">载入后检查内容，再点击保存；仍受 100 字符上限约束。</small></details>`
        : ""
    }`;
  }
  if (tab === "knowledge") return renderKnowledge(s, data);
  if (tab === "spaces") return renderSpaces(s, data);
  if (tab === "facts")
    return `<div class="panel-header"><div><h2>共享事实</h2><p>每行一条事实，保存后用于下一轮对话。与所有人格共享；仅你可以编辑，AI 只读。</p></div><button class="btn small" data-facts-dedupe>去除重复行</button></div><textarea id="memory-facts" aria-label="共享事实内容" rows="14" spellcheck="false">${e(s.memoryFactsDraft)}</textarea><div class="row memory-actions"><small id="facts-state">编辑后点击保存；不会自动改写。</small><div class="spacer"></div><button class="btn" data-facts-reload>重新读取</button><button class="btn primary" data-facts-save>保存事实</button></div>`;
  if (tab === "sessions") {
    const list = s.memoryCatalog.sessions;
    return `<form id="memory-search-form" class="row"><input name="search" type="search" aria-label="搜索会话" placeholder="搜索名称、会话 ID 或内容" value="${e(s.memorySearch || "")}"><button class="btn" type="submit">搜索</button></form><div class="memory-table">${list.items.map((item) => `<div class="memory-item"><div><strong>${e(item.name || item.id)} ${item.id === s.session ? '<span class="badge green">当前会话</span>' : ""}</strong><small>${item.name ? e(item.id) + " · " : ""}${time(item.updated_at)} · ${bytes(item.bytes)}</small><small title="${e(item.last_persona?.id || "")}">最后使用人格：${e(item.last_persona?.name || "未记录")}</small></div><div class="row session-actions"><button class="btn small" data-session="${e(item.id)}">查看</button><button class="btn small tonal" data-memory-session="${e(item.id)}">查看记忆</button><button class="btn small" data-session-rename="${e(item.id)}">改名</button><button class="btn small danger" data-session-delete="${e(item.id)}">删除</button></div></div>`).join("") || '<p class="empty">暂无匹配的会话。</p>'}</div><div class="row memory-actions"><small>共 ${list.total} 个匹配会话</small><div class="spacer"></div><button class="btn small" data-memory-prev ${list.offset === 0 ? "disabled" : ""}>上一页</button><button class="btn small" data-memory-next ${list.offset + list.limit >= list.total ? "disabled" : ""}>下一页</button></div>`;
  }
  if (tab === "summaries")
    return `<h2>日记与摘要</h2><p class="muted">日记按篇追加，保留来源条数与原始记录时间。关闭自动整理只停止新生成，已有有效日记仍用于上下文。历史摘要保留供核对；来源失效的内容不会带入。</p><div class="memory-table">${data.items.map((item) => `<div class="memory-item"><div><strong>${summaryTitle(item)}${item.session_name ? ` · ${e(item.session_name)}` : ""}</strong><small>${e(summaryStatus[item.status] || "旧版摘要")} · ${time(item.updated_at)} · ${bytes(item.bytes)}</small>${summaryNote(item)}<small>${e(item.id)}</small></div><button class="btn small" data-summary="${e(item.id)}">${item.bytes ? "查看内容" : "查看状态"}</button></div>`).join("") || '<p class="empty">尚未保存日记或摘要。开启自动整理为日记后，达到触发比例才会生成。</p>'}</div>`;
  return `<h2>本机备份</h2><p class="muted">完整保存记忆目录，包含目录内的人格文件。恢复前自动备份当前数据；不覆盖模型配置和密钥。</p><p class="memory-location">备份位置：${e(data.directory)}</p><div class="memory-table">${data.items.map((item) => `<div class="memory-item"><div><strong>${e(item.id)}</strong><small>${time(item.created_at)} · ${item.files || 0} 个文件 · ${bytes(item.bytes || 0)} · ${item.kind === "before-restore" ? "恢复前自动备份" : "手动备份"}</small>${item.error ? `<p class="form-error">${e(item.error)}</p>` : ""}</div><button class="btn small" data-restore="${e(item.id)}" ${!item.valid || s.chatBusy || s.memoryCatalog.busy ? "disabled" : ""}>恢复此备份</button></div>`).join("") || '<p class="empty">暂无备份，点击右上方“创建备份”。</p>'}</div>`;
}
function joinedSpaces(data) {
  return (data.spaces || []).filter(
    (space) => space.joined || data.memberships?.includes(space.id),
  );
}
function sourceLabel(source) {
  return typeof source === "string"
    ? source
    : source?.plugin || source?.type || "未记录";
}
function renderKnowledgePaging(s, data) {
  const { total, offset, limit } = knowledgePage(data, 0, knowledgeLimit(s));
  const pages = Math.ceil(total / limit), current = total ? Math.floor(offset / limit) + 1 : 0;
  const numbers = pages <= 7 ? Array.from({ length: pages }, (_, i) => i + 1) :
    [...new Set([1, current - 1, current, current + 1, pages].filter(value => value >= 1 && value <= pages))].sort((a, b) => a - b);
  const pageButtons = numbers.map((value, index) =>
    `${index && value - numbers[index - 1] > 1 ? '<span class="memory-page-ellipsis" aria-hidden="true">…</span>' : ""}<button class="btn small memory-page-button" type="button" data-knowledge-page="${value}" aria-label="第 ${value} 页" ${value === current ? 'aria-current="page" ' : ""}${s.memoryLoading || value === current ? "disabled" : ""}>${value}</button>`).join("");
  return `<nav class="memory-pagination" aria-label="记忆分页"><small class="memory-pagination-summary">第 ${current} / ${pages} 页 · 共 ${total} 条</small><div class="memory-pagination-pages"><button class="btn small memory-page-button" type="button" data-knowledge-page="prev" aria-label="上一页" ${s.memoryLoading || offset === 0 ? "disabled" : ""}>上一页</button>${pageButtons}<button class="btn small memory-page-button" type="button" data-knowledge-page="next" aria-label="下一页" ${s.memoryLoading || offset + limit >= total ? "disabled" : ""}>下一页</button></div><div class="memory-pagination-controls"><form class="memory-pagination-form" data-knowledge-jump><label>跳至<input type="number" name="page" aria-label="跳转页码" min="1" max="${pages || 1}" step="1" required value="${current || 1}" data-knowledge-control ${s.memoryLoading || !pages ? "disabled" : ""}>页</label><button class="btn small" type="submit" data-knowledge-control ${s.memoryLoading || !pages ? "disabled" : ""}>跳转</button></form><form class="memory-pagination-form" data-knowledge-size><label>每页<input type="number" name="limit" aria-label="每页条数" min="1" max="100" step="1" required value="${knowledgeLimit(s)}" data-knowledge-control ${s.memoryLoading ? "disabled" : ""}>条</label><button class="btn small" type="submit" data-knowledge-control ${s.memoryLoading ? "disabled" : ""}>应用</button></form></div></nav>`;
}
function renderKnowledge(s, data) {
  const usage = data.usage || {},
    settings = data.settings || {};
  const usageText = (value = {}) =>
    `${value.unknown_requests > 0 ? "已报告：" : ""}${Number(value.input_tokens || 0).toLocaleString()} 输入 + ${Number(value.output_tokens || 0).toLocaleString()} 输出 · ${Number(value.requests || 0).toLocaleString()} 次请求${value.unknown_requests > 0 ? ` · 含 ${Number(value.unknown_requests).toLocaleString()} 次未报告用量请求` : ""}`;
  const kinds = {
    fact: "事实",
    cognition: "认知",
    episode: "经历",
    experience: "经历",
  };
  const statuses = {
    active: "有效",
    archived: "已归档",
    superseded: "已替代",
    review: "待复核",
    invalid: "已失效",
  };
  return `<h2>所选档案的记忆</h2><p class="muted">检索本会话及已加入的共享空间。自动检索会补充相关片段；归档后不再自动召回，原文仍保留。</p><form id="knowledge-search-form" class="row memory-knowledge-search"><input name="query" type="search" aria-label="搜索记忆" placeholder="输入关键词、名称或旧事" value="${e(s.knowledgeQuery || "")}"><label><input type="checkbox" name="archived" ${s.knowledgeArchived ? "checked" : ""}>包含已归档、已替代与待复核</label><button class="btn" type="submit">搜索</button></form><div class="memory-table">${
    (data.items || [])
      .map((item) => {
        const archived = item.status === "archived";
        const actionButton = (action, title) => `<button class="btn small" data-knowledge-action="${action}" data-record-id="${e(item.id)}">${title}</button>`;
        const maintenanceActions = item.superseded_by || item.reverted_at ? "" :
          actionButton(archived || item.status === "review" ? "restore" : "archive",
            item.status === "review" ? "确认有效" : archived ? "恢复" : "归档") +
          (item.supersedes?.length ? actionButton("undo", "撤回修订") : "");
        const revisionNote = item.kind !== "cognition" ? "" :
          `<small class="muted">${item.uncertain !== false ? "含不确定判断" : "有明确来源，仍可修订"}${item.reverted_at ? " · 修订已撤回" : ""}</small>` +
          (item.change_reason || item.review || item.supersedes?.length || item.superseded_by ?
            `<details><summary>修订记录</summary><pre class="memory-preview">${e([
              item.change_reason && "修订依据：" + item.change_reason,
              item.supersedes?.length && "替代：" + item.supersedes.join("、"),
              item.superseded_by && "由此记录替代：" + item.superseded_by,
              item.review && "复核依据：" + item.review.reason + "\n来源：" + item.review.evidence.join("、"),
            ].filter(Boolean).join("\n"))}</pre></details>` : "");
        const fresh = Number.isFinite(item.freshness)
          ? `${(Math.max(0, Math.min(1, item.freshness)) * 100).toFixed(0)}%`
          : "—";
        return `<article class="memory-knowledge-item"><div class="row"><strong>${e(kinds[item.kind] || item.kind || "记忆")}</strong><span class="badge">${e(statuses[item.status] || item.status || "有效")}</span>${item.pinned ? '<span class="badge green">已置顶</span>' : ""}<div class="spacer"></div><small>${e(time(item.ts))}</small></div><p class="memory-knowledge-text">${e(item.text)}</p><small class="muted">来源：${e(sourceLabel(item.source))} · 鲜活度 ${fresh}${Number.isFinite(item.score) ? ` · 相关得分 ${item.score.toFixed(2)}` : ""}</small>${item.reason ? `<p class="memory-recall-reason">召回依据：${e(typeof item.reason === "string" ? item.reason : JSON.stringify(item.reason))}</p>` : ""}${item.evidence?.length ? `<details><summary>来源引用（${item.evidence.length}）</summary><pre class="memory-preview">${e(item.evidence.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n"))}</pre></details>` : ""}${revisionNote}<div class="row memory-record-actions"><button class="btn small" data-knowledge-action="${item.pinned ? "unpin" : "pin"}" data-record-id="${e(item.id)}">${item.pinned ? "取消置顶" : "置顶"}</button>${maintenanceActions}${joinedSpaces(data).length ? `<button class="btn small" data-knowledge-share="${e(item.id)}">分享到空间</button>` : ""}</div></article>`;
      })
      .join("") ||
    '<p class="empty">暂无匹配记忆。可以调整关键词；没有相关内容时不会强行带入。</p>'
  }</div>${renderKnowledgePaging(s, data)}${data.trace ? `<details class="memory-recall-trace"><summary>上次聊天的自动检索</summary><p class="muted">这是上次聊天补充相关记忆的记录，不是当前搜索结果；检索本身不调用模型。</p><p class="muted">查询：${e(data.trace.query || "（无）")} · 选中 ${data.trace.selected?.length || 0} 条 · 估算 ${Number(data.trace.estimated_tokens || 0).toLocaleString()} tokens</p></details>` : ""}<details class="memory-settings"><summary>自动检索与用量</summary><p class="muted">聊天时按话题补充未带入上下文的记忆，例如插件经历、共享空间记录，或已整理成日记的旧对话细节。完整原文已在上下文时会跳过相同正文。检索不额外调用模型，补充内容计入本轮输入 token。</p><form id="memory-settings-form"><div class="context-fields"><label>普通经历半衰期（天）<input type="number" name="half_life_days" required min="1" max="3650" value="${e(settings.half_life_days ?? 30)}"><small>仅影响额外检索的排序，不删除原文，也不按天压缩对话。</small></label><label>额外检索片段上限（估算 token）<input type="number" name="recall_tokens" required min="0" max="4000" value="${e(settings.recall_tokens ?? 800)}"><small>默认 800，仅限制额外补充的相关片段，不是完整上下文预算。</small></label><label>每日记忆整理额度（估算 token）<input type="number" name="daily_memory_tokens" required min="0" max="10000000" step="1" value="${e(settings.daily_memory_tokens ?? 20000)}"><small>仅在触发整理时消耗；关闭自动日记不会生成新日记，0 会停止后续整理。已有有效日记仍可使用；大上下文可按单次估算提高额度。</small></label></div><div class="row memory-actions"><label><input type="checkbox" name="enabled" ${settings.enabled !== false ? "checked" : ""}>启用自动记忆召回</label><div class="spacer"></div><button class="btn primary small" type="submit">保存记忆设置</button></div></form><div class="memory-usage"><p>聊天累计：${e(usageText(usage.chat))}</p><p>记忆整理累计：${e(usageText(usage.memory))}</p><small class="muted">历史累计包含旧机制消耗，清理旧摘要不会清零用量。按服务返回用量统计；未报告用量的请求无法计入准确 token，与单次上下文占用分开。</small></div></details>`;
}
function renderSpaces(s, data) {
  const joined = new Set(joinedSpaces(data).map((space) => space.id));
  return `<div class="panel-header"><div><h2>共享记忆空间</h2><p>所选会话加入后才能检索该空间。原有共享事实继续单独保留；独立事实不会自动共享。</p></div><button class="btn primary small" data-space-create>新建空间</button></div><div class="memory-table">${(data.spaces || []).map((space) => `<div class="memory-item"><div><strong>${e(space.name || space.id)}</strong><small>${e(space.id)} · ${joined.has(space.id) ? "所选会话已加入" : "尚未加入"}</small></div><button class="btn small ${joined.has(space.id) ? "" : "tonal"}" data-space-toggle="${e(space.id)}" data-space-joined="${joined.has(space.id)}">${joined.has(space.id) ? "退出空间" : "加入空间"}</button></div>`).join("") || '<p class="empty">暂无共享空间。需要跨会话回忆时再创建并加入。</p>'}</div><p class="muted">加入空间后，可在“记忆检索”中将指定记忆分享到空间。退出只改变所选会话的检索范围，不删除空间内的记录。</p>`;
}
export function bindMemory(app) {
  const root = app.content,
    s = app.state;
  bindContextSettings(app, () => loadMemory(app));
  const loadedSession = s.memoryLoadedSession;
  const assertSession = () => {
    if (loadedSession !== viewedSession(s))
      throw Error("正在查看的档案已改变，请重新读取后操作");
  };
  const localFacts = root.querySelector("#memory-local-facts");
  if (localFacts) {
    const save = root.querySelector("[data-local-facts-save]");
    localFacts.oninput = () => {
      const count = Array.from(localFacts.value).length;
      const label = root.querySelector("#local-facts-count");
      label.textContent = `${count} / 100 字符${count > 100 ? "，超出上限，无法保存" : " · 有未保存的修改"}`;
      label.className = count > 100 ? "form-error" : "muted";
      save.disabled = count > 100;
      s.localFactsDrafts[loadedSession].text = localFacts.value;
    };
    root.querySelector("[data-local-facts-reload]").onclick = () =>
      app.dialog(
        "重新读取独立事实",
        "<p>放弃当前未保存的编辑，重新读取此会话的事实？</p>",
        async () => {
          assertSession();
          delete s.localFactsDrafts[loadedSession];
          await loadMemory(app);
        },
        "重新读取",
      );
    root
      .querySelector("[data-local-facts-history]")
      ?.addEventListener("click", () => {
        const index = Number(root.querySelector("#local-facts-history").value);
        const entry = s.memoryDetails.history?.[index];
        if (entry) {
          localFacts.value = entry.text;
          localFacts.oninput();
        }
      });
    save.onclick = async () => {
      save.disabled = true;
      try {
        assertSession();
        if (Array.from(localFacts.value).length > 100)
          throw Error("整份独立事实不能超过 100 个字符");
        const result = await api("/api/memory/local-facts", {
          id: loadedSession,
          text: localFacts.value,
          revision: s.localFactsDrafts[loadedSession].revision,
        });
        s.localFactsDrafts[loadedSession] = {
          text: result.text,
          revision: result.revision,
        };
        await loadMemory(app);
        app.toast("独立事实已保存，下轮对话生效");
      } catch (error) {
        app.toast(error.message, true);
        save.disabled = Array.from(localFacts.value).length > 100;
      }
    };
  }
  const knowledgeSearch = root.querySelector("#knowledge-search-form");
  if (knowledgeSearch) {
    const search = (event) => {
      event?.preventDefault();
      const data = new FormData(knowledgeSearch);
      s.knowledgeQuery = data.get("query");
      s.knowledgeArchived = data.has("archived");
      s.knowledgeOffset = 0;
      return loadMemory(app, { knowledgeOnly: true });
    };
    knowledgeSearch.onsubmit = search;
    const archived = knowledgeSearch.querySelector?.('[name="archived"]');
    if (archived) archived.onchange = search;
  }
  const loadedKnowledge = s.memoryDetails;
  const paging = knowledgePage(loadedKnowledge, 0, knowledgeLimit(s));
  const canPage = () => !s.memoryLoading && loadedSession === viewedSession(s) &&
    s.memoryDetails === loadedKnowledge && (s.memoryTab || "facts") === "knowledge";
  const goToPage = (page) => {
    if (!canPage()) return;
    const offset = (page - 1) * paging.limit;
    if (offset === paging.offset) return;
    s.knowledgeOffset = offset;
    return loadMemory(app, { knowledgeOnly: true });
  };
  root.querySelectorAll("[data-knowledge-page]").forEach(button => {
    const { offset, limit, total } = paging;
    const current = Math.floor(offset / limit) + 1, pages = Math.ceil(total / limit);
    const direction = button.dataset.knowledgePage;
    const target = direction === "next" ? current + 1 : direction === "prev" ? current - 1 : Number(direction);
    button.disabled = !!s.memoryLoading || target < 1 || target > pages || target === current;
    button.onclick = () => {
      if (!button.disabled) return goToPage(target);
    };
  });
  root.querySelectorAll("[data-knowledge-jump]").forEach(form => {
    form.onsubmit = event => {
      event.preventDefault();
      if (!canPage()) return;
      const pages = Math.ceil(paging.total / paging.limit);
      const target = integerInRange(form.querySelector('[name="page"]').value, 1, pages);
      if (target === null) return app.toast(`请输入 1 到 ${pages} 之间的整数页码`, true);
      return goToPage(target);
    };
  });
  root.querySelectorAll("[data-knowledge-size]").forEach(form => {
    form.onsubmit = event => {
      event.preventDefault();
      if (!canPage()) return;
      const limit = integerInRange(form.querySelector('[name="limit"]').value, 1, 100);
      if (limit === null) return app.toast("每页条数请输入 1 到 100 之间的整数", true);
      if (limit === knowledgeLimit(s)) return;
      s.knowledgeLimit = limit;
      s.knowledgeOffset = 0;
      try { localStorage.setItem(KNOWLEDGE_SIZE_STORAGE, String(limit)); } catch {}
      return loadMemory(app, { knowledgeOnly: true });
    };
  });
  root.querySelectorAll("[data-knowledge-action]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        assertSession();
        await api("/api/memory/knowledge", {
          id: loadedSession,
          record_id: button.dataset.recordId,
          action: button.dataset.knowledgeAction,
        });
        if (loadedSession === viewedSession(s) && s.memoryTab === "knowledge")
          await loadMemory(app, { knowledgeOnly: true });
        app.toast("记忆已更新");
      } catch (error) {
        app.toast(error.message, true);
        button.disabled = false;
      }
    };
  });
  root.querySelectorAll("[data-knowledge-share]").forEach((button) => {
    button.onclick = () =>
      app.dialog(
        "分享到共享空间",
        `<label>目标空间<select name="space_id">${joinedSpaces(s.memoryDetails)
          .map(
            (space) =>
              `<option value="${e(space.id)}">${e(space.name || space.id)}</option>`,
          )
          .join(
            "",
          )}</select></label><p class="muted">加入该空间的其他会话将可以检索这条记忆。</p>`,
        async (data) => {
          assertSession();
          await api("/api/memory/knowledge", {
            id: loadedSession,
            record_id: button.dataset.knowledgeShare,
            action: "share",
            space_id: data.get("space_id"),
          });
          await loadMemory(app);
          app.toast("记忆已分享到空间");
        },
        "分享记忆",
      );
  });
  const settingsForm = root.querySelector("#memory-settings-form");
  if (settingsForm)
    settingsForm.onsubmit = async (event) => {
      event.preventDefault();
      const button = settingsForm.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        assertSession();
        const data = new FormData(settingsForm);
        await api("/api/memory/settings", {
          id: loadedSession,
          settings: {
            enabled: data.has("enabled"),
            half_life_days: Number(data.get("half_life_days")),
            recall_tokens: Number(data.get("recall_tokens")),
            daily_memory_tokens: Number(data.get("daily_memory_tokens")),
          },
          memberships:
            s.memoryDetails.memberships ||
            joinedSpaces(s.memoryDetails).map((space) => space.id),
        });
        await loadMemory(app);
        app.toast("记忆设置已保存");
      } catch (error) {
        app.toast(error.message, true);
        button.disabled = false;
      }
    };
  root.querySelector("[data-space-create]")?.addEventListener("click", () =>
    app.dialog(
      "新建共享空间",
      '<label>空间名称<input name="name" required maxlength="60" placeholder="例如：共同项目"></label><p class="muted">创建后再选择需要加入的会话。</p>',
      async (data) => {
        assertSession();
        await api("/api/memory/spaces", { name: data.get("name") });
        await loadMemory(app);
        app.toast("共享空间已创建");
      },
      "创建空间",
    ),
  );
  root.querySelectorAll("[data-space-toggle]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        assertSession();
        const memberships = new Set(
          s.memoryDetails.memberships ||
            joinedSpaces(s.memoryDetails).map((space) => space.id),
        );
        if (button.dataset.spaceJoined === "true")
          memberships.delete(button.dataset.spaceToggle);
        else memberships.add(button.dataset.spaceToggle);
        await api("/api/memory/settings", {
          id: loadedSession,
          settings: s.memoryDetails.settings,
          memberships: [...memberships],
        });
        await loadMemory(app);
        app.toast(
          button.dataset.spaceJoined === "true"
            ? "所选会话已退出空间"
            : "所选会话已加入空间",
        );
      } catch (error) {
        app.toast(error.message, true);
        button.disabled = false;
      }
    };
  });
  root.querySelectorAll("[data-memory-session]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          s.memorySession = b.dataset.memorySession;
          s.memoryContext = null;
          s.memoryTab = "local-facts";
          await loadMemory(app);
        } catch (error) {
          app.toast(error.message, true);
        }
      }),
  );
  root.querySelectorAll("[data-session-rename]").forEach(
    (b) =>
      (b.onclick = () => {
        const item = s.memoryCatalog.sessions.items.find(
          (x) => x.id === b.dataset.sessionRename,
        );
        app.dialog(
          "会话改名",
          `<label for="session-name">名称</label><input id="session-name" name="name" maxlength="80" required value="${e(item.name || "")}" placeholder="给这个会话取个名字">`,
          async (data) => {
            await api("/api/memory/session/rename", {
              id: item.id,
              name: data.get("name"),
            });
            await app.syncSession();
            await loadMemory(app);
            app.toast("会话名称已保存");
          },
          "保存名称",
        );
      }),
  );
  root.querySelectorAll("[data-session-delete]").forEach(
    (b) =>
      (b.onclick = () => {
        const item = s.memoryCatalog.sessions.items.find(
          (x) => x.id === b.dataset.sessionDelete,
        );
        app.dialog(
          "删除会话",
          `<p>删除「${e(item.name || item.id)}」及对应摘要？</p><p>文件会移入本机记忆回收目录，共享事实保留。删除当前会话后会使用最近的可用会话；没有可用会话时新建。</p>`,
          async () => {
            await api("/api/memory/session/delete", { id: item.id });
            await app.syncSession();
            await loadMemory(app);
            app.toast("会话已删除");
          },
          "确认删除",
          true,
        );
      }),
  );
  root.querySelectorAll("[data-memory-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        s.memoryTab = b.dataset.memoryTab;
        s.memoryError = "";
        app.render();
      }),
  );
  root.querySelector("[data-memory-refresh]").onclick = () => loadMemory(app);
  root.querySelector("[data-memory-backup]").onclick = async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api("/api/memory/backup", {});
      app.toast("备份已创建：" + result.id);
      await loadMemory(app);
    } catch (error) {
      app.toast(error.message, true);
      event.currentTarget.disabled = false;
    }
  };
  const facts = root.querySelector("#memory-facts");
  if (facts) {
    facts.oninput = () => {
      s.memoryFactsDraft = facts.value;
      root.querySelector("#facts-state").textContent = "有未保存的修改";
    };
    root.querySelector("[data-facts-dedupe]").onclick = () => {
      facts.value = [
        ...new Set(
          facts.value
            .split(/\r?\n/)
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ].join("\n");
      facts.oninput();
    };
    root.querySelector("[data-facts-reload]").onclick = () =>
      app.dialog(
        "重新读取共享事实",
        "<p>放弃当前未保存的编辑，重新读取磁盘上的事实？</p>",
        async () => {
          s.memoryFactsDraft = undefined;
          await loadMemory(app);
        },
        "重新读取",
      );
    root.querySelector("[data-facts-save]").onclick = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await api("/api/memory/facts", {
          text: facts.value,
          revision: s.memoryFactsRevision,
        });
        s.memoryFactsDraft = result.text;
        s.memoryFactsRevision = result.revision;
        await loadMemory(app);
        app.toast("共享事实已保存，下轮对话生效");
      } catch (error) {
        app.toast(error.message, true);
        button.disabled = false;
      }
    };
  }
  const search = root.querySelector("#memory-search-form");
  if (search)
    search.onsubmit = (event) => {
      event.preventDefault();
      s.memorySearch = new FormData(search).get("search");
      s.memoryOffset = 0;
      loadMemory(app);
    };
  root.querySelector("[data-memory-prev]")?.addEventListener("click", () => {
    s.memoryOffset = Math.max(0, (s.memoryOffset || 0) - 25);
    loadMemory(app);
  });
  root.querySelector("[data-memory-next]")?.addEventListener("click", () => {
    s.memoryOffset = (s.memoryOffset || 0) + 25;
    loadMemory(app);
  });
  root
    .querySelectorAll("[data-session]")
    .forEach((b) => (b.onclick = () => showSession(app, b.dataset.session)));
  root.querySelectorAll("[data-summary]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          const value = await api(
            "/api/memory/summary?id=" + encodeURIComponent(b.dataset.summary),
          );
          app.dialog(
            summaryTitle(value),
            `${value.session_name ? `<p>${e(value.session_name)}</p>` : ""}${summaryNote(value)}${value.text ? `<pre class="memory-preview">${e(value.text)}</pre>` : '<p class="empty">当前没有可用正文。</p>'}`,
            null,
          );
        } catch (error) {
          app.toast(error.message, true);
        }
      }),
  );
  root.querySelectorAll("[data-restore]").forEach(
    (b) =>
      (b.onclick = () =>
        app.dialog(
          "恢复记忆备份",
          `<p>恢复「${e(b.dataset.restore)}」？当前记忆会先自动备份，之后可恢复该自动备份撤回本次操作。</p><p>记忆目录内的人格文件也会恢复。操作完成后使用备份中保存的当前会话；正在进行的对话会阻止恢复。</p>`,
          async () => {
            const value = await api("/api/memory/restore", {
              id: b.dataset.restore,
            });
            s.memoryFactsDraft = undefined;
            s.localFactsDrafts = Object.create(null);
            s.memoryCatalog = null;
            s.memoryLoadedTab = null;
            await app.load();
            s.memorySession = null;
            s.memoryContext = null;
            await loadMemory(app);
            app.toast("已恢复；原数据备份为 " + value.safety_backup.id);
          },
          "备份当前数据并恢复",
          true,
        )),
  );
  if (
    !s.memoryLoading &&
    !s.memoryError &&
    (s.memoryLoadedTab !== (s.memoryTab || "facts") ||
      s.memoryLoadedSession !== viewedSession(s))
  )
    loadMemory(app);
}
async function showSession(app, id, offset = 0) {
  try {
    const value = await api(
      "/api/memory/session?" +
        new URLSearchParams({ id, offset: String(offset), limit: "100" }),
    );
    app.dialog(
      "会话记录",
      `<p>${e(id)} · 共 ${value.total} 条记录</p>${value.warnings?.length ? `<p class="form-error">${e(value.warnings.join("；"))}</p>` : ""}<div class="memory-transcript">${value.items.map((item) => `<article><small>${e(item.ts || "")} · ${e(item.persona_name || "")} · ${e(item.role || item.type)}</small><pre>${e(item.text ?? JSON.stringify(item, null, 2))}</pre></article>`).join("")}</div><div class="row memory-actions"><button type="button" class="btn small" id="session-prev" ${offset === 0 ? "disabled" : ""}>上一页</button><button type="button" class="btn small" id="session-next" ${offset + 100 >= value.total ? "disabled" : ""}>下一页</button></div>`,
      null,
    );
    document.querySelector("#session-prev").onclick = () =>
      showSession(app, id, Math.max(0, offset - 100));
    document.querySelector("#session-next").onclick = () =>
      showSession(app, id, offset + 100);
  } catch (error) {
    app.toast(error.message, true);
  }
}
