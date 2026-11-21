import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { temporaryDirectory } from "./temporary-directory.ts";
const ui = await import(new URL("../core/ui/extensions.js", import.meta.url).href);
const views = await import(new URL("../core/ui/views.js", import.meta.url).href);

function fixture(grouped = true) {
  const plugin = (id: string, name: string, extra = {}) => ({ id, name, version: "1.0.0", enabled: true, status: "active", ...extra });
  const page = (owner: string, title: string, extra = {}) => ({ owner, title, path: `/plugins/${owner}/settings`, settings: true, navigation: true, ...extra });
  return {
    plugins: [plugin("qq", "QQ", grouped ? { console: { groupChildren: true } } : {}), plugin("qq/qzone", "QQ 空间"),
      plugin("qq/qzone/deep", "深层子插件"), plugin("qq-extra", "独立插件"), plugin("core", "核心", { builtin: true })],
    pluginPages: [page("qq", "QQ"), page("qq/qzone", "QQ 空间"), page("qq/qzone/deep", "深层子插件"), page("qq-extra", "独立插件")],
  } as any;
}
const render = (status: any, page: string) => ui.extensionPage({ state: { status, page } }).render();

test("opt-in groups cards and sidebar while retaining real counts, parent features and complete IDs", () => {
  const status = fixture(), before = structuredClone(status);
  assert.deepEqual(ui.visiblePluginCards(status).map((p: any) => p.id), ["qq", "qq-extra"]);
  const cards = views.renderPlugins({ state: { status } });
  assert.match(cards, /4 个扩展插件 · 2 个入口/);
  assert.doesNotMatch(cards, /data-plugin-id="qq\/qzone"/);
  assert.match(cards, /href="#plugin:qq"/);
  const nav = ui.extensionNavigation(status);
  assert.equal((nav.match(/data-page="plugin:qq"/g) || []).length, 1);
  assert.doesNotMatch(nav, /QQ 空间|深层子插件|核心/);
  assert.match(nav, /独立插件/);
  const parent = render(status, ui.pluginKey("qq"));
  assert.match(parent, /父插件/); assert.match(parent, /子插件/);
  assert.match(parent, /src="\/plugins\/qq\/settings"/);
  assert.match(parent, /href="#plugin:qq%2Fqzone"/);
  assert.doesNotMatch(parent, /私聊子插件/);
  const child = render(status, ui.pluginKey("qq/qzone"));
  assert.match(child, /data-plugin-id="qq\/qzone" data-plugin-action="stop"/);
  assert.match(child, /src="\/plugins\/qq\/qzone\/settings"/);
  assert.equal(ui.extensionActiveKey(status, ui.pluginKey("qq/qzone/deep")), "plugin:qq");
  assert.deepEqual(status, before, "rendering cannot mutate plugin lifecycle or page registrations");
});

test("pinning sorts only the sidebar, preserving grouped entries and page order within each plugin", () => {
  const status = fixture();
  status.pluginPages.push({ owner: "qq-extra", title: "第二个页面", path: "/plugins/qq-extra/more", navigation: true });
  const before = structuredClone(status);
  const pinned = ["missing", "qq-extra", "qq"];
  const links = (pins: string[]) => [...ui.extensionNavigation(status, pins).matchAll(/data-page="([^"]+)"/g)].map(match => match[1]);
  const group = ui.pluginKey("qq");
  const first = ui.extensionKey("/plugins/qq-extra/settings");
  const second = ui.extensionKey("/plugins/qq-extra/more");
  assert.deepEqual(links(pinned), [first, second, group]);
  assert.deepEqual(links([]), [group, first, second]);
  assert.deepEqual(status, before);
  status.plugins.find((p: any) => p.id === "qq-extra").status = "stopped";
  assert.deepEqual(links(pinned), [group]);
  status.plugins.find((p: any) => p.id === "qq-extra").status = "active";
  assert.deepEqual(links(pinned), [first, second, group]);
});

test("legacy manifests keep independent cards, navigation, settings links and plain pages", () => {
  for (const value of [undefined, false]) {
    const status = fixture(false); if (value === false) status.plugins[0].console = { groupChildren: false };
    assert.equal(ui.visiblePluginCards(status).length, 4);
    assert.match(views.renderPlugins({ state: { status } }), /data-plugin-id="qq\/qzone"/);
    assert.match(ui.extensionNavigation(status), /QQ 空间/);
    const key = ui.extensionKey("/plugins/qq/qzone/settings");
    assert.equal(ui.extensionActiveKey(status, key), key);
    assert.doesNotMatch(render(status, key), /plugin-workspace/);
    assert.match(ui.extensionSettings(status, "qq/qzone"), new RegExp("#" + key));
  }
});

