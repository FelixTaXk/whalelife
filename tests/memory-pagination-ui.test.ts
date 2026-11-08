/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

const { loadMemory, bindMemory, renderMemory } =
  await import(new URL("../core/ui/memory.js", import.meta.url).href);
const json = (value: unknown) => new Response(JSON.stringify(value));
const page = (offset: number, total = 80, text = `server-page-${offset}`) => ({
  offset, limit: 25, total, items: [{ id: `item-${offset}`, kind: "episode", status: "active", text }],
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const state: any = { session: "active", memorySession: "viewed", page: "memory", memoryTab: "knowledge",
    memoryLoadedTab: "knowledge", memoryLoadedSession: "viewed", memoryDetails: page(0),
    knowledgeQuery: "", knowledgeArchived: false, knowledgeOffset: 0,
    knowledgePageKey: JSON.stringify(["viewed", "", false]) };
  const pagers: any[] = ["prev", "next", "prev", "next"].map(direction => ({ dataset: { knowledgePage: direction }, disabled: false }));
  const fields = { query: "", archived: false };
  const checkbox: any = {}, selector: any = { value: "viewed" };
  const form: any = { querySelector: (selector: string) => selector === '[name="archived"]' ? checkbox : null };
  const refresh = {}, backup = {}, actions: any[] = [], errors: string[] = [];
  const app: any = { state, fields, checkbox, selector, form, pagers, actions, errors, html: "",
    content: {
      querySelector: (key: string) => key === "#knowledge-search-form" ? (state.memoryTab === "knowledge" ? form : null) :
        key === "#context-session" ? selector : key === "[data-memory-refresh]" ? refresh : key === "[data-memory-backup]" ? backup : null,
      querySelectorAll: (key: string) => key === "[data-knowledge-page]" && state.memoryTab === "knowledge" ? pagers :
        key === "[data-knowledge-action]" ? actions : [],
    },
    toast: (message: string, failed: boolean) => { if (failed) errors.push(message); },
    dialog() {},
    render() { app.html = renderMemory(app); bindMemory(app); },
  };
  app.render();
  return app;
}
function mockForm(t: TestContext, app: any) {
  t.mock.method(globalThis, "FormData", function () {
    return { get: (key: string) => key === "query" ? app.fields.query : undefined,
      has: (key: string) => key === "archived" && app.fields.archived } as any;
  });
}
function mockRead(t: TestContext, getPage: (url: URL) => any | Promise<any> = url => page(Number(url.searchParams.get("offset")))) {
  const calls: URL[] = [];
  const catalog = { root: "synthetic", bytes: 0, facts: { count: 0 }, summaries: { count: 0, bytes: 0 },
    sessions: { count: 1, bytes: 0, items: [] } };
  const context = { model: { name: "synthetic", context_window: 32000 }, usage: null };
  t.mock.method(globalThis, "fetch", async (path: any) => {
    const url = new URL(String(path), "http://test.invalid"); calls.push(url);
    if (url.pathname === "/api/memory/knowledge") return json(await getPage(url));
    if (url.pathname === "/api/memory") return json(catalog);
    if (url.pathname === "/api/session/context") return json(context);
    throw Error("Unexpected request: " + url.pathname);
  });
  return { calls };
}

test("first load requests a server page, and both pagination bars fetch only the requested knowledge page", async t => {
  const app = fixture(), pending = deferred<any>();
  const { calls } = mockRead(t, url => Number(url.searchParams.get("offset")) === 25 ? pending.promise : page(0));
  await loadMemory(app);
  assert.equal(calls.length, 3);
  const first = calls.find(url => url.pathname === "/api/memory/knowledge")!;
  assert.deepEqual(Object.fromEntries(first.searchParams), { id: "viewed", query: "", archived: "false", offset: "0", limit: "25" });
  const catalog = app.state.memoryCatalog, context = app.state.memoryContext;
  calls.length = 0;
  const request = app.pagers[3].onclick();
  assert.equal(app.state.memoryLoading, true);
  assert.ok(app.pagers.every((button: any) => button.disabled));
  app.pagers[1].onclick();
  assert.equal(calls.length, 1, "a second click while pending cannot send another request");
  assert.equal(calls[0].pathname, "/api/memory/knowledge");
  assert.equal(calls[0].searchParams.get("offset"), "25");
  pending.resolve(page(25, 80, "only-this-server-page")); await request;
  assert.strictEqual(app.state.memoryCatalog, catalog); assert.strictEqual(app.state.memoryContext, context);
  assert.deepEqual(app.state.memoryDetails.items.map((item: any) => item.text), ["only-this-server-page"]);
  assert.doesNotMatch(app.html, /server-page-0/);
  assert.equal((app.html.match(/第 2 \/ 4 页 · 共 80 条/g) || []).length, 2);
  assert.equal(app.state.session, "active");
  calls.length = 0;
  await app.pagers[0].onclick();
  assert.equal(calls.length, 1); assert.equal(calls[0].searchParams.get("offset"), "0");
});

test("pagination shows server totals, disables boundaries and tolerates older responses without totals", () => {
  const app = fixture();
  app.state.memoryDetails = page(50, 51); app.render();
  assert.equal((app.html.match(/第 3 \/ 3 页 · 共 51 条/g) || []).length, 2);
  assert.equal(app.pagers[0].disabled, false); assert.equal(app.pagers[1].disabled, true);
  app.state.memoryDetails = { items: [] }; app.render();
  assert.equal((app.html.match(/第 0 \/ 0 页 · 共 0 条/g) || []).length, 2);
  assert.ok(app.pagers.every((button: any) => button.disabled));
  app.state.memoryDetails = { items: page(0).items }; app.render();
  assert.match(app.html, /第 1 \/ 1 页 · 共 1 条/); assert.doesNotMatch(app.html, /NaN|undefined/);
  app.state.memoryDetails = page(25); app.state.memoryLoading = true; app.render();
  assert.equal((app.html.match(/data-knowledge-page="(?:prev|next)" disabled/g) || []).length, 4);
});

test("search, archive filter and viewed-session changes reset the page while spaces explicitly request a small first page", async t => {
  const app = fixture(); mockForm(t, app);
  const { calls } = mockRead(t);
  await loadMemory(app); await app.pagers[1].onclick();
  app.fields.query = "合成关键词";
  calls.length = 0;
  await app.form.onsubmit({ preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(calls[0].searchParams.get("offset"), "0");
  assert.equal(calls[0].searchParams.get("query"), "合成关键词");
  await app.pagers[1].onclick();
  app.fields.archived = true; calls.length = 0;
  await app.checkbox.onchange();
  assert.equal(calls.length, 1); assert.equal(calls[0].searchParams.get("archived"), "true");
  assert.equal(calls[0].searchParams.get("offset"), "0");
  await app.pagers[1].onclick();
  app.selector.value = "other"; calls.length = 0;
  await app.selector.onchange();
  const other = calls.find(url => url.pathname === "/api/memory/knowledge")!;
  assert.equal(other.searchParams.get("id"), "other"); assert.equal(other.searchParams.get("offset"), "0");
  assert.equal(app.state.memoryLoadedSession, "other"); assert.equal(app.state.session, "active");
  app.state.memoryTab = "spaces"; app.state.knowledgeOffset = 75; calls.length = 0;
  await loadMemory(app);
  const spaces = calls.find(url => url.pathname === "/api/memory/knowledge")!;
  assert.deepEqual(Object.fromEntries(spaces.searchParams), { id: "other", query: "", archived: "false", offset: "0", limit: "25" });
});

test("late pages and errors cannot overwrite a newer search or another viewed session", async t => {
  const app = fixture(); mockForm(t, app);
  const oldPage = deferred<any>(), staleSession = deferred<any>();
  mockRead(t, url => {
    if (url.searchParams.get("offset") === "25" && !url.searchParams.get("query")) return oldPage.promise;
    if (url.searchParams.get("offset") === "25" && url.searchParams.get("id") === "viewed") return staleSession.promise;
    return page(0, 40, url.searchParams.get("id") + ":" + url.searchParams.get("query"));
  });
  await loadMemory(app);
  const first = app.pagers[1].onclick();
  app.fields.query = "new";
  await app.form.onsubmit({ preventDefault() {} });
  oldPage.resolve(page(25, 80, "stale-page")); await first;
  assert.equal(app.state.memoryDetails.items[0].text, "viewed:new");
  assert.equal(app.state.knowledgeOffset, 0); assert.equal(app.state.memoryLoading, false);
  const second = app.pagers[1].onclick();
  app.selector.value = "other";
  await app.selector.onchange();
  staleSession.reject(Error("obsolete failure")); await second;
  assert.equal(app.state.memoryDetails.items[0].text, "other:new");
  assert.equal(app.state.memoryLoadedSession, "other"); assert.equal(app.state.memoryError, "");
  assert.equal(app.state.knowledgeOffset, 0); assert.equal(app.state.session, "active");
});

test("archiving on the last page reloads its server offset and adopts the server's corrected last page", async t => {
  const app = fixture(), calls: { url: URL; method: string; body?: any }[] = [];
  app.state.memoryDetails = page(50, 51); app.state.knowledgeOffset = 50;
  app.actions.push({ disabled: false, dataset: { recordId: "last-item", knowledgeAction: "archive" } });
  app.render();
  t.mock.method(globalThis, "fetch", async (path: any, init: any) => {
    const call = { url: new URL(String(path), "http://test.invalid"), method: init?.method || "GET",
      ...(init?.body ? { body: JSON.parse(init.body) } : {}) }; calls.push(call);
    assert.equal(call.url.pathname, "/api/memory/knowledge");
    return json(call.method === "POST" ? { ok: true } : page(25, 50, "corrected-last-page"));
  });
  await app.actions[0].onclick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, { id: "viewed", record_id: "last-item", action: "archive" });
  assert.equal(calls[1].method, "GET"); assert.equal(calls[1].url.searchParams.get("offset"), "50");
  assert.equal(calls[1].url.searchParams.get("limit"), "25");
  assert.equal(app.state.knowledgeOffset, 25); assert.equal(app.state.memoryDetails.offset, 25);
  assert.match(app.html, /第 2 \/ 2 页 · 共 50 条/);
  assert.equal(app.pagers[0].disabled, false); assert.equal(app.pagers[1].disabled, true);
  assert.deepEqual(app.errors, []);
});
