/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";

const glyphs = { qq: "chat", qzone: "persona", autonomy: "bolt", gallery: "grid", surf: "send", bilibili: "terminal", vision: "eye" };
const stepNames = { install: "安装", enable: "启用", reuse: "沿用", uninstall: "卸载" };

function githubLink(url, label) {
  try {
    const target = new URL(url);
    if (target.origin === "https://github.com" && !target.username && !target.password)
      return `<a href="${e(target.href)}" target="_blank" rel="noopener noreferrer">${e(label)}${icon("arrow")}</a>`;
  } catch {}
  return "";
}

function resultMessage(result) {
  if (!result) return "";
  return `<div class="official-result ${result.error ? "failed" : "succeeded"}" role="${result.error ? "alert" : "status"}">
    ${icon(result.error ? "info" : "check")}<div><strong>${e(result.message)}</strong>
    ${result.rolledBack?.length ? `<p>已撤回的改动</p><ul>${result.rolledBack.map(item => `<li>${e(item)}</li>`).join("")}</ul>` : ""}
    </div></div>`;
}

function officialCard(plugin, state) {
  const { id, name, version, installedVersion, installed, enabled, status, description, action, label, steps = [], reason, planKey } = plugin;
  const busy = state.officialBusy;
  const preference = enabled ? "已启用" : "已停用";
  const runtimeState = status === "failed" ? "加载失败" : status === "blocked" ? "等待依赖" : "";
  const statusLabel = installed ? "已安装 · " + (runtimeState || preference) : "未安装";
  const stateClass = installed && runtimeState ? "is-" + status : installed && enabled ? "is-installed" : "";
  const versionLabel = installed ? installedVersion : version;
  const dependencies = steps.filter(step => step.id !== id);
  return `<article class="official-card" data-official-id="${e(id)}" tabindex="-1">
    <header><span class="official-glyph">${icon(glyphs[id] || "puzzle")}</span>
      <div class="official-title"><h2>${e(name)}</h2><span class="official-state ${stateClass}">${statusLabel}</span>${installed && runtimeState ? `<span class="official-preference">开关${preference}</span>` : ""}</div>
    </header>
    <p class="official-description">${e(description)}</p>
    ${dependencies.length ? `<ul class="official-steps" aria-label="依赖处理计划">${dependencies.map(step =>
      `<li><strong>${e(stepNames[step.action])}</strong> ${e(step.name)}${step.version ? ` <span>v${e(step.version)}</span>` : ""}</li>`).join("")}</ul>` : ""}
    ${reason ? `<div class="official-reason">${icon("info")}<div>${e(reason)} ${githubLink(plugin.upgradeUrl, "查看升级说明")}</div></div>` : ""}
    <footer>
      <div class="official-links">${githubLink(plugin.installation, "安装说明")}</div>
      <div class="official-operation">
        ${versionLabel ? `<span class="official-version" aria-label="${installed ? "已安装版本" : "安装版本"} v${e(versionLabel)}">v${e(versionLabel)}</span>` : ""}
        ${(action === "install" || action === "uninstall") && planKey
          ? `<button type="button" class="btn small ${action === "install" ? "primary" : "official-uninstall"}" data-official-action="${action}" data-key="${e(planKey)}" ${busy ? "disabled" : ""}>${icon(action === "install" ? "download" : "trash")}${busy === id ? (action === "install" ? "正在安装…" : "正在卸载…") : e(label)}</button>`
          : `<span class="official-unavailable">${installed ? "暂不可卸载" : "暂不可安装"}</span>`}
      </div>
    </footer>
    ${state.officialResult?.id === id ? resultMessage(state.officialResult) : ""}
  </article>`;
}

export function renderOfficialShelf(state) {
  const items = state.officialPlugins;
  const note = `<p class="official-data-note">${icon("database")}<span>卸载保留配置和个人资料，包括图库图片和标签。</span></p>`;
  if (state.officialReadError) return note + resultMessage(state.officialResult)
    + `<div class="official-loading" role="alert">${e(state.officialReadError)} <button class="btn small" type="button" data-official-retry>重新读取</button></div>`;
  if (!items) return note + resultMessage(state.officialResult)
    + '<div class="official-loading" role="status">正在核对本机插件与官方版本…</div>';
  return note + (items.length ? `<div class="official-grid">${items.map(plugin => officialCard(plugin, state)).join("")}</div>`
    : '<div class="official-loading">暂无已验证的官方插件。</div>');
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

  shelf.onclick = async event => {
    if (state.officialBusy) return;
    if (event.target.closest("[data-official-retry]")) return refresh();
    const button = event.target.closest("[data-official-action]");
    if (!button || button.disabled) return;
    const id = button.closest("[data-official-id]").dataset.officialId;
    const { officialAction: action, key: planKey } = button.dataset;
    state.officialBusy = id;
    state.officialResult = null;
    app.officialRead = null;
    paint();
    try {
      const result = await api("/api/official-plugins/apply", { id, action, planKey });
      state.officialResult = { id, message: result.message, rolledBack: result.rolledBack, error: !result.ok };
    } catch (error) {
      state.officialResult = { id, message: error.message, rolledBack: error.rolledBack, error: true };
    } finally {
      try { await app.refreshStatus(); } catch (error) { app.toast(error.message, true); }
      state.officialPlugins = null;
      state.officialBusy = null;
      if (state.page === "plugins") app.render();
    }
  };
  if (!shelf.hidden) void refresh();
}