test("old child links resolve inside their parent and stopped, blocked or failed children remain manageable", () => {
  const status = fixture(), oldLink = ui.extensionKey("/plugins/qq/qzone/settings");
  assert.match(render(status, oldLink), /plugin-workspace/);
  assert.equal(ui.extensionActiveKey(status, oldLink), "plugin:qq");
  for (const state of ["stopped", "blocked", "failed"]) {
    status.plugins[1].status = state; status.plugins[1].enabled = state !== "stopped";
    status.plugins[1].error = "测试原因 <unsafe>";
    status.pluginPages = status.pluginPages.filter((p: any) => p.owner !== "qq/qzone");
    const html = render(status, oldLink);
    assert.doesNotMatch(html, /<iframe/);
    assert.match(html, /QQ 空间/); assert.match(html, /测试原因 &lt;unsafe&gt;/);
    assert.match(html, new RegExp(`data-plugin-id="qq/qzone" data-plugin-action="${state === "stopped" ? "start" : "stop"}"`));
    assert.match(ui.extensionNavigation(status), /data-page="plugin:qq"/);
  }
  status.plugins[1].status = "active";
  status.pluginPages.push({ owner: "qq/qzone", title: "恢复", path: "/plugins/qq/qzone/settings", settings: true, navigation: true });
  assert.match(render(status, oldLink), /<iframe/);
});

test("multiple levels, nested opt-ins and missing parents retain discoverable fallbacks", () => {
  const status = fixture(); status.plugins[1].console = { groupChildren: true };
  assert.equal(ui.pluginGroup(status, "qq/qzone/deep").id, "qq");
  assert.equal(ui.pluginGroup(status, "qq-extra"), undefined);
  status.plugins = status.plugins.filter((p: any) => p.id !== "qq");
  assert.equal(ui.pluginGroup(status, "qq/qzone/deep").id, "qq/qzone");
  assert.match(ui.extensionNavigation(status), /data-page="plugin:qq%2Fqzone"/);
  delete status.plugins[0].console;
  assert.equal(ui.visiblePluginCards(status).length, 3);
  assert.match(ui.extensionNavigation(status), /QQ 空间/);
  assert.match(render(status, "plugin:%broken"), /页面已移除/);
  const orphan = fixture(); orphan.plugins = orphan.plugins.filter((p: any) => p.id !== "qq/qzone");
  assert.match(render(orphan, "plugin:qq"), /深层子插件/);
});

test("settings-only, navigation-only, no-page and multiple-page plugins preserve page entry flags", () => {
  const status = fixture(); status.pluginPages = [
    { owner: "qq", title: "父级设置", path: "/plugins/qq/settings", settings: true, navigation: false },
    { owner: "qq/qzone", title: "空间页面", path: "/plugins/qq/qzone/view", settings: false, navigation: true },
    { owner: "qq/qzone", title: "空间设置", path: "/plugins/qq/qzone/settings", settings: true, navigation: false },
    { owner: "qq/qzone", title: "内部页面", path: "/plugins/qq/qzone/internal", settings: false, navigation: false },
  ];
  assert.equal((ui.extensionNavigation(status).match(/data-page=/g) || []).length, 1);
  const html = render(status, ui.pluginKey("qq/qzone"));
  assert.match(html, /src="\/plugins\/qq\/qzone\/settings"/);
  assert.match(html, /空间页面/); assert.doesNotMatch(html, /内部页面/);
  assert.match(render(status, ui.pluginKey("qq/qzone/deep")), /未注册可用页面/);
  status.pluginPages = status.pluginPages.filter((p: any) => !p.navigation);
  assert.equal(ui.extensionNavigation(status), "");
  assert.match(views.renderPlugins({ state: { status } }), /href="#plugin:qq"/);
});

