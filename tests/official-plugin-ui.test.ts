import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

const { bindOfficialActions, renderManageSlot, renderStoreInstall } = await import(new URL("../core/ui/official-plugins.js", import.meta.url).href);
const { renderPlugins } = await import(new URL("../core/ui/views.js", import.meta.url).href);

const { extensionPage, pluginCard } = await import(new URL("../core/ui/extensions.js", import.meta.url).href);

const dependent = {
  id: "bilibili", runtimeId: "surf/bilibili", name: "B 站", version: "1.2.0", installed: false, action: "install",
  label: "启用网上冲浪并安装 B 站插件", planKey: "preview-key", reason: "", installation: "https://github.com/example/bilibili",
  steps: [
    { id: "surf", name: "网上冲浪", action: "enable", version: "1.0.0" },
    { id: "bilibili", name: "B 站", action: "install", version: "1.2.0" },
  ],
};
const gallery = {
  id: "gallery", runtimeId: "gallery", name: "图库", version: "0.1.2", installed: false, action: "install",
  label: "安装图库", planKey: "gallery-plan", reason: "",
  steps: [{ id: "gallery", name: "图库", action: "install", version: "0.1.2" }],
};
const installed = { ...gallery, action: "uninstall", label: "卸载图库", installed: true, installedVersion: "0.1.1", enabled: true, steps: [] };
const shelfHtml = (row: Record<string, unknown> & { id: string }) => row.installed
  ? renderManageSlot({ officialPlugins: [row] }, row.runtimeId)
  : renderStoreInstall({ officialPlugins: [row] }, row.id);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

type Dialog = { title: string; body: string; confirm?: () => Promise<void>; label?: string };
function controller(t: TestContext, row: Record<string, unknown> & { id: string }, failure?: { error: string; rolledBack: string[] }, workspace?: string) {
  const posts: unknown[] = [], dialogs: Dialog[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    if (path === "/api/official-plugins" && !init.method) return Response.json({ plugins: [row] });
    assert.equal(path, "/api/official-plugins/apply");
    assert.equal(init.method, "POST");
    posts.push(JSON.parse(String(init.body)));
    return failure ? Response.json(failure, { status: 409 }) : Response.json({ ok: true, message: "完成" });
  });
  let handler!: (event: unknown) => Promise<void>;
  const location = { hash: workspace ? "#plugin:" + encodeURIComponent(workspace) : "#plugins" };
  const app = {
    content: { querySelector: () => workspace ? { dataset: { runtimeId: workspace } } : null, querySelectorAll: () => [],
      addEventListener: (_: string, callback: typeof handler) => { handler = callback; },
      ownerDocument: { getElementById: () => null, defaultView: { location } } },
    state: { page: workspace ? location.hash.slice(1) : row.installed ? "plugins" : "market", officialPlugins: [row] },
    dialog(title: string, body: string, confirm?: Dialog["confirm"], label?: string) { dialogs.push({ title, body, confirm, label }); },
    refreshStatus: async () => {}, render() {}, toast() {},
  };
  bindOfficialActions(app);
  async function click() {
    const tag = shelfHtml(row).match(/<button\b[^>]*data-official-action[^>]*>/)?.[0];
    assert.ok(tag, "a blocked action must still be reachable by button");
    assert.doesNotMatch(tag, /\sdisabled\b/);
    const action = tag.match(/data-official-action="([^"]*)"/)?.[1];
    const slot = { dataset: row.installed ? { officialManageSlot: row.runtimeId } : { officialStoreSlot: row.id } };
    const button = { dataset: { officialAction: action, officialId: row.id }, closest: () => slot };
    await handler({ target: { closest: (s: string) => s === "[data-official-action]" ? button : null } });
  }
  return { click, posts, dialogs, location };
}

