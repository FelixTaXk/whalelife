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

test("old policy fields do not restore deprecated controls or separate memory modes in the current form", () => {
  for (const policy of [{}, { memory_mode: "legacy" }, { memory_mode: "full" },
    { short_term_days: 14, short_term_min_messages: 1200, budget_tokens: 9000 }]) {
    const html = renderContextPanel(fixture(policy));
    assert.doesNotMatch(html, /name="(?:memory_mode|recent_lines|short_term_days|short_term_min_messages|budget_tokens|include_summary|long_term_enabled)"/);
    assert.doesNotMatch(html, /普通模式|日记模式|兼容模式|7 天|100 条|200 字符/);
    assert.match(html, /自动整理为日记/);
    assert.match(html, /name="compression_trigger_percent"[^>]*value="80"/);
    assert.match(html, /name="compression_target_percent"[^>]*value="50"/);
  }
});

test("history and diary flags remain independent and explicit false overrides the former diary mode", () => {
  const html = renderContextPanel(fixture({
    history_enabled: false,
    diary_enabled: true,
  }));
  assert.doesNotMatch(html, /name="history_enabled" checked/);
  assert.match(html, /name="diary_enabled" checked/);
  const legacy = renderContextPanel(fixture({
    history_enabled: undefined,
    recent_lines: 0,
    memory_mode: "diary",
  }));
  assert.doesNotMatch(legacy, /name="history_enabled" checked/);
  assert.match(legacy, /name="diary_enabled" checked/);
  assert.doesNotMatch(renderContextPanel(fixture({ memory_mode: "diary", diary_enabled: false })), /name="diary_enabled" checked/);
});

test("diary counts describe injected context and do not expand the compact chat meter", () => {
  const app: any = fixture();
  assert.doesNotMatch(renderContextPanel(app), /undefined|NaN|短期 300 条/);
  app.state.memoryContext.memory_window = {
    short_term_messages: 300,
    long_term_messages: 0,
    short_summary_chars: 128,
    long_summary_chars: 0,
  };
  assert.doesNotMatch(renderContextPanel(app), /短期 300 条|长期 0 条|短期摘要 128/);
  app.state.memoryContext.diary = { count: 1, covered_messages: 40, remaining_messages: 260, chars: 400, enabled: false };
  assert.match(renderContextPanel(app), /日记 1 篇 · 覆盖 40 条原文 · 剩余 260 条原文 · 400 字符/);
  assert.doesNotMatch(renderContextPanel(app), /400 \/ 200|仅供查看/);
  const compact = renderContextMeter(app.state.memoryContext, true);
  assert.match(compact, /chat-context-compact/);
  assert.doesNotMatch(compact, /short_term_days|长期范围|<details|<form/);
});

test("saving from an old policy sends only current independent flags and percentages to the selected archive", async (t) => {
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
    { history_enabled: true, diary_enabled: false, include_facts: false },
    { history_enabled: false, diary_enabled: true, include_facts: true },
    { history_enabled: false, diary_enabled: false, include_facts: false },
  ]) {
    values = new Map([
      ["compression_trigger_percent", "90"],
      ["compression_target_percent", "60"],
      ["history_scope", "persona"],
      ...Object.entries(flags).filter(([, on]) => on).map(([name]) => [name, "on"] as [string, string]),
    ]);
    await form.onsubmit({ preventDefault() {} });
    assert.deepEqual(posts.at(-1), {
      id: "one",
      context: {
        ...flags,
        compression_trigger_percent: 90,
        compression_target_percent: 60,
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
  assert.match(html, /日记与摘要/);
  assert.match(html, /<strong>短期摘要<\/strong>/);
  assert.match(html, /<strong>长期概览<\/strong>/);
  assert.match(html, /data-summary="s_example"/);
  assert.match(html, /data-summary="p_example"/);
  assert.match(html, /来源失效的内容不会带入/);
  assert.doesNotMatch(html, /普通模式|日记模式|兼容模式/);
});
