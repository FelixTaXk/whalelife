/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e } from "./api.js";

const stepNames = { install: "安装", enable: "启用", reuse: "沿用", uninstall: "卸载" };
export const officialBadge = '<span class="store-official-badge">官方</span>';

function upgradeLink(url) {
  try {
    const target = new URL(url);
    if (target.origin === "https://github.com" && !target.username && !target.password)
      return `<p class="official-help"><a href="${e(target.href)}" target="_blank" rel="noopener noreferrer">查看升级说明</a></p>`;
  } catch {}
  return "";
}

function actionButton(state, plugin, action) {
  const install = action === "install";
  const verb = install ? "安装" : "卸载";
  const label = state.officialBusy === plugin.id ? verb + "中…" : verb;
  return `<button type="button" class="btn small ${install ? "tonal" : "official-remove"}" data-official-id="${e(plugin.id)}" data-official-action="${action}" aria-label="${e(verb + " " + plugin.name)}" ${state.officialBusy ? "disabled" : ""}>${label}</button>`;
}

// The catalog may include newer public entries. Only the host can supply a verified install plan.
export function renderStoreInstall(state, id) {
  const plugin = state.officialPlugins?.find(item => item.id === id);
  if (!plugin) return state.officialPlugins ? '<span class="official-version">本机尚无已验证版本</span>' : "";
  const version = plugin.installed ? plugin.installedVersion : plugin.version;
  const versionTag = version ? `<span class="official-version" aria-label="${plugin.installed ? "已安装" : "安装"}版本 v${e(version)}">v${e(version)}</span>` : "";
  return versionTag + (plugin.installed ? '<span class="official-installed">已安装</span>' : actionButton(state, plugin, "install"));
}

function installedPlugin(state, runtimeId) {
  return state?.officialPlugins?.find(item => item.installed && item.runtimeId === runtimeId);
}

function removeButton(state, runtimeId) {
  const plugin = installedPlugin(state, runtimeId);
  return plugin ? actionButton(state, plugin, "uninstall") : "";
}

function installedBadge(state, runtimeId) {
  const recognized = state?.recognizedRuntimeIds?.includes(runtimeId) ?? installedPlugin(state, runtimeId)?.recognized;
  return recognized ? officialBadge : "";
}

export function renderManageBadgeSlot(state, runtimeId) {
  return `<span data-official-badge-slot="${e(runtimeId)}">${installedBadge(state, runtimeId)}</span>`;
}

export function renderManageSlot(state, runtimeId) {
  return `<span class="official-manage-slot" data-official-manage-slot="${e(runtimeId)}">${removeButton(state, runtimeId)}</span>`;
}

function paintSlots(content, state) {
  for (const slot of content.querySelectorAll("[data-official-badge-slot]")) {
    slot.innerHTML = installedBadge(state, slot.dataset.officialBadgeSlot);
  }
  for (const slot of content.querySelectorAll("[data-official-store-slot], [data-official-manage-slot]")) {
    const focused = slot.contains(content.ownerDocument.activeElement);
    slot.innerHTML = slot.hasAttribute("data-official-manage-slot")
      ? removeButton(state, slot.dataset.officialManageSlot) : renderStoreInstall(state, slot.dataset.officialStoreSlot);
    if (focused) slot.querySelector("button:enabled")?.focus({ preventScroll: true });
  }
  for (const slot of content.querySelectorAll("[data-official-read-status]")) {
    slot.innerHTML = state.officialReadError
      ? `${e(state.officialReadError)} <button class="btn small" type="button" data-official-retry>重试</button>` : "";
  }
}

function paint(app) {
  paintSlots(app.content, app.state);
  const drawer = app.content.ownerDocument.getElementById("store-drawer");
  if (drawer?.open) {
    paintSlots(drawer, app.state);
    app.storeOfficialChange?.();
  }
}

async function refresh(app, redraw = false) {
  if (app.officialRead || app.state.officialBusy) return;
  const read = api("/api/official-plugins");
  app.officialRead = read;
  try {
    const { plugins, recognizedRuntimeIds } = await read;
    if (app.officialRead !== read) return;
    if (!Array.isArray(plugins)) throw Error("官方插件状态格式有误");
    app.state.officialPlugins = plugins;
    app.state.recognizedRuntimeIds = Array.isArray(recognizedRuntimeIds) ? recognizedRuntimeIds : null;
    app.state.officialReadError = "";
  } catch (error) {
    if (app.officialRead !== read) return;
    app.state.officialPlugins = null;
    app.state.recognizedRuntimeIds = null;
    app.state.officialReadError = "无法读取本机插件版本。" + error.message;
  } finally {
    if (app.officialRead === read) {
      try {
        // Rebind against this snapshot so rendering the page does not start another disk scan.
        if (redraw && (app.state.page === "plugins" || app.state.page === "overview")) {
          if (app.content.ownerDocument.getElementById("store-drawer")?.open) app.storeNeedsRefresh = true;
          else app.render();
        }
        paint(app);
      } finally {
        app.officialRead = null;
      }
    }
  }
}

