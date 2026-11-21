/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";
import { bindOfficialActions, confirmCommunityInstall, officialBadge, renderStoreInstall } from "./official-plugins.js";
import { bindPluginUpdateCheck, checkPluginsButton, checkPluginsStatus, storeUpdate, updateBadge, updateDetails } from "./plugin-updates.js";
import "../../market/assets/catalog-validation.js";

const bundledURL = "/market/catalog.json";
const publishedURL = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json";
const submissionURL = "https://github.com/iinukami/whalelife/issues/new?template=submit-plugin.yml";
const views = { all: "全部", official: "官方", community: "社区" };

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

const artNames = new Set(["qq", "qzone", "autonomy", "gallery", "surf", "bilibili", "vision", "computer"]);

function bundledIdentity(state, entry) {
  return state.bundledStore?.official.some(item => item.id === entry.id && item.repository === entry.repository && item.name === entry.name);
}

function localPlan(state, entry, official) {
  if (official) return bundledIdentity(state, entry) ? state.officialPlugins?.find(item => item.id === entry.id) : null;
  return state.communityPlugins?.find(item => item.id === entry.id && item.repository === entry.repository &&
    (item.action === "installed" || item.action === "blocked" || (item.action === "install" && item.version && item.planKey)));
}

function art(entry, official) {
  const theme = official && artNames.has(entry.id) ? entry.id : "generic";
  return `<span class="store-art" data-art="${theme}" aria-hidden="true">
    <span class="store-object"><i></i><em></em><u></u></span></span>`;
}

function versionLine(state, entry, official, plan, update) {
  const planVersion = plan?.installed && plan.recognized === false ? null : plan?.version;
  const listed = globalThis.whaleLifeCatalogVersion(entry, state.bundledStore?.[official ? "official" : "community"]) || planVersion;
  const installed = official ? plan?.installed : plan?.action === "installed";
  const installedVersion = installed ? plan.installedVersion || plan.version : update?.installedVersion;
  const labels = [listed ? "收录版本 v" + listed : "版本未提供"];
  if (installedVersion && installedVersion !== listed) labels.push("已装 v" + installedVersion);
  if (plan?.action === "install" && plan.version && plan.version !== listed) labels.push("本机可装 v" + plan.version);
  return `<span class="store-version">${labels.map(e).join(" · ")}</span>`;
}

function card(state, entry, official) {
  const plan = localPlan(state, entry, official);
  const update = storeUpdate(state, entry, official ? "official" : "community");
  const installed = (official ? plan?.installed : plan?.action === "installed") || !!update;
  const status = installed ? icon("check") + "已安装" : plan?.action === "install" ? "可安装" : "";
  return `<button type="button" class="store-card" data-store-entry="${e(entry.id)}">
    ${art(entry, official)}<span class="store-card-body"><span class="store-card-line">
    <span class="store-name-line"><strong>${e(entry.name)}</strong>${official ? officialBadge : ""}${updateBadge(update)}</span>
    <span class="store-card-status"${installed ? " data-installed" : ""}>${status}</span></span>
    ${versionLine(state, entry, official, plan, update)}
    <span class="store-description">${e(entry.description)}</span></span></button>`;
}

function communityOrder(sort) {
  return (a, b) => {
    if (sort !== "date" && a.stars !== b.stars) return b.stars - a.stars;
    return b.collected.localeCompare(a.collected) || a.id.localeCompare(b.id);
  };
}

function results(state, catalog) {
  const sections = [];
  const query = (state.storeSearch || "").trim().toLowerCase();
  for (const [type, heading] of [["official", "官方插件"], ["community", "社区插件"]]) {
    if (state.storeView && state.storeView !== "all" && state.storeView !== type) continue;
    const entries = catalog[type].filter(entry => !query || [entry.name, entry.id, entry.description, entry.author]
      .some(value => value.toLowerCase().includes(query)));
    if (!entries.length) continue;
    if (type === "community") entries.sort(communityOrder(state.storeSort));
    sections.push(`<section aria-label="${heading}" class="store-section">
      <div class="store-section-heading"><h2>${heading}</h2><small>${entries.length} 款插件</small></div>
      <div class="store-grid">${entries.map(entry => card(state, entry, type === "official")).join("")}</div></section>`);
  }
  if (sections.length) return sections.join("");
  const empty = query ? "没有找到匹配的插件" : state.storeView === "community" ? "暂无收录的社区插件" : state.storeView === "official" ? "暂无收录的官方插件" : "暂无收录的插件";
  return `<p class="store-empty" role="status">${empty}</p>`;
}

