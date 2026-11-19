/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";
import { bindOfficialActions, renderStoreInstall } from "./official-plugins.js";

const bundledURL = "/market/catalog.json";
const publishedURL = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json";
const submissionURL = "https://github.com/iinukami/whalelife/issues/new?template=submit-plugin.yml";
const views = { all: "全部", official: "官方", community: "社区" };
const glyphs = { qq: "chat", qzone: "persona", autonomy: "bolt", gallery: "grid", surf: "send", bilibili: "terminal", vision: "eye" };

async function readCatalog(url) {
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error("获取插件目录失败");
  const catalog = await response.json();
  if (!globalThis.isWhaleLifeCatalog(catalog)) throw Error("插件目录格式有误");
  return catalog;
}

function externalLink(url, text) {
  return `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(text)}</a>`;
}

function entryRow(entry, official, names, state) {
  const dependencies = entry.dependencies.map(id => names.get(id) || id).join("、");
  const local = official && state.bundledStore?.official.find(item => item.id === entry.id && item.repository === entry.repository && item.name === entry.name);
  const links = [
    externalLink(entry.installation, "安装说明"),
    externalLink(entry.repository, "原仓库 · 加星"),
    externalLink(entry.feedback, "反馈问题"),
  ].join("");
  const action = local
    ? `<span class="store-action" data-official-store-slot="${e(entry.id)}">${renderStoreInstall(state, entry.id)}</span>`
    : `<a class="btn small store-action" href="${e(entry.installation)}" target="_blank" rel="noopener noreferrer">安装说明</a>`;
  return `<article class="store-entry" data-store-entry="${e(entry.id)}">
    <details${state.storeExpanded?.has(entry.id) ? " open" : ""}>
      <summary><span class="store-glyph" aria-hidden="true">${icon(official && Object.hasOwn(glyphs, entry.id) ? glyphs[entry.id] : "puzzle")}</span>
        <span class="store-summary"><span class="store-name">${e(entry.name)} ${icon("chevron")}</span>
        <span class="store-description">${e(entry.description)}</span></span></summary>
      <div class="store-details"><p>作者 · ${e(entry.author)}${dependencies ? `<span>依赖 · ${e(dependencies)}</span>` : ""}</p>
        <nav aria-label="${e(entry.name)}相关链接">${links}</nav></div>
    </details>${action}</article>`;
}

function results(state) {
  const catalog = state.publishedStore || state.bundledStore;
  if (!catalog) return state.storeReadError
    ? '<div class="official-loading" role="alert">无法读取插件目录 <button type="button" class="btn small" data-store-retry>重试</button></div>'
    : '<p class="official-loading" role="status">正在读取插件目录…</p>';
  const names = new Map([...catalog.official, ...catalog.community].map(entry => [entry.id, entry.name]));
  const sections = [];
  for (const [type, heading] of [["official", "官方插件"], ["community", "社区插件"]]) {
    if (state.storeView && state.storeView !== "all" && state.storeView !== type) continue;
    const entries = [...catalog[type]];
    if (type === "community") entries.sort((a, b) => {
      if (state.storeSort !== "date" && a.stars !== b.stars) return b.stars - a.stars;
      return b.collected.localeCompare(a.collected) || a.id.localeCompare(b.id);
    });
    if (!entries.length) {
      if (state.storeView === type) sections.push(`<p class="panel store-empty">${type === "community" ? "暂无收录的社区插件" : "暂无收录的官方插件"}</p>`);
      continue;
    }
    sections.push(`<section aria-label="${heading}" class="store-section">${!state.storeView || state.storeView === "all" ? `<h2>${heading}</h2>` : ""}
      <div class="panel store-list">${entries.map(entry => entryRow(entry, type === "official", names, state)).join("")}</div></section>`);
  }
  return sections.join("") || '<p class="panel store-empty">暂无收录的插件</p>';
}