function openDialog(app, plugin, title, body, submit, label, danger) {
  const page = app.state.page, doc = app.content.ownerDocument;
  app.dialog(title, body, submit, label, danger);
  doc.getElementById("dialog")?.addEventListener("close", () => {
    if (app.state.page !== page || (doc.activeElement?.isConnected && doc.activeElement !== doc.body)) return;
    const drawer = doc.getElementById("store-drawer");
    const buttons = (drawer?.open ? drawer : app.content).querySelectorAll("[data-official-action]:enabled");
    [...buttons].find(b => b.dataset.officialId === plugin.id)?.focus({ preventScroll: true });
  }, { once: true });
}

function failureMessage(error) {
  const changes = error.rolledBack;
  return error.message + (changes?.length ? "\n\n已撤回的改动\n" + changes.join("\n") : "");
}

async function apply(app, plugin) {
  const { state, content } = app;
  if (state.officialBusy) throw Error("另一个插件操作正在进行。");
  state.officialBusy = plugin.id;
  app.officialRead = null;
  paint(app);
  let applied = false;
  try {
    const result = await api("/api/official-plugins/apply", { id: plugin.id, action: plugin.action, planKey: plugin.planKey });
    if (!result.ok) throw Object.assign(Error(result.error || result.message || "插件操作失败。"), { rolledBack: result.rolledBack });
    applied = true;
    app.toast(result.message);
  } finally {
    try { await app.refreshStatus(); } catch (error) { app.toast(error.message, true); }
    state.officialBusy = null;
    const workspace = content.querySelector(".plugin-workspace");
    if (applied && plugin.action === "uninstall" && workspace?.dataset.runtimeId === plugin.runtimeId) {
      state.officialPlugins = null;
      state.recognizedRuntimeIds = null;
      content.ownerDocument.defaultView.location.hash = "#plugins";
    } else await refresh(app, true);
  }
}

async function handleClick(app, event) {
  if (app.state.officialBusy) return;
  if (event.target.closest("[data-official-retry]")) return refresh(app);
  const button = event.target.closest("[data-official-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.officialAction;
  // A management card and a store listing have distinct authorities.
  const slot = button.closest(action === "install" ? "[data-official-store-slot]" : "[data-official-manage-slot]");
  const plugin = app.state.officialPlugins?.find(item => item.id === button.dataset.officialId);
  if (!slot || !plugin || (action === "install" ? slot.dataset.officialStoreSlot !== plugin.id || plugin.installed
    : action !== "uninstall" || slot.dataset.officialManageSlot !== plugin.runtimeId || !plugin.installed)) return refresh(app);
  const verb = action === "uninstall" ? "卸载" : "安装";
  if (plugin.reason || plugin.action !== action || !plugin.planKey) {
    const reason = plugin.reason || "插件状态已更新，请重新查看后再操作。";
    openDialog(app, plugin, "暂时无法" + verb + " " + plugin.name,
      `<p class="official-dialog-text">${e(reason)}</p>${upgradeLink(plugin.upgradeUrl)}`);
    return;
  }
  const steps = plugin.steps || [];
  if (action === "uninstall" || steps.some(step => step.id !== plugin.id)) {
    const body = action === "uninstall"
      ? '<p class="official-dialog-text">只移除这个插件的程序文件。配置和用户资料会保留，重新安装后可以继续使用。</p>'
      : `<ul class="official-plan">${steps.map(step => `<li><span>${e(stepNames[step.action])}</span><strong>${e(step.name)}</strong><small>v${e(step.version)}</small></li>`).join("")}</ul>`;
    openDialog(app, plugin, verb + " " + plugin.name, body, async () => {
      try { await apply(app, plugin); } catch (error) { throw Error(failureMessage(error)); }
    }, e(plugin.label || verb), action === "uninstall");
    return;
  }
  const page = app.state.page;
  try { await apply(app, plugin); }
  catch (error) {
    if (app.state.page === page) openDialog(app, plugin, verb + " " + plugin.name + "失败",
      `<p class="official-dialog-text">${e(failureMessage(error))}</p>`);
    else app.toast(failureMessage(error), true);
  }
}

export function bindOfficialActions(app, root = app.content, readPlan = true) {
  // Delegate from either the management page or the open store.
  app.officialActionClick ??= event => handleClick(app, event);
  root.addEventListener("click", app.officialActionClick);
  if (readPlan) void refresh(app);
}
