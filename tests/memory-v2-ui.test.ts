import { test } from "node:test";
import assert from "node:assert/strict";
const { renderMemory, bindMemory, loadMemory } = await import(
  new URL("../core/ui/memory.js", import.meta.url).href
);

function fixture(tab = "local-facts", text = "") {
  const nodes: Record<string, any> = {};
  for (const selector of [
    "#memory-local-facts",
    "#local-facts-count",
    "[data-local-facts-save]",
    "[data-local-facts-reload]",
    "[data-memory-refresh]",
    "[data-memory-backup]",
  ])
    nodes[selector] = { value: text, disabled: false };
  const state: any = {
    session: "one",
    page: "memory",
    memoryTab: tab,
    memoryLoadedTab: tab,
    memoryLoadedSession: "one",
    memoryDetails: { text, revision: "v1", history: [] },
    localFactsDrafts: { one: { text, revision: "v1" } },
  };
  const errors: string[] = [];
  return {
    state,
    nodes,
    errors,
    content: {
      querySelector: (selector: string) => nodes[selector] || null,
      querySelectorAll: () => [],
    },
    toast(message: string, error: boolean) {
      if (error) errors.push(message);
    },
    render() {},
    dialog() {},
  };
}

test("cognition maintenance exposes provenance and rollback without reviving superseded records", () => {
  const app = fixture("knowledge");
  app.state.memoryDetails = { items: [
    { id: "old", kind: "cognition", status: "superseded", superseded_by: "new", text: "旧判断" },
    { id: "new", kind: "cognition", status: "active", supersedes: ["old"], text: "新判断",
      change_reason: "<script>unsafe()</script>", uncertain: true },
    { id: "review", kind: "cognition", status: "review", text: "待确认",
      review: { reason: "资料矛盾", evidence: ["event"] } },
  ] };
  const html = renderMemory(app);
  assert.match(html, /包含已归档、已替代与待复核/);
  assert.match(html, /data-knowledge-action="undo" data-record-id="new"/);
  assert.match(html, /data-knowledge-action="restore" data-record-id="review"/);
  assert.doesNotMatch(html, /data-knowledge-action="restore" data-record-id="old"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /含不确定判断/);
});

test("local fact editor counts Unicode code points and refuses the total beyond 100", async (t) => {
  const app = fixture("local-facts", "鲸".repeat(99) + "🐋");
  let html = renderMemory(app);
  assert.match(html, /100 \/ 100 字符/);
  assert.doesNotMatch(html, /data-local-facts-save disabled/);
  assert.match(html, /共享事实对 AI 只读/);
  bindMemory(app);
  const input = app.nodes["#memory-local-facts"];
  input.value += "\n";
  input.oninput();
  assert.equal(app.nodes["[data-local-facts-save]"].disabled, true);
  assert.match(app.nodes["#local-facts-count"].textContent, /101 \/ 100/);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw Error("unexpected network");
  });
  await app.nodes["[data-local-facts-save]"].onclick();
  assert.equal(requests, 0);
  assert.match(app.errors[0], /100/);
  html = renderMemory(app);
  assert.match(html, /data-local-facts-save disabled/);
});

test("local fact saving binds the loaded session and revision, rejects stale-session handlers", async (t) => {
  const app = fixture("local-facts", "测试事实");
  bindMemory(app);
  const posts: any[] = [];
  t.mock.method(globalThis, "fetch", async (path: any, init: any) => {
    if (init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ text: "测试事实", revision: "v2" }));
    }
    return new Response(
      JSON.stringify(
        String(path).startsWith("/api/memory/local-facts")
          ? { text: "测试事实", revision: "v2" }
          : String(path).startsWith("/api/session/")
            ? { error: "fixture" }
            : {
                root: "memory",
                bytes: 0,
                facts: { count: 0 },
                summaries: { count: 0, bytes: 0 },
                sessions: { count: 0, bytes: 0, items: [] },
              },
      ),
    );
  });
  await app.nodes["[data-local-facts-save]"].onclick();
  assert.deepEqual(posts, [{ id: "one", text: "测试事实", revision: "v1" }]);
  assert.equal(app.state.localFactsDrafts.one.revision, "v2");
  app.state.session = "two";
  await app.nodes["[data-local-facts-save]"].onclick();
  assert.equal(posts.length, 1);
  assert.match(app.errors[0], /会话已切换/);
  assert.match(renderMemory(app), /正在读取记忆/);
  assert.doesNotMatch(renderMemory(app), /id="memory-local-facts"/);
});