test("management shows uninstall for the exact installed runtime, including grouped children", () => {
  const root = { id: "surf", name: "网上冲浪", version: "1", status: "active", enabled: true, console: { groupChildren: true } };
  const child = { id: "surf/bilibili", name: "B 站", version: "1", status: "active", enabled: true };
  const bridge = { ...child, id: "qq/gallery" };
  const status = { plugins: [root, child, bridge] };
  const state = { status, officialPlugins: [{ ...installed, id: "surf", runtimeId: "surf" }, { ...dependent, installed: true }, installed] };
  const html = renderPlugins({ state });
  assert.match(html, /href="#market"/);
  assert.doesNotMatch(html, /id="official-shelf"|data-plugin-view=/);
  const card = pluginCard(status, root, state);
  assert.match(card, /data-official-id="surf" data-official-action="uninstall"/);
  assert.match(card, /<details\b[\s\S]*?data-official-id="bilibili" data-official-action="uninstall"[\s\S]*?<\/details>/);
  assert.doesNotMatch(pluginCard(status, bridge, state), /data-official-action/);
  const detail = extensionPage({ state: { ...state, page: "plugin:surf%2Fbilibili" } }).render();
  assert.match(detail, /data-runtime-id="surf\/bilibili"/);
  assert.match(detail, /aria-label="卸载 B 站"/);
  assert.doesNotMatch(detail, /aria-label="卸载 网上冲浪"/);
});

test("management labels only recognized installed plugins beside their names, including grouped children", () => {
  const parent = { id: "surf", name: "网上冲浪", status: "active", console: { groupChildren: true } };
  const child = { id: "surf/bilibili", name: "B 站", status: "stopped" };
  const lookalike = { ...child, id: "surf/mirror" };
  const status = { plugins: [parent, child, lookalike] };
  const officialPlugins = [
    { runtimeId: parent.id, installed: true, recognized: true, action: null },
    { runtimeId: child.id, installed: true, recognized: true },
    { runtimeId: lookalike.id, installed: true, recognized: false },
  ];
  const html = pluginCard(status, parent, { officialPlugins });
  assert.match(html, /网上冲浪<\/h3><span data-official-badge-slot="surf"><span class="store-official-badge">官方/);
  assert.match(html, /B 站<\/a><span data-official-badge-slot="surf\/bilibili"><span class="store-official-badge">官方/);
  assert.match(html, /B 站<\/a><span data-official-badge-slot="surf\/mirror"><\/span>/);
  assert.equal(html.match(/class="store-official-badge"/g)?.length, 2);
  assert.doesNotMatch(pluginCard(status, parent, {}), /class="store-official-badge"/);
});

test("management marks the exact individually recognized runtime without adding a store action", () => {
  const computer = { id: "computer", name: "电脑与文件", status: "active", version: "0.1.0" };
  const other = { ...computer, id: "custom/computer" };
  const status = { plugins: [computer, other] };
  const state = { officialPlugins: [], recognizedRuntimeIds: ["computer"] };
  const card = pluginCard(status, computer, state);
  assert.match(card, /电脑与文件<\/h3><span data-official-badge-slot="computer"><span class="store-official-badge">官方/);
  assert.doesNotMatch(card, /data-official-action/);
  assert.doesNotMatch(pluginCard(status, other, state), /class="store-official-badge"/);
});

test("store exposes versioned installation and marks installed releases without uninstall options", () => {
  const html = shelfHtml(dependent);
  assert.match(html, /v1\.2\.0/);
  assert.match(html, /aria-label="安装 B 站"/);
  assert.doesNotMatch(html, /网上冲浪|data-official-action="uninstall"/);
  const pending = renderStoreInstall({ officialPlugins: [dependent], officialBusy: dependent.id }, dependent.id);
  assert.match(pending.match(/<button\b[^>]*data-official-action[^>]*>/)![0], /\sdisabled\b/);
  const existing = renderStoreInstall({ officialPlugins: [installed] }, installed.id);
  assert.match(existing, /v0\.1\.1/);
  assert.match(existing, /已安装/);
  assert.doesNotMatch(existing, /<button|卸载/);
  assert.doesNotMatch(renderStoreInstall({ officialPlugins: [] }, "new-public-entry"), /<button/);
  assert.doesNotMatch(shelfHtml({ ...dependent, name: "<img src=x>" }), /<img src=x>/);
});

test("dependency-blocked uninstall opens a dismissible explanation and sends no mutation", async t => {
  const row = { ...installed, action: null, planKey: "", reason: "请先卸载依赖它的插件：<QQ 空间>。" };
  assert.doesNotMatch(shelfHtml(row), /请先卸载|&lt;QQ 空间&gt;|暂不可卸载/);
  const ui = controller(t, row);
  await ui.click();
  assert.equal(ui.dialogs.length, 1);
  assert.match(ui.dialogs[0].body, /&lt;QQ 空间&gt;/);
  assert.doesNotMatch(ui.dialogs[0].body, /<QQ 空间>/);
  assert.ok(!ui.dialogs[0].confirm);
  assert.deepEqual(ui.posts, []);
});