function detail(state, catalog) {
  const officialEntry = catalog.official.find(entry => entry.id === state.storeDetail);
  const entry = officialEntry || catalog.community.find(entry => entry.id === state.storeDetail);
  if (!entry) return '<h1 id="store-heading" tabindex="-1" class="store-empty">未找到这个插件</h1>';
  const names = new Map([...catalog.official, ...catalog.community].map(item => [item.id, item.name]));
  const dependencies = entry.dependencies.map(id => names.get(id) || id).join("、");
  const local = officialEntry && bundledIdentity(state, entry);
  const plan = localPlan(state, entry, !!officialEntry);
  const update = storeUpdate(state, entry, officialEntry ? "official" : "community");
  const action = local
    ? `<span class="store-action" data-official-store-slot="${e(entry.id)}">${renderStoreInstall(state, entry.id)}</span>`
    : plan ? communityAction(state, entry, plan) : externalLink(entry.installation, "安装说明");
  const links = [
    local || plan ? externalLink(entry.installation, "安装说明") : "",
    externalLink(entry.repository, "原仓库 · 加星"),
    externalLink(entry.feedback, "反馈问题"),
  ].join("");
  return `${art(entry, !!officialEntry)}
    <div class="store-detail-body">${officialEntry ? "" : '<small class="store-kind">社区插件</small>'}
      <div class="store-name-line"><h1 id="store-heading" tabindex="-1">${e(entry.name)}</h1>${officialEntry ? officialBadge : ""}${updateBadge(update)}</div>
      ${versionLine(state, entry, !!officialEntry, plan, update)}
      <p class="store-description">${e(entry.description)}</p>
      <dl class="store-facts"><div><dt>作者</dt><dd>${e(entry.author)}</dd></div>
        <div><dt>插件依赖</dt><dd>${e(dependencies || "无")}</dd></div></dl>
      ${updateDetails(update)}
      <div class="store-actions">${action}</div>
      <nav class="store-links" aria-label="${e(entry.name)}相关链接">${links}</nav></div>`;
}

function communityAction(state, entry, plan) {
  const installed = plan.action === "installed";
  const version = installed ? plan.installedVersion || plan.version : plan.version;
  const versionTag = version ? `<span class="official-version">v${e(version)}</span>` : "";
  const label = plan.action === "blocked" ? "查看安装条件" : "安装";
  const control = installed ? '<span class="official-installed">已安装</span>' :
    `<button type="button" class="btn small tonal" data-community-install="${e(entry.id)}" aria-label="${e(label + " " + entry.name)}"${state.officialBusy ? " disabled" : ""}>${state.officialBusy === entry.id ? "安装中…" : label}</button>`;
  return `<span class="store-action">${versionTag}${control}</span>`;
}

async function readCommunityPlans(app) {
  if (app.communityRead || app.state.officialBusy) return;
  const read = api("/api/community-plugins");
  app.communityRead = read;
  try {
    const { plugins } = await read;
    if (app.communityRead === read) app.state.communityPlugins = Array.isArray(plugins) ? plugins : null;
  } catch {
    if (app.communityRead === read) app.state.communityPlugins = null;
  } finally {
    if (app.communityRead === read) {
      app.communityRead = null;
      app.content.ownerDocument.getElementById("plugin-store")?.dispatchEvent(new Event("community-plans"));
    }
  }
}

function storeBody(state) {
  const catalog = state.publishedStore || state.bundledStore;
  if (!catalog) {
    const heading = state.storeDetail ? '<h1 id="store-heading" tabindex="-1">插件详情</h1>' : "";
    const message = state.storeReadError
      ? '<div class="official-loading" role="alert">无法读取插件目录 <button type="button" class="btn small" data-store-retry>重试</button></div>'
      : '<p class="official-loading" role="status">正在读取插件目录…</p>';
    return heading + message;
  }
  return state.storeDetail ? detail(state, catalog) : results(state, catalog);
}