export function renderStore(app) {
  const state = app.state, current = state.storeView || "all";
  const catalog = state.publishedStore || state.bundledStore;
  return `<div id="plugin-store">
    <header class="page-heading plugin-hub-heading"><h1>插件商店</h1>
      <button type="button" class="btn" data-store-submit>提交插件</button></header>
    <div class="store-toolbar"><nav aria-label="插件分类">${Object.entries(views).map(([key, name]) =>
      `<button type="button" data-store-view="${key}" aria-pressed="${current === key}">${name}</button>`).join("")}</nav>
      <label class="store-sort"${current === "official" || !(catalog?.community.length > 1) ? " hidden" : ""}>社区排序
      <select data-store-sort><option value="stars">GitHub 星标</option><option value="date"${state.storeSort === "date" ? " selected" : ""}>最近收录</option></select></label></div>
    <div data-official-read-status role="status"></div>
    <div data-store-results>${results(state)}</div>
    <footer class="store-footer">交流 QQ 群 <span>962935021</span></footer></div>`;
}

export async function loadStoreCatalog(app, onChange) {
  const state = app.state;
  if (!state.bundledStore) {
    app.storeLocalRead ??= readCatalog(bundledURL);
    try {
      state.bundledStore = await app.storeLocalRead;
      state.storeReadError = false;
    } catch {
      app.storeLocalRead = null;
      state.storeReadError = true;
      onChange();
      return;
    }
    onChange();
  }
  const previous = state.publishedStore;
  const read = app.storePublishedRead ??= readCatalog(publishedURL);
  try {
    const published = await read;
    if (previous !== published) {
      state.publishedStore = published;
      onChange();
    }
  } catch {
    // Keep the bundled list usable. The next visit can retry this read.
    if (app.storePublishedRead === read) app.storePublishedRead = null;
  }
}

export function bindStore(app) {
  const root = app.content.querySelector("#plugin-store");
  const state = app.state;
  const listing = root.querySelector("[data-store-results]");
  const controls = root.querySelectorAll("[data-store-view]");
  const sort = root.querySelector("[data-store-sort]");
  function paint() {
    if (!root.isConnected) return;
    const active = root.ownerDocument.activeElement;
    const row = listing.contains(active) ? active.closest("[data-store-entry]") : null;
    const selector = active?.closest("summary") ? "summary" : active?.closest("[data-official-action]") ? "[data-official-action]" : null;
    const catalog = state.publishedStore || state.bundledStore;
    const current = state.storeView || "all";
    for (const button of controls) button.setAttribute("aria-pressed", String(button.dataset.storeView === current));
    sort.closest("label").hidden = current === "official" || !(catalog?.community.length > 1);
    listing.innerHTML = results(state);
    if (row && selector) {
      const entry = [...listing.querySelectorAll("[data-store-entry]")].find(el => el.dataset.storeEntry === row.dataset.storeEntry);
      entry?.querySelector(selector)?.focus({ preventScroll: true });
    }
  }
  for (const button of controls) button.onclick = () => { state.storeView = button.dataset.storeView; paint(); };
  sort.onchange = () => { state.storeSort = sort.value; paint(); };
  root.querySelector("[data-store-submit]").onclick = () => app.dialog("提交社区插件",
    `<p>在 WhaleLife 主仓提一条 GitHub Issue，附上公开 GitHub 仓库链接和一句话介绍。维护者核对后会在同一条 Issue 回复。</p>
     <p class="official-help">${externalLink(submissionURL, "填写收录申请")}</p>`);
  listing.addEventListener("toggle", event => {
    if (!listing.contains(event.target) || event.target.tagName !== "DETAILS") return;
    const id = event.target.closest("[data-store-entry]").dataset.storeEntry;
    state.storeExpanded ??= new Set();
    if (event.target.open) state.storeExpanded.add(id); else state.storeExpanded.delete(id);
  }, true);
  bindOfficialActions(app);

  listing.onclick = event => { if (event.target.closest("[data-store-retry]")) void loadStoreCatalog(app, paint); };
  void loadStoreCatalog(app, paint);
}
