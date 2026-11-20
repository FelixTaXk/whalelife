/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e } from "./api.js";

const repositoryKey = url => typeof url === "string" ? url.replace(/\/$/, "").toLowerCase() : "";

function isInstalled(state, update) {
  return state?.status?.plugins?.some(plugin =>
    !plugin.builtin && plugin.id === update.runtimeId && plugin.version === update.installedVersion &&
    (update.source !== "community" || plugin.repository == null || repositoryKey(plugin.repository) === repositoryKey(update.repository)));
}

export function storeUpdate(state, entry, source) {
  return state.pluginUpdates?.find(update => update.source === source && update.id === entry.id &&
    repositoryKey(update.repository) === repositoryKey(entry.repository) && isInstalled(state, update));
}

export function updateBadge(update) {
  if (!update) return "";
  const versions = `已安装 v${e(update.installedVersion)}，新版 v${e(update.latestVersion)}`;
  return `<span class="plugin-update-badge" title="${versions}">有更新</span>`;
}

function releaseLink(update) {
  try {
    const url = new URL(update.url);
    const repo = new URL(update.repository);
    const releases = repo.pathname.replace(/\/$/, "").toLowerCase() + "/releases";
    const path = url.pathname.toLowerCase();
    if (url.origin === "https://github.com" && repo.origin === url.origin &&
        !url.username && !url.password && (path === releases || path.startsWith(releases + "/"))) {
      return `<a class="plugin-update-link" href="${e(url.href)}" target="_blank" rel="noopener noreferrer">查看新版</a>`;
    }
  } catch {}
  return "";
}

export function updateDetails(update) {
  if (!update) return "";
  return `<p class="plugin-update-detail">已安装 v${e(update.installedVersion)} <span aria-hidden="true">→</span>
    新版 v${e(update.latestVersion)} ${releaseLink(update)}</p>`;
}

function managementNotice(state, runtimeId) {
  const update = state?.pluginUpdates?.find(row => row.runtimeId === runtimeId && isInstalled(state, row));
  return update ? updateBadge(update) + releaseLink(update) : "";
}

export function renderManageUpdate(state, runtimeId) {
  return `<span class="plugin-update-slot" data-plugin-update-runtime="${e(runtimeId)}">${managementNotice(state, runtimeId)}</span>`;
}

function childUpdates(state, parentId) {
  const prefix = parentId + "/";
  const count = state?.pluginUpdates?.filter(row => row.runtimeId.startsWith(prefix) && isInstalled(state, row)).length;
  return count ? `<span class="plugin-update-badge">${count} 个有更新</span>` : "";
}

export function renderChildUpdates(state, parentId) {
  return `<span data-plugin-update-children="${e(parentId)}">${childUpdates(state, parentId)}</span>`;
}

function paintUpdates(app) {
  for (const slot of app.content.querySelectorAll("[data-plugin-update-children]")) {
    slot.innerHTML = childUpdates(app.state, slot.dataset.pluginUpdateChildren);
  }
  for (const slot of app.content.querySelectorAll("[data-plugin-update-runtime]")) {
    const html = managementNotice(app.state, slot.dataset.pluginUpdateRuntime);
    if (slot.innerHTML === html) continue;
    const focused = slot.contains(slot.ownerDocument.activeElement);
    slot.innerHTML = html;
    if (focused) slot.querySelector("a")?.focus({ preventScroll: true });
  }
  app.content.ownerDocument.getElementById("plugin-store")?.dispatchEvent(new Event("plugin-updates"));
}

export async function loadPluginUpdates(app) {
  const plugins = app.state.status?.plugins;
  if (!Array.isArray(plugins)) return;
  const key = JSON.stringify(plugins.filter(p => !p.builtin).map(p => [p.id, p.version, repositoryKey(p.repository)]).sort());
  const previous = app.pluginUpdateRead;
  if (previous?.key === key && Date.now() < previous.nextRead) return;
  // Frequent console renders share this read. A changed installation may start a fresh one.
  const read = { key, nextRead: Infinity };
  app.pluginUpdateRead = read;
  try {
    const { updates } = await api("/api/plugin-updates");
    if (app.pluginUpdateRead !== read || !Array.isArray(updates)) return;
    if (JSON.stringify(updates) !== JSON.stringify(app.state.pluginUpdates ?? [])) {
      app.state.pluginUpdates = updates;
      paintUpdates(app);
    }
    read.nextRead = Date.now() + 5 * 60_000;
  } catch {
    // Release availability is independent of local plugin management.
  } finally {
    if (read.nextRead === Infinity) read.nextRead = Date.now() + 60_000;
  }
}