test("late memory responses cannot replace a different session's facts", async (t) => {
  const app = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", async () => {
    await gate;
    return new Response(JSON.stringify({ text: "old result", revision: "v2" }));
  });
  const request = loadMemory(app);
  app.state.session = "two";
  release();
  await request;
  assert.equal(app.state.memoryLoadedSession, "one");
  assert.equal(app.state.localFactsDrafts.two, undefined);
});

test("knowledge view escapes sources and separates measured cumulative usage from context", () => {
  const app = fixture("knowledge");
  const marker = '<img src=x onerror="bad()">';
  app.state.memoryDetails = {
    items: [
      {
        id: '" onclick="bad',
        kind: "cognition",
        text: marker,
        source: marker,
        ts: "2026-10-28T00:00:00Z",
        status: "archived",
        freshness: 0.5,
        reason: marker,
        evidence: [marker],
      },
    ],
    usage: {
      chat: { input_tokens: 1000, output_tokens: 100, requests: 2 },
      memory: {
        input_tokens: 300,
        output_tokens: 30,
        requests: 2,
        unknown_requests: 1,
      },
    },
    spaces: [{ id: "team", name: "项目", joined: true }],
    memberships: ["team"],
    trace: { query: "旧事", selected: ["a"], estimated_tokens: 50 },
    settings: {},
  };
  const html = renderMemory(app);
  assert.ok(!html.includes(marker));
  assert.match(html, /&lt;img/);
  assert.match(html, /鲜活度 50%/);
  assert.match(html, /召回依据/);
  assert.match(html, /data-knowledge-action="restore"/);
  assert.match(html, /分享到空间/);
  assert.match(html, /聊天累计/);
  assert.match(html, /记忆整理累计/);
  assert.match(html, /估算 50 tokens/);
  assert.match(html, /已报告：300 输入/);
  assert.match(html, /含 1 次未报告用量请求/);
  assert.match(
    html,
    /name="daily_memory_tokens" required min="0" max="200000" step="1" value="20000"/,
  );
  assert.match(html, /0 停止自动摘要和认知提炼/);
});

test("daily memory budget can be set to zero independently from retrieval settings", async (t) => {
  const app = fixture("knowledge");
  delete app.nodes["#memory-local-facts"];
  const submit = { disabled: false };
  const form: any = { querySelector: () => submit };
  app.nodes["#memory-settings-form"] = form;
  app.state.memoryDetails = { memberships: ["team"] };
  const values = new Map([
    ["enabled", "on"],
    ["half_life_days", "30"],
    ["recall_tokens", "800"],
    ["daily_memory_tokens", "0"],
  ]);
  t.mock.method(globalThis, "FormData", function () {
    return {
      get: (key: string) => values.get(key),
      has: (key: string) => values.has(key),
    } as any;
  });
  const posts: any[] = [];
  t.mock.method(globalThis, "fetch", async (_path: any, init: any) => {
    if (init.method === "POST") posts.push(JSON.parse(init.body));
    return new Response(JSON.stringify({}));
  });
  bindMemory(app);
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(posts, [
    {
      id: "one",
      settings: {
        enabled: true,
        half_life_days: 30,
        recall_tokens: 800,
        daily_memory_tokens: 0,
      },
      memberships: ["team"],
    },
  ]);
  assert.deepEqual(app.errors, []);
});

test("shared spaces show explicit membership without implying local facts are shared", () => {
  const app = fixture("spaces");
  app.state.memoryDetails = {
    spaces: [
      { id: "a", name: "甲" },
      { id: "b", name: "乙" },
    ],
    memberships: ["b"],
  };
  const html = renderMemory(app);
  assert.match(html, /data-space-toggle="a" data-space-joined="false"/);
  assert.match(html, /data-space-toggle="b" data-space-joined="true"/);
  assert.match(html, /独立事实不会自动共享/);
  assert.match(html, /退出只改变当前会话的检索范围/);
});