export function renderStore(app) {
  const state = app.state, current = state.storeView || "all";
  const catalog = state.publishedStore || state.bundledStore;
  const hideSort = current === "official" || !(catalog?.community.length > 1);
  return `<div id="plugin-store">
    ${state.storeDetail ? "" : `<header class="store-page-heading"><h1 id="store-heading" tabindex="-1">插件商店</h1>
      <div class="plugin-heading-actions">${checkPluginsButton(state)}
        <button type="button" class="btn small" data-store-submit>提交插件</button></div></header>
    <div class="store-toolbar"><nav data-store-views aria-label="插件分类">${Object.entries(views).map(([key, name]) =>
      `<button type="button" data-store-view="${key}" aria-pressed="${current === key}">${name}</button>`).join("")}</nav>
      <label class="store-search">${icon("search")}<input type="search" data-store-search aria-label="搜索插件" placeholder="搜索插件" value="${e(state.storeSearch || "")}"></label>
      <label class="store-sort"${hideSort ? " hidden" : ""}>社区排序
      <select data-store-sort><option value="stars">GitHub 星标</option><option value="date"${state.storeSort === "date" ? " selected" : ""}>最近收录</option></select></label></div>`}
    ${state.storeDetail ? "" : checkPluginsStatus(state)}
    <div data-official-read-status role="status">${state.officialReadError ? e(state.officialReadError) + ' <button class="btn small" type="button" data-official-retry>重试</button>' : ""}</div>
    <div class="store-scroll${state.storeDetail ? " store-detail" : ""}" data-store-scroll>
      <div data-store-results>${storeBody(state)}</div>
      ${state.storeDetail ? "" : `<footer class="store-footer">${icon("chat")} 交流 QQ 群 · 962935021</footer>`}</div></div>`;
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

export function bindStore(app, container = app.content, opening = true) {
  const root = container.querySelector("#plugin-store");
  const state = app.state;
  const listing = root.querySelector("[data-store-results]");
  const scroll = root.querySelector("[data-store-scroll]");
  const controls = root.querySelectorAll("[data-store-view]");
  const sort = root.querySelector("[data-store-sort]");
  function paint() {
    if (!root.isConnected) return;
    const active = root.ownerDocument.activeElement;
    const focusedId = active?.closest("[data-store-entry]")?.dataset.storeEntry;
    const focusedDetail = state.storeDetail && listing.contains(active);
    const catalog = state.publishedStore || state.bundledStore;
    const current = state.storeView || "all";
    for (const button of controls) button.setAttribute("aria-pressed", String(button.dataset.storeView === current));
    if (sort) sort.closest("label").hidden = current === "official" || !(catalog?.community.length > 1);
    listing.innerHTML = storeBody(state);
    if (focusedId) {
      [...listing.querySelectorAll("[data-store-entry]")].find(el => el.dataset.storeEntry === focusedId)?.focus({ preventScroll: true });
    } else if (focusedDetail) {
      const next = active.matches("a") ? [...listing.querySelectorAll("a")].find(link => link.href === active.href)
        : active.hasAttribute("data-official-action") ? listing.querySelector("[data-official-action]:enabled")
        : active.hasAttribute("data-community-install") ? listing.querySelector("[data-community-install]:enabled") : null;
      (next || listing.querySelector("#store-heading"))?.focus({ preventScroll: true });
    }
  }
  root.addEventListener("plugin-updates", paint);
  root.addEventListener("community-plans", paint);
  root.addEventListener("community-plans-invalidated", () => {
    paint();
    void readCommunityPlans(app);
  });
  app.storeOfficialChange = paint;
  for (const button of controls) button.onclick = () => { state.storeView = button.dataset.storeView; paint(); scroll.scrollTop = 0; };
  if (sort) sort.onchange = () => { state.storeSort = sort.value; paint(); scroll.scrollTop = 0; };
  const search = root.querySelector("[data-store-search]");
  if (search) search.oninput = () => { state.storeSearch = search.value; paint(); scroll.scrollTop = 0; };
  const submit = root.querySelector("[data-store-submit]");
  if (submit) submit.onclick = () => app.dialog("提交社区插件",
    `<p>在 WhaleLife 主仓提一条 GitHub Issue，附上公开 GitHub 仓库链接和一句话介绍。维护者核对后会在同一条 Issue 回复。</p>
     <p class="official-help">${externalLink(submissionURL, "填写收录申请")}</p>`);
  listing.onclick = event => {
    const card = event.target.closest("[data-store-entry]");
    const install = event.target.closest("[data-community-install]");
    if (card) app.showStoreDetail(card.dataset.storeEntry);
    else if (event.target.closest("[data-store-retry]")) void loadStoreCatalog(app, paint);
    else if (install && !install.disabled) {
      const id = install.dataset.communityInstall;
      const currentEntry = () => (state.publishedStore || state.bundledStore)?.community.find(item => item.id === id && item.id === state.storeDetail);
      const entry = currentEntry();
      const plan = entry && localPlan(state, entry, false);
      if (!plan) return;
      confirmCommunityInstall(app, entry, plan, () => {
        const shown = currentEntry();
        return root.isConnected && shown?.repository === entry.repository && localPlan(state, shown, false)?.planKey === plan.planKey;
      });
    }
  };
  bindOfficialActions(app, root, opening);
  bindPluginUpdateCheck(app, root);
  if (opening && state.communityPlugins) {
    state.communityPlugins = null;
    paint();
  }
  if (opening || !state.communityPlugins) void readCommunityPlans(app);
  if (opening || !state.bundledStore || app.storePublishedRead) void loadStoreCatalog(app, paint);
}