test("all group labels are escaped and hashes cannot manufacture an iframe target", () => {
  const status = fixture(); status.plugins[0].name = '<img onerror="bad">';
  status.plugins[1].description = '<script>bad</script>';
  const html = render(status, ui.pluginKey("qq/qzone"));
  assert.doesNotMatch(html, /<img|<script>/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(render(status, ui.extensionKey("https://evil.invalid/")), /iframe/);
  assert.doesNotMatch(render(status, ui.extensionKey("/plugins/qq/qzone/missing")), /iframe/);
});

test("group action buttons target the selected full plugin ID and recover after errors", async t => {
  const buttons = [{ dataset: { pluginId: "qq/qzone", pluginAction: "stop" }, disabled: false } as any];
  let refreshed = 0, rendered = 0, failure = false;
  const notices: any[] = [], calls: any[] = [];
  t.mock.method(globalThis, "fetch", async (path: any, options: any) => {
    calls.push({ path, ...JSON.parse(options.body) });
    return new Response(JSON.stringify(failure ? { error: "请先启用父插件" } : {}), { status: failure ? 400 : 200 });
  });
  const app = { content: { querySelectorAll: () => buttons }, refreshStatus: async () => { refreshed++; }, render: () => { rendered++; }, toast: (...args: any[]) => notices.push(args) };
  ui.bindPluginActions(app); await buttons[0].onclick();
  assert.deepEqual(calls[0], { path: "/api/plugin", id: "qq/qzone", action: "stop" });
  assert.equal(refreshed, 1); assert.equal(rendered, 1);
  failure = true; buttons[0].dataset.pluginAction = "start"; await buttons[0].onclick();
  assert.equal(buttons[0].disabled, false); assert.equal(refreshed, 1);
  assert.deepEqual(notices.at(-1), ["请先启用父插件", true]);
});

test("group metadata survives actual child lifecycle without changing routes, auth, data or saved opt-outs", async t => {
  const root = await temporaryDirectory("whale-plugin-grouping-");
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  t.after(async () => { await app?.close(); });
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config/config.json"), JSON.stringify({ log: { level: "error" }, web: { port: 0 }, providers: [], models: [],
    personas: { a: { name: "测试人格", file: "a.md", permission: "off" } }, channels: { web: { persona: "a", permission: "off" } }, memory: { root: "memory", budget_tokens: 6000 } }));
  const plugin = async (id: string, extra: any) => {
    const dir = join(root, "plugins", id.split("/").join("/sub/"));
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), JSON.stringify({ id: id.split("/").at(-1), name: id, description: "grouping fixture", version: "1.0.0", ...extra }));
    await writeFile(join(dir, "index.ts"), `export function apply(ctx) { ctx.web.page('/plugins/${id}/settings', (req,res)=>res.end('fixture:${id}'), {title:'${id}',settings:true,navigation:true}); }`);
    return dir;
  };
  await plugin("parent", { console: { groupChildren: true } });
  const child = await plugin("parent/child", {});
  await writeFile(join(child, "data/config.json"), '{"saved":"keep"}');
  app = await boot(root);
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  const login = await fetch(url + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const request = (path: string, body?: any) => fetch(url + path, { headers: { Cookie: cookie }, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) });
  let status = await (await request("/api/status")).json();
  assert.equal(status.plugins.find((p: any) => p.id === "parent").console.groupChildren, true);
  assert.equal(ui.visiblePluginCards(status).length, 1);
  assert.equal((await fetch(url + "/plugins/parent/child/settings")).status, 401);
  assert.equal(await (await request("/plugins/parent/child/settings")).text(), "fixture:parent/child");
  assert.equal((await request("/api/plugin", { id: "parent/child", action: "stop" })).status, 200);
  assert.equal((await request("/api/plugin", { id: "parent", action: "reload" })).status, 200);
  status = await (await request("/api/status")).json();
  assert.equal(status.plugins.find((p: any) => p.id === "parent/child").enabled, false);
  assert.match(render(status, ui.extensionKey("/plugins/parent/child/settings")), /data-plugin-action="start"/);
  assert.doesNotMatch(render(status, ui.pluginKey("parent/child")), /<iframe/);
  assert.equal((await request("/api/plugin", { id: "parent/child", action: "start" })).status, 200);
  status = await (await request("/api/status")).json();
  assert.equal(status.pluginPages.filter((p: any) => p.owner === "parent/child").length, 1);
  assert.equal(await readFile(join(child, "data/config.json"), "utf8"), '{"saved":"keep"}');
  await plugin("invalid", { console: { groupChildren: "true" } });
  const bad = await app.runtime.loadPath("invalid");
  assert.equal(bad.status, "failed"); assert.match(bad.error, /groupChildren/);
});
