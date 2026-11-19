/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";

const glyphs = { qq: "chat", qzone: "persona", autonomy: "bolt", gallery: "grid", surf: "send", bilibili: "terminal", vision: "eye" };
const stepNames = { install: "安装", enable: "启用", reuse: "沿用", uninstall: "卸载" };

function githubLink(url, label, title = label) {
  try {
    const target = new URL(url);
    if (target.origin === "https://github.com" && !target.username && !target.password)
      return `<a href="${e(target.href)}" target="_blank" rel="noopener noreferrer" aria-label="${e(title)}" title="${e(title)}">${e(label)}${icon("arrow")}</a>`;
  } catch {}
  return "";
}

function officialRow(plugin, state) {
  const { id, name, installed, enabled, status, description } = plugin;
  const action = installed ? "uninstall" : "install";
  const verb = installed ? "卸载" : "安装";
  const version = installed ? plugin.installedVersion : plugin.version;
  const preference = enabled ? "已启用" : "已停用";
  const fault = status === "failed" ? "加载失败" : status === "blocked" ? "等待依赖" : "";
  const statusLabel = installed ? fault || preference : "未安装";
  const busy = state.officialBusy === id;
  return `<article class="official-row" data-official-id="${e(id)}">
    <span class="official-glyph" aria-hidden="true">${icon(glyphs[id] || "puzzle")}</span>
    <div class="official-summary"><h2>${githubLink(plugin.installation, name, name + "安装说明") || e(name)}</h2>
      <p>${e(description)}</p></div>
    <div class="official-meta"><span class="official-state" data-state="${installed ? e(status || (enabled ? "active" : "stopped")) : ""}"${fault ? ` title="开关${preference}"` : ""}>${statusLabel}</span>
      ${version ? `<span class="official-version" aria-label="${installed ? "已安装版本" : "安装版本"} v${e(version)}">v${e(version)}</span>` : ""}</div>
    <button type="button" class="btn small ${installed ? "official-remove" : "tonal"}" data-official-action="${action}"
      aria-label="${e(verb + " " + name)}" ${state.officialBusy ? "disabled" : ""}>${busy ? (installed ? "卸载中…" : "安装中…") : verb}</button>
  </article>`;
}

export function renderOfficialShelf(state) {
  if (state.officialReadError) return `<div class="official-loading" role="alert">${e(state.officialReadError)} <button class="btn small" type="button" data-official-retry>重新读取</button></div>`;
  if (!state.officialPlugins) return '<p class="official-loading" role="status">正在读取官方插件…</p>';
  return state.officialPlugins.length
    ? `<div class="panel official-list">${state.officialPlugins.map(plugin => officialRow(plugin, state)).join("")}</div>`
    : '<p class="official-loading">暂无已验证的官方插件。</p>';
}

function failureMessage(error) {
  const changes = error.rolledBack;
  return error.message + (changes?.length ? "\n\n已撤回的改动\n" + changes.join("\n") : "");
}

