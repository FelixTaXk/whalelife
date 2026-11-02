import { test } from "node:test";
import assert from "node:assert/strict";

const { renderContextPanel, renderContextMeter, bindContextSettings } =
  await import(new URL("../core/ui/context.js", import.meta.url).href);
const { renderMemory } = await import(
  new URL("../core/ui/memory.js", import.meta.url).href
);

function fixture(policy: Record<string, unknown> = {}) {
  return {
    state: {
      session: "one", memoryLoadedSession: "one",
      memoryContext: {
        name: "测试会话",
        model: { name: "测试模型", context_window: 32000 },
        usage: null,
        available_messages: 300,
        stored_messages: 330,
        policy: {
          history_enabled: true,
          short_term_days: 7,
          short_term_min_messages: 100,
          budget_tokens: 6000,
          include_facts: true,
          include_summary: true,
          long_term_enabled: true,
          history_scope: "session",
          ...policy,
        },
      },
    },
  };
}

test("context settings distinguish the short-term floor, time window and injection budget", () => {
  const html = renderContextPanel(fixture());
  assert.match(html, /name="short_term_days"[^>]*min="1" max="3650"[^>]*value="7"/);
  assert.match(html, /name="short_term_min_messages"[^>]*min="1" max="10000"[^>]*value="100"/);
  assert.match(html, /name="budget_tokens"[^>]*min="100" max="10000000"[^>]*value="6000"/);
  assert.doesNotMatch(html, /name="recent_lines"|带入的历史消息数/);
  assert.match(html, /早于 7 天”且“超出最近 100 条/);
  assert.match(html, /100 条是保底，不是上限/);
  assert.match(html, /历史预算仅裁剪带入内容，不改变长期归类/);
  assert.match(html, /一个月仅 20 条时全部仍属短期；一天 300 条也全部属短期/);
  assert.match(html, /摘要最多 200 字符，不生成认知/);
  assert.match(html, /至少 10 条未处理消息/);
  assert.match(html, /最多 2 条认知，每条最多 80 字符/);
  assert.match(html, /每轮最多一次整理调用，短期压缩优先/);
  const custom = renderContextPanel(fixture({ short_term_days: 14, short_term_min_messages: 1200 }));
  assert.match(custom, /早于 14 天”且“超出最近 1200 条/);
});

test("independent switches render explicit settings and preserve legacy disabled defaults", () => {
  const html = renderContextPanel(fixture({
    history_enabled: false,
    include_summary: false,
    long_term_enabled: true,
  }));
  assert.doesNotMatch(html, /name="history_enabled" checked|name="include_summary" checked/);
  assert.match(html, /name="long_term_enabled" checked/);
  const legacy = renderContextPanel(fixture({
    history_enabled: undefined,
    long_term_enabled: undefined,
    short_term_days: undefined,
    short_term_min_messages: undefined,
    recent_lines: 0,
    include_summary: false,
  }));
  assert.doesNotMatch(legacy, /name="history_enabled" checked|name="long_term_enabled" checked/);
  assert.match(legacy, /name="short_term_days"[^>]*value="7"/);
  assert.match(legacy, /name="short_term_min_messages"[^>]*value="100"/);
});

test("memory-window counts are optional and do not expand the compact chat meter", () => {
  const app: any = fixture();
  assert.doesNotMatch(renderContextPanel(app), /undefined|NaN|短期 300 条/);
  app.state.memoryContext.memory_window = {
    short_term_messages: 300,
    long_term_messages: 0,
    short_summary_chars: 128,
    long_summary_chars: 0,
  };
  const html = renderContextPanel(app);
  assert.match(html, /短期 300 条 · 长期 0 条/);
  assert.match(html, /现存短期摘要 128 字符 · 长期概览 0 字符/);
  app.state.memoryContext.memory_window.long_summary_chars = 400;
  assert.match(renderContextPanel(app), /长期概览 400 字符/);
  assert.doesNotMatch(renderContextPanel(app), /400 \/ 200/);
  const compact = renderContextMeter(app.state.memoryContext, true);
  assert.match(compact, /chat-context-compact/);
  assert.doesNotMatch(compact, /short_term_days|长期范围|<details|<form/);
});

test("saving context sends independent toggles and temporal values without the deprecated cap", async (t) => {
  const app: any = fixture();
  const submit = { disabled: false };
  const error = { textContent: "" };
  const form: any = {
    querySelector: (selector: string) => selector === "#context-error" ? error : submit,
  };
  app.content = { querySelector: (selector: string) => selector === "#context-form" ? form : null };
  app.toast = () => {};
  let reloads = 0;
  let values = new Map<string, string>();
  const posts: any[] = [];
  t.mock.method(globalThis, "FormData", function () {
    return {
      get: (key: string) => values.get(key),
      has: (key: string) => values.has(key),
    } as any;
  });
  t.mock.method(globalThis, "fetch", async (path: any, init: any) => {
    assert.equal(path, "/api/session/context");
    assert.equal(init.method, "POST");
    const post = JSON.parse(init.body);
    posts.push(post);
    return new Response(JSON.stringify({ policy: post.context }));
  });
  bindContextSettings(app, async () => { reloads++; });
  for (const flags of [
    { history_enabled: true, include_summary: false, long_term_enabled: true, include_facts: false },
    { history_enabled: false, include_summary: true, long_term_enabled: false, include_facts: true },
    { history_enabled: false, include_summary: false, long_term_enabled: false, include_facts: false },
  ]) {
    values = new Map([
      ["short_term_days", "14"],
      ["short_term_min_messages", "1200"],
      ["budget_tokens", "9000"],
      ["history_scope", "persona"],
      ...Object.entries(flags).filter(([, on]) => on).map(([name]) => [name, "on"] as [string, string]),
    ]);
    await form.onsubmit({ preventDefault() {} });
    assert.deepEqual(posts.at(-1), {
      id: "one",
      context: {
        ...flags,
        short_term_days: 14,
        short_term_min_messages: 1200,
        budget_tokens: 9000,
        history_scope: "persona",
      },
    });
  }
  assert.equal(reloads, 3);
  assert.equal(error.textContent, "");
  const activeMeter = app.state.sessionContext;
  app.state.memorySession = app.state.memoryLoadedSession = "two";
  bindContextSettings(app, async () => { reloads++; });
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts.at(-1).id, "two", "editing a viewed archive targets that archive");
  assert.equal(app.state.session, "one");
  assert.strictEqual(app.state.sessionContext, activeMeter, "archive edits do not overwrite the active chat's meter");
  app.state.memorySession = "three";
  await form.onsubmit({ preventDefault() {} });
  assert.equal(posts.length, 4, "an obsolete editor cannot save after browsing another archive");
  assert.match(error.textContent, /档案已改变/);
});

test("summary archive distinguishes short summaries and compatible long overviews", () => {
  const html = renderMemory({ state: {
    session: "one",
    memoryTab: "summaries",
    memoryLoadedTab: "summaries",
    memoryLoadedSession: "one",
    memoryDetails: { items: [
      { id: "s_example", bytes: 100 },
      { id: "p_example", bytes: 200 },
    ] },
  } });
  assert.match(html, /短期摘要与长期概览/);
  assert.match(html, /s_example<\/strong><small>短期摘要/);
  assert.match(html, /p_example<\/strong><small>长期概览/);
  assert.match(html, /旧摘要保留至下次生成/);
});
