import { escapeHTML as e } from "./api.js";
import { icon } from "./icons.js";
export const extensionKey = (path) => "extension:" + encodeURIComponent(path);
export const extensionEntries = (status) => (status?.pluginPages ?? []).filter((p) => status.plugins?.some((plugin) => plugin.id === p.owner && plugin.status === "active"));
export function extensionPage(app) {
  const entry = extensionEntries(app.state.status).find((p) => extensionKey(p.path) === app.state.page);
  return { name: entry?.title || "插件页面", render: () => entry
    ? `<div class="page-heading"><div><h1>${e(entry.title)}</h1><p>${e(entry.owner)}</p></div><a class="btn" href="#plugins">返回插件管理</a></div><section class="panel extension-panel"><iframe class="extension-frame" title="${e(entry.title)}" src="${e(entry.path)}"></iframe></section>`
    : '<div class="panel empty">插件已停用或页面已移除。<a href="#plugins">返回插件管理</a></div>' };
}
export function extensionNavigation(status) {
  return extensionEntries(status).filter((p) => p.navigation).map((p) => `<a href="#${extensionKey(p.path)}" data-page="${extensionKey(p.path)}">${icon("puzzle")}<span>${e(p.title)}</span></a>`).join("");
}
export function extensionSettings(status, owner) {
  const page = extensionEntries(status).find((p) => p.owner === owner && p.settings);
  return page ? `<a class="btn small" href="#${extensionKey(page.path)}">${icon("sliders")}设置</a>` : "";
}