export function bindOfficialShelf(app) {
  const { content, state } = app;
  const shelf = content.querySelector("#official-shelf");
  const panels = { official: shelf, installed: content.querySelector("#installed-plugins") };
  const switches = content.querySelectorAll("[data-plugin-view]");

  function paint() {
    // Retain keyboard focus when a background read updates the active card.
    const focused = shelf.ownerDocument.activeElement;
    const id = shelf.contains(focused) && focused.closest("[data-official-id]")?.dataset.officialId;
    shelf.innerHTML = renderOfficialShelf(state);
    if (id) {
      const card = [...shelf.querySelectorAll("[data-official-id]")].find(item => item.dataset.officialId === id);
      (card?.querySelector("[data-official-action]:enabled") || card)?.focus({ preventScroll: true });
    }
  }

  async function refresh() {
    if (state.officialBusy) return;
    const read = app.officialRead || (app.officialRead = api("/api/official-plugins").finally(() => {
      if (app.officialRead === read) app.officialRead = null;
    }));
    try {
      const { plugins } = await read;
      if (!shelf.isConnected || state.officialBusy) return;
      if (!Array.isArray(plugins)) throw Error("官方插件目录格式有误");
      const changed = state.officialReadError || JSON.stringify(state.officialPlugins) !== JSON.stringify(plugins);
      state.officialPlugins = plugins;
      state.officialReadError = "";
      if (changed) paint();
    } catch (error) {
      if (!shelf.isConnected || state.officialBusy) return;
      state.officialPlugins = null;
      state.officialReadError = `无法读取官方插件目录。${error.message}`;
      paint();
    }
  }

  for (const button of switches) button.onclick = () => {
    const view = button.dataset.pluginView;
    state.pluginView = view;
    for (const tab of switches) tab.setAttribute("aria-pressed", String(tab === button));
    for (const [key, panel] of Object.entries(panels)) panel.hidden = view !== key;
    if (view === "official") void refresh();
  };

  function openDialog(plugin, title, body, submit, label, danger) {
    app.dialog(title, body, submit, label, danger);
    // Refresh can redraw the rows while the native modal holds keyboard focus.
    shelf.ownerDocument.getElementById("dialog")?.addEventListener("close", () => {
      if (state.page !== "plugins") return;
      const focused = shelf.ownerDocument.activeElement;
      if (focused?.isConnected && focused !== shelf.ownerDocument.body) return;
      const row = [...content.querySelectorAll("#official-shelf:not([hidden]) [data-official-id]")].find(el => el.dataset.officialId === plugin.id);
      row?.querySelector("[data-official-action]:enabled")?.focus({ preventScroll: true });
    }, { once: true });
  }

  async function apply(plugin) {
    if (state.officialBusy) throw Error("另一个插件操作正在进行。");
    state.officialBusy = plugin.id;
    app.officialRead = null;
    paint();
    try {
      const result = await api("/api/official-plugins/apply", { id: plugin.id, action: plugin.action, planKey: plugin.planKey });
      if (!result.ok) throw Object.assign(Error(result.error || result.message || "插件操作失败。"), { rolledBack: result.rolledBack });
      app.toast(result.message);
    } finally {
      try { await app.refreshStatus(); } catch (error) { app.toast(error.message, true); }
      state.officialBusy = null;
      if (state.page === "plugins") app.render();
    }
  }

  shelf.onclick = async event => {
    if (state.officialBusy) return;
    if (event.target.closest("[data-official-retry]")) return refresh();
    const button = event.target.closest("[data-official-action]");
    if (!button || button.disabled) return;
    const id = button.closest("[data-official-id]").dataset.officialId;
    const plugin = state.officialPlugins?.find(item => item.id === id);
    if (!plugin) return refresh();
    const action = button.dataset.officialAction;
    const verb = action === "uninstall" ? "卸载" : "安装";
    if (plugin.reason || plugin.action !== action || !plugin.planKey) {
      const reason = plugin.reason || "插件状态已更新，请重新查看后再操作。";
      const upgrade = githubLink(plugin.upgradeUrl, "查看升级说明");
      openDialog(plugin, "暂时无法" + verb + " " + plugin.name,
        `<p class="official-dialog-text">${e(reason)}</p>${upgrade ? `<p class="official-help">${upgrade}</p>` : ""}`);
      return;
    }
    const steps = plugin.steps || [];
    if (action === "uninstall" || steps.some(step => step.id !== id)) {
      const body = action === "uninstall"
        ? '<p class="official-dialog-text">只移除这个插件的程序文件。配置和用户资料会保留，重新安装后可以继续使用。</p>'
        : `<ul class="official-plan">${steps.map(step => `<li><span>${e(stepNames[step.action])}</span><strong>${e(step.name)}</strong><small>v${e(step.version)}</small></li>`).join("")}</ul>`;
      openDialog(plugin, verb + " " + plugin.name, body, async () => {
        try { await apply(plugin); } catch (error) { throw Error(failureMessage(error)); }
      }, e(plugin.label || verb), action === "uninstall");
      return;
    }
    try { await apply(plugin); }
    catch (error) {
      if (state.page === "plugins") openDialog(plugin, verb + " " + plugin.name + "失败",
        `<p class="official-dialog-text">${e(failureMessage(error))}</p>`);
      else app.toast(failureMessage(error), true);
    }
  };
  if (!shelf.hidden) void refresh();
}
