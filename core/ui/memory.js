import { api, escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";
import { renderContextPanel, bindContextSettings } from "./context.js";
const bytes = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const time = (value) => (value ? new Date(value).toLocaleString() : "—");
const tabs = [
  ["local-facts", "独立事实"],
  ["facts", "共享事实"],
  ["knowledge", "记忆检索"],
  ["spaces", "共享空间"],
  ["sessions", "会话档案"],
  ["summaries", "滚动摘要"],
  ["backups", "备份与恢复"],
];

export async function loadMemory(app) {
  const tab = app.state.memoryTab || "facts";
  const session = app.state.session;
  const request = (app.state.memoryRequest =
    (app.state.memoryRequest || 0) + 1);
  app.state.memoryLoading = true;
  app.state.memoryError = "";
  try {
    const query = new URLSearchParams({
      search: app.state.memorySearch || "",
      offset: String(app.state.memoryOffset || 0),
      limit: "25",
    });
    const [catalog, details, context] = await Promise.all([
      api("/api/memory?" + query),
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
                  }),
              )
            : api("/api/memory/" + tab),
      api(
        "/api/session/context?id=" + encodeURIComponent(app.state.session),
      ).catch((error) => ({ error: error.message })),
    ]);
    if (request !== app.state.memoryRequest || session !== app.state.session)
      return;
    app.state.memoryCatalog = catalog;
    app.state.sessionContext = context;
    app.state.memoryDetails = details;
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
    if (request === app.state.memoryRequest)
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
    ${
      c
        ? `<div class="stats-grid">${[
            ["共享事实", c.facts.count, "跨会话共享"],
            ["会话档案", c.sessions.count, bytes(c.sessions.bytes)],
            ["滚动摘要", c.summaries.count, bytes(c.summaries.bytes)],
            [
              "当前上下文占用",
              s.sessionContext?.usage?.percent == null
                ? "—"
                : s.sessionContext.usage.percent.toFixed(2) + "%",
              s.sessionContext?.model?.context_window
                ? `模型上限 ${s.sessionContext.model.context_window.toLocaleString()} tokens`
                : "模型上限尚未读取",
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
    <section class="panel panel-body memory-panel">${s.memoryLoadedTab !== tab || s.memoryLoadedSession !== s.session ? '<p class="empty">正在读取记忆…</p>' : renderTab(app, tab)}</section>`;
}
function renderTab(app, tab) {
  const s = app.state,
    data = s.memoryDetails;
  if (tab === "local-facts") {
    const draft = Object.hasOwn(s.localFactsDrafts || {}, s.session)
      ? s.localFactsDrafts[s.session]
      : data;
    const count = Array.from(draft.text || "").length;
    return `<h2>当前会话的独立事实</h2><p class="muted">初始为空，切换人格时保留。你和 AI 都可以编辑；整份内容最多 100 个字符，标点、空格和换行也计入。共享事实对 AI 只读。</p><textarea id="memory-local-facts" aria-label="当前会话独立事实" rows="4" spellcheck="false" aria-describedby="local-facts-count">${e(draft.text || "")}</textarea><div class="row memory-actions"><small id="local-facts-count" class="${count > 100 ? "form-error" : "muted"}" aria-live="polite">${count} / 100 字符${count > 100 ? "，超出上限，无法保存" : ""}</small><div class="spacer"></div><button class="btn" data-local-facts-reload>重新读取</button><button class="btn primary" data-local-facts-save ${count > 100 ? "disabled" : ""}>保存独立事实</button></div>${
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
    return `<form id="memory-search-form" class="row"><input name="search" type="search" aria-label="搜索会话" placeholder="搜索名称、会话 ID 或内容" value="${e(s.memorySearch || "")}"><button class="btn" type="submit">搜索</button></form><div class="memory-table">${list.items.map((item) => `<div class="memory-item"><div><strong>${e(item.name || item.id)} ${item.id === s.session ? '<span class="badge green">当前会话</span>' : ""}</strong><small>${item.name ? e(item.id) + " · " : ""}${time(item.updated_at)} · ${bytes(item.bytes)}</small><small title="${e(item.last_persona?.id || "")}">最后使用人格：${e(item.last_persona?.name || "未记录")}</small></div><div class="row session-actions"><button class="btn small" data-session="${e(item.id)}">查看</button><button class="btn small tonal" data-session-use="${e(item.id)}" ${s.chatBusy ? "disabled" : ""}>设为当前会话</button><button class="btn small" data-session-rename="${e(item.id)}">改名</button><button class="btn small danger" data-session-delete="${e(item.id)}">删除</button></div></div>`).join("") || '<p class="empty">暂无匹配的会话。</p>'}</div><div class="row memory-actions"><small>共 ${list.total} 个匹配会话</small><div class="spacer"></div><button class="btn small" data-memory-prev ${list.offset === 0 ? "disabled" : ""}>上一页</button><button class="btn small" data-memory-next ${list.offset + list.limit >= list.total ? "disabled" : ""}>下一页</button></div>`;
  }
  if (tab === "summaries")
    return `<h2>滚动摘要</h2><p class="muted">对话达到阈值后自动生成；默认同一会话跨人格共用，按人格隔离时另行保存。</p><div class="memory-table">${data.items.map((item) => `<div class="memory-item"><div><strong>${e(item.id)}</strong><small>${time(item.updated_at)} · ${bytes(item.bytes)}</small></div><button class="btn small" data-summary="${e(item.id)}">查看摘要</button></div>`).join("") || '<p class="empty">尚未生成摘要，短会话不会产生滚动摘要。</p>'}</div>`;
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
  return `<h2>当前会话记忆</h2><p class="muted">检索本会话及已加入的共享空间。普通经历会随时间淡忘；归档后不再自动召回，原文仍保留。</p><form id="knowledge-search-form" class="row memory-knowledge-search"><input name="query" type="search" aria-label="搜索记忆" placeholder="输入关键词、名称或旧事" value="${e(s.knowledgeQuery || "")}"><label><input type="checkbox" name="archived" ${s.knowledgeArchived ? "checked" : ""}>包含已归档、已替代与待复核</label><button class="btn" type="submit">搜索</button></form><div class="memory-table">${
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
  }</div>${data.trace ? `<details class="memory-recall-trace"><summary>最近召回记录</summary><p class="muted">查询：${e(data.trace.query || "（无）")} · 选中 ${data.trace.selected?.length || 0} 条 · 估算 ${Number(data.trace.estimated_tokens || 0).toLocaleString()} tokens</p></details>` : ""}<details class="memory-settings"><summary>筛选、淡忘与用量</summary><form id="memory-settings-form"><div class="context-fields"><label>普通经历半衰期（天）<input type="number" name="half_life_days" required min="1" max="3650" value="${e(settings.half_life_days ?? 30)}"></label><label>自动召回预算（估算 token）<input type="number" name="recall_tokens" required min="0" max="4000" value="${e(settings.recall_tokens ?? 800)}"></label><label>每日记忆整理预算（估算 token）<input type="number" name="daily_memory_tokens" required min="0" max="200000" step="1" value="${e(settings.daily_memory_tokens ?? 20000)}"><small>0 停止自动摘要和认知提炼；检索与已有摘要仍可使用。</small></label></div><div class="row memory-actions"><label><input type="checkbox" name="enabled" ${settings.enabled !== false ? "checked" : ""}>启用自动记忆召回</label><div class="spacer"></div><button class="btn primary small" type="submit">保存记忆设置</button></div></form><div class="memory-usage"><p>聊天累计：${e(usageText(usage.chat))}</p><p>记忆整理累计：${e(usageText(usage.memory))}</p><small class="muted">累计从启用新版记忆系统后开始，按服务返回用量统计；与上方单次上下文占用分开，未报告用量的请求无法计入准确 token。</small></div></details>`;
}
function renderSpaces(s, data) {
  const joined = new Set(joinedSpaces(data).map((space) => space.id));
  return `<div class="panel-header"><div><h2>共享记忆空间</h2><p>当前会话加入后才能检索该空间。原有共享事实继续单独保留；独立事实不会自动共享。</p></div><button class="btn primary small" data-space-create>新建空间</button></div><div class="memory-table">${(data.spaces || []).map((space) => `<div class="memory-item"><div><strong>${e(space.name || space.id)}</strong><small>${e(space.id)} · ${joined.has(space.id) ? "当前会话已加入" : "尚未加入"}</small></div><button class="btn small ${joined.has(space.id) ? "" : "tonal"}" data-space-toggle="${e(space.id)}" data-space-joined="${joined.has(space.id)}">${joined.has(space.id) ? "退出空间" : "加入空间"}</button></div>`).join("") || '<p class="empty">暂无共享空间。需要跨会话回忆时再创建并加入。</p>'}</div><p class="muted">加入空间后，可在“记忆检索”中将指定记忆分享到空间。退出只改变当前会话的检索范围，不删除空间内的记录。</p>`;
}
export function bindMemory(app) {
  const root = app.content,
    s = app.state;
  bindContextSettings(app, () => loadMemory(app));
  const loadedSession = s.memoryLoadedSession;
  const assertSession = () => {
    if (loadedSession !== s.session)
      throw Error("当前会话已切换，请重新读取后操作");
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
  if (knowledgeSearch)
    knowledgeSearch.onsubmit = (event) => {
      event.preventDefault();
      const data = new FormData(knowledgeSearch);
      s.knowledgeQuery = data.get("query");
      s.knowledgeArchived = data.has("archived");
      loadMemory(app);
    };
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
        await loadMemory(app);
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
            ? "当前会话已退出空间"
            : "当前会话已加入空间",
        );
      } catch (error) {
        app.toast(error.message, true);
        button.disabled = false;
      }
    };
  });
  root.querySelectorAll("[data-session-use]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await app.useSession(b.dataset.sessionUse);
          await loadMemory(app);
          app.toast("已选为当前会话，可调整上下文后继续聊天");
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
          `<p>删除「${e(item.name || item.id)}」及对应摘要？</p><p>文件会移入本机记忆回收目录，共享事实保留。删除当前会话后会新建空会话。</p>`,
          async () => {
            await api("/api/memory/session/delete", { id: item.id });
            if (s.session === item.id) app.newSession();
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
            "滚动摘要",
            `<pre class="memory-preview">${e(value.text)}</pre>`,
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
          `<p>恢复「${e(b.dataset.restore)}」？当前记忆会先自动备份，之后可恢复该自动备份撤回本次操作。</p><p>记忆目录内的人格文件也会恢复。操作完成后从新会话开始；正在进行的对话会阻止恢复。</p>`,
          async () => {
            const value = await api("/api/memory/restore", {
              id: b.dataset.restore,
            });
            s.memoryFactsDraft = undefined;
            s.localFactsDrafts = Object.create(null);
            s.memoryCatalog = null;
            s.memoryLoadedTab = null;
            await app.load();
            app.newSession();
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
      s.memoryLoadedSession !== s.session)
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
