/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";
import "../../market/assets/catalog-validation.js";

const repositoryKey = value => typeof value === "string" ? value.replace(/\/$/, "").toLowerCase() : "";
const image = url => url
  ? `<img class="community-plugin-image" src="${e(url)}" alt="" hidden decoding="async" referrerpolicy="no-referrer">`
  : "";

export function communityImage(entry) {
  return image(globalThis.whaleLifeCommunityIconURL?.(entry));
}

// Keep the existing artwork visible until the new image actually loads.
export function bindCommunityImages(container) {
  for (const img of container.querySelectorAll(".community-plugin-image")) {
    const update = () => { img.hidden = !img.naturalWidth; };
    img.onload = img.onerror = update;
    if (img.complete) update();
  }
}

function installedIconURL(state, plugin) {
  const catalog = state?.publishedStore || state?.bundledStore;
  const entry = catalog?.community.find(item => item.id === plugin.id);
  const url = entry && globalThis.whaleLifeCommunityIconURL?.(entry);
  if (!url) return null;
  if (plugin.repository != null)
    return repositoryKey(plugin.repository) === repositoryKey(entry.repository) ? url : null;
  // Older packages may omit repository from the manifest. In that case ask the
  // existing package manager to identify the exact installation before using its icon.
  if (!state.communityPlugins) return undefined;
  const installed = state.communityPlugins.find(item => item.id === plugin.id && item.action === "installed" &&
    (item.installedVersion || item.version) === plugin.version && repositoryKey(item.repository) === repositoryKey(entry.repository));
  return installed ? url : null;
}

export function manageIcon(state, plugin, child = false) {
  return `<span class="plugin-card-icon" data-community-icon-slot="${e(plugin.id)}" aria-hidden="true">${child ? "" : icon("puzzle")}${image(installedIconURL(state, plugin))}</span>`;
}

export function paintManageIcons(app) {
  let needsIdentification = false;
  for (const slot of app.content.querySelectorAll("[data-community-icon-slot]")) {
    const plugin = app.state.status?.plugins?.find(p => p.id === slot.dataset.communityIconSlot);
    if (!plugin) continue;
    const url = installedIconURL(app.state, plugin);
    if (url === undefined) needsIdentification = true;
    const current = slot.querySelector("img");
    if ((current?.getAttribute("src") || "") !== (url || "")) {
      current?.remove();
      if (url) slot.insertAdjacentHTML("beforeend", image(url));
    }
  }
  bindCommunityImages(app.content);
  return needsIdentification;
}
