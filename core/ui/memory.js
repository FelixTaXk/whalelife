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
  ["facts", "共享事实"],
  ["sessions", "会话档案"],
  ["summaries", "滚动摘要"],
  ["backups", "备份与恢复"],
];

export async function loadMemory(app) {
  const tab = app.state.memoryTab || "facts";
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
      tab === "sessions" ? Promise.resolve(null) : api("/api/memory/" + tab),
      api(
        "/api/session/context?id=" + encodeURIComponent(app.state.session),
      ).catch((error) => ({ error: error.message })),
    ]);
    if (request !== app.state.memoryRequest) return;
    app.state.memoryCatalog = catalog;
    app.state.sessionContext = context;
    app.state.memoryDetails = details;
    app.state.memoryLoadedTab = tab;
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
  return `<div class="page-heading"><div><div class="eyebrow">MEMORY</div><h1>记忆管理</h1><p>查看共享事实、会话档案和滚动摘要，管理本机备份。</p></div><div class="heading-actions"><button class="btn" data-memory-refresh ${s.memoryLoading ? "disabled" : ""}>${icon("refresh")}刷新</button><button class="btn primary" data-memory-backup>${icon("database")}创建备份</button></div></div>
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
    <section class="panel panel-body memory-panel">${s.memoryLoadedTab !== tab ? '<p class="empty">正在读取记忆…</p>' : renderTab(app, tab)}</section>`;
}
function renderTab(app, tab) {
  const s = app.state,
    data = s.memoryDetails;
  if (tab === "facts")
    return `<div class="panel-header"><div><h2>共享事实</h2><p>每行一条事实，保存后用于下一轮对话。与所有人格共享。</p></div><button class="btn small" data-facts-dedupe>去除重复行</button></div><textarea id="memory-facts" aria-label="共享事实内容" rows="14" spellcheck="false">${e(s.memoryFactsDraft)}</textarea><div class="row memory-actions"><small id="facts-state">编辑后点击保存；不会自动改写。</small><div class="spacer"></div><button class="btn" data-facts-reload>重新读取</button><button class="btn primary" data-facts-save>保存事实</button></div>`;
  if (tab === "sessions") {
    const list = s.memoryCatalog.sessions;
    return `<form id="memory-search-form" class="row"><input name="search" type="search" aria-label="搜索会话" placeholder="搜索名称、会话 ID 或内容" value="${e(s.memorySearch || "")}"><button class="btn" type="submit">搜索</button></form><div class="memory-table">${list.items.map((item) => `<div class="memory-item"><div><strong>${e(item.name || item.id)} ${item.id === s.session ? '<span class="badge green">当前会话</span>' : ""}</strong><small>${item.name ? e(item.id) + " · " : ""}${time(item.updated_at)} · ${bytes(item.bytes)}</small><small title="${e(item.last_persona?.id || "")}">最后使用人格：${e(item.last_persona?.name || "未记录")}</small></div><div class="row session-actions"><button class="btn small" data-session="${e(item.id)}">查看</button><button class="btn small tonal" data-session-use="${e(item.id)}" ${s.chatBusy ? "disabled" : ""}>设为当前会话</button><button class="btn small" data-session-rename="${e(item.id)}">改名</button><button class="btn small danger" data-session-delete="${e(item.id)}">删除</button></div></div>`).join("") || '<p class="empty">暂无匹配的会话。</p>'}</div><div class="row memory-actions"><small>共 ${list.total} 个匹配会话</small><div class="spacer"></div><button class="btn small" data-memory-prev ${list.offset === 0 ? "disabled" : ""}>上一页</button><button class="btn small" data-memory-next ${list.offset + list.limit >= list.total ? "disabled" : ""}>下一页</button></div>`;
  }
  if (tab === "summaries")
    return `<h2>滚动摘要</h2><p class="muted">对话达到阈值后自动生成，按会话及人格版本隔离。这里只查看已生成内容。</p><div class="memory-table">${data.items.map((item) => `<div class="memory-item"><div><strong>${e(item.id)}</strong><small>${time(item.updated_at)} · ${bytes(item.bytes)}</small></div><button class="btn small" data-summary="${e(item.id)}">查看摘要</button></div>`).join("") || '<p class="empty">尚未生成摘要，短会话不会产生滚动摘要。</p>'}</div>`;
  return `<h2>本机备份</h2><p class="muted">完整保存记忆目录，包含目录内的人格文件。恢复前自动备份当前数据；不覆盖模型配置和密钥。</p><p class="memory-location">备份位置：${e(data.directory)}</p><div class="memory-table">${data.items.map((item) => `<div class="memory-item"><div><strong>${e(item.id)}</strong><small>${time(item.created_at)} · ${item.files || 0} 个文件 · ${bytes(item.bytes || 0)} · ${item.kind === "before-restore" ? "恢复前自动备份" : "手动备份"}</small>${item.error ? `<p class="form-error">${e(item.error)}</p>` : ""}</div><button class="btn small" data-restore="${e(item.id)}" ${!item.valid || s.chatBusy || s.memoryCatalog.busy ? "disabled" : ""}>恢复此备份</button></div>`).join("") || '<p class="empty">暂无备份，点击右上方“创建备份”。</p>'}</div>`;
}
export function bindMemory(app) {
  const root = app.content,
    s = app.state;
  bindContextSettings(app, () => loadMemory(app));
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
    s.memoryLoadedTab !== (s.memoryTab || "facts")
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
