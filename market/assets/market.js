/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
"use strict";

let catalog = window.WHALELIFE_CATALOG;
const viewLinks = Array.from(document.querySelectorAll("[data-view]"));
const results = document.querySelector("#results");
const template = document.querySelector("#plugin-card");
const sort = document.querySelector("#community-sort");
const submission = document.querySelector("#submission");

function makeCard(plugin, isOfficial, pluginNames) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.dataset.plugin = plugin.id;
  const glyphs = window.WHALELIFE_SYMBOLS;
  card.querySelector(".glyph").innerHTML = isOfficial && Object.hasOwn(glyphs, plugin.id)
    ? glyphs[plugin.id] : glyphs.generic;
  card.querySelector(".kind").textContent = isOfficial ? "官方" : "社区";
  card.querySelector("h2").textContent = plugin.name;
  const version = window.whaleLifeCatalogVersion(plugin, window.WHALELIFE_CATALOG[isOfficial ? "official" : "community"]);
  card.querySelector(".version").textContent = version ? "收录版本 v" + version : "版本未提供";
  card.querySelector(".author").textContent = "作者 · " + plugin.author;
  card.querySelector(".description").textContent = plugin.description;
  if (plugin.dependencies?.length) {
    const dependency = card.querySelector(".dependency");
    dependency.textContent = "依赖 · " + plugin.dependencies.map(id => pluginNames.get(id) || id).join("、");
    dependency.hidden = false;
  }
  for (const [selector, address] of [
    [".install", plugin.installation], [".repo", plugin.repository], [".feedback", plugin.feedback]
  ]) {
    const link = card.querySelector(selector);
    link.href = address;
    link.setAttribute("aria-label", plugin.name + " · " + link.textContent);
  }
  return card;
}

function communityEntries() {
  return [...catalog.community].sort((a, b) => {
    if (sort.value === "stars" && a.stars !== b.stars) return b.stars - a.stars;
    return b.collected.localeCompare(a.collected) || a.id.localeCompare(b.id);
  });
}

function showView() {
  const view = viewLinks.find(link => link.hash === location.hash)?.dataset.view || "all";
  for (const link of viewLinks) {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  sort.closest("label").hidden = view === "official" || catalog.community.length < 2;
  const cards = [];
  const pluginNames = new Map([...catalog.official, ...catalog.community].map(plugin => [plugin.id, plugin.name]));
  if (view !== "community") cards.push(...catalog.official.map(plugin => makeCard(plugin, true, pluginNames)));
  if (view !== "official") cards.push(...communityEntries().map(plugin => makeCard(plugin, false, pluginNames)));
  results.replaceChildren(...cards);
  if (!cards.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const title = document.createElement("h2");
    title.textContent = "暂无收录的社区插件";
    const description = document.createElement("p");
    description.textContent = "作者可以通过「提交插件」申请收录。";
    empty.append(title, description);
    results.append(empty);
  }
}

async function refreshPublishedCatalog() {
  // Only display metadata is refreshed. Executable assets and install approvals stay local.
  try {
    const response = await fetch("https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json", {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const published = await response.json();
    if (window.isWhaleLifeCatalog(published) && JSON.stringify(published) !== JSON.stringify(catalog)) {
      catalog = published;
      showView();
    }
  } catch {
    // The bundled catalog has already rendered and remains usable offline.
  }
}

if (["/market/", "/market/index.html"].includes(location.pathname)) {
  const home = document.querySelector("#project-home");
  home.href = "/#market";
  home.textContent = "在 WhaleLife 中打开";
}
document.querySelector("#open-submission").addEventListener("click", () => submission.showModal());
sort.addEventListener("change", showView);
window.addEventListener("hashchange", showView);
showView();
if (location.protocol !== "file:") void refreshPublishedCatalog();