test("a blocked install offers a safe upgrade link only after the click", async t => {
  const row = { ...dependent, action: null, planKey: "", reason: "请先升级网上冲浪", upgradeUrl: "https://github.com/example/surf" };
  assert.doesNotMatch(shelfHtml(row), /请先升级|github\.com\/example\/surf/);
  const ui = controller(t, row);
  await ui.click();
  assert.match(ui.dialogs[0].body, /请先升级网上冲浪/);
  assert.match(ui.dialogs[0].body, /href="https:\/\/github.com\/example\/surf"/);
  assert.ok(!ui.dialogs[0].confirm);
  assert.deepEqual(ui.posts, []);

  const invalid = controller(t, { ...row, upgradeUrl: "javascript:invalid" });
  await invalid.click();
  assert.doesNotMatch(invalid.dialogs[0].body, /javascript:invalid/);
  assert.deepEqual(invalid.posts, []);
});

test("the install dialog previews each dependency and sends the approved plan only on confirm", async t => {
  const row = { ...dependent, steps: [
    { id: "cache", name: "缓存", action: "install", version: "2.0.0" },
    { id: "viewer", name: "查看器", action: "reuse", version: "1.5.0" },
    ...dependent.steps,
  ] };
  const ui = controller(t, row);
  await ui.click();
  assert.equal(ui.dialogs.length, 1);
  assert.deepEqual(ui.posts, []);
  const dialog = ui.dialogs[0];
  const details = text(dialog.body);
  for (const word of ["安装", "缓存", "2.0.0", "沿用", "查看器", "1.5.0", "启用", "网上冲浪", "1.0.0"]) assert.ok(details.includes(word), details);
  assert.equal(dialog.label, row.label);
  assert.ok(dialog.confirm);
  await dialog.confirm();
  assert.deepEqual(ui.posts, [{ id: row.id, action: "install", planKey: row.planKey }]);
});

test("uninstall requires confirmation and a failed operation reports the step and rollback inside it", async t => {
  const error = "移除图库失败：文件已更改", rolledBack = ["已恢复图库原启停状态", "已撤回 <临时更改>"];
  const ui = controller(t, installed, { error, rolledBack });
  await ui.click();
  assert.deepEqual(ui.posts, []);
  const dialog = ui.dialogs[0];
  assert.match(dialog.body, /保留/);
  assert.ok(dialog.confirm);
  await assert.rejects(dialog.confirm, (failure: Error) => [error, ...rolledBack].every(line => failure.message.includes(line)));
  assert.deepEqual(ui.posts, [{ id: installed.id, action: "uninstall", planKey: installed.planKey }]);
});

test("removing a child from its own workspace returns to management after confirmation", async t => {
  const plugin = { ...dependent, installed: true, action: "uninstall", label: "卸载 B 站插件", steps: [] };
  const ui = controller(t, plugin, undefined, plugin.runtimeId);
  await ui.click();
  assert.ok(ui.dialogs[0].confirm);
  assert.equal(ui.location.hash, "#plugin:surf%2Fbilibili");
  await ui.dialogs[0].confirm();
  assert.deepEqual(ui.posts, [{ id: "bilibili", action: "uninstall", planKey: plugin.planKey }]);
  assert.equal(ui.location.hash, "#plugins");
});

test("a single-plugin install runs on click and reports a rejected plan in an escaped dialog", async t => {
  const ui = controller(t, gallery, { error: "安装图库失败", rolledBack: ["撤回 <变动>"] });
  await ui.click();
  assert.deepEqual(ui.posts, [{ id: gallery.id, action: "install", planKey: gallery.planKey }]);
  assert.equal(ui.dialogs.length, 1);
  const dialog = ui.dialogs[0];
  assert.match(dialog.title + dialog.body, /安装图库失败/);
  assert.match(dialog.body, /&lt;变动&gt;/);
  assert.doesNotMatch(dialog.body, /<变动>/);
  assert.ok(!dialog.confirm);
});
