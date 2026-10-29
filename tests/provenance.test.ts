import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { boot } from "../core/index.ts";
import { MemoryEngine, estimateTokens, validateMemoryState } from "../core/memory-engine.ts";
import { collectOrigins, historyTail, originOf, pluginOrigin, renderHistory } from "../core/provenance.ts";
import { compressShort, consolidateLong, shortSummaryKey } from "../core/memory-lifecycle.ts";
import { contextPolicy } from "../core/session-context.ts";
import { createHash } from "node:crypto";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-provenance-"));
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "demo", protocol: "openai-compatible", base_url: "https://unused.example/v1" }],
    models: [{ id: "chat", provider: "demo", model: "chat", type: "chat", enabled: true, context_window: 200000 }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "Test", file: "a.md", model: "chat" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  const app = await boot(root), requests: any[] = [];
  app.llm.chat = async (r: any) => {
    requests.push({ messages: structuredClone(r.messages), max_tokens: r.max_tokens });
    if (r.max_tokens === 400) return { text: JSON.stringify({ summary: "保留不同来源的交流约定。" }), toolCalls: [] };
    if (r.max_tokens === 1000) {
      const input = JSON.parse(r.messages[1].content);
      return { text: JSON.stringify({ summary: "交流中讨论了星光。", cognition: [{ text: "用户讨论过星光。", evidence: [input.episodes[0].id],
        origins: [{ plugin: "forged-by-model" }] }] }), toolCalls: [] };
    }
    return { text: "收到", toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 3 } };
  };
  t.after(async () => { await app.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const install = (id: string, apply: any) => app.runtime.load(id, { id, name: id, version: "1", description: "synthetic plugin" }, apply);
  return { root, app, requests, install };
}
const message = (id: string, text = "星光约定", peer = "peer") => ({ peer, sender: "sender", messageId: id, text });

test("unlisted platform plugins declare their names; one shared session retains per-message provenance", async (t) => {
  const { app, requests, install } = await fixture(t);
  let first: any, second: any;
  await install("nebula-link", (ctx: any) => { first = ctx.channels.register({ id: "nebula", name: "星港交流", account: "a", persona: "a", send: async () => {} }); });
  await install("ink-link", (ctx: any) => { second = ctx.channels.register({ id: "ink", name: "墨湾交流", account: "b", persona: "a", send: async () => {} }); });
  await app.memory.saveSessionMeta("shared", {});
  await first.bind("peer", "shared"); await second.bind("peer", "shared");
  await first.receive(message("one"));
  await second.receive(message("two", "继续星光约定"));
  await first.receive(message("three"));
  const prompt = requests.at(-1).messages;
  assert.match(prompt[0].content, /当前交流来源.*nebula-link.*星港交流/);
  assert.match(prompt[1].content, /星港交流/);
  assert.match(prompt[3].content, /墨湾交流/);
  assert.ok(!prompt[2].content.includes("历史来源"), "consecutive source tags are not repeated");
  const rows = (await app.memory.readSession("shared")).filter((x: any) => x.type === "message");
  assert.equal(rows[0].origin.plugin, "nebula-link"); assert.equal(rows[2].origin.plugin, "ink-link");
  assert.equal(rows[1].origin.action, "生成回复");
  assert.throws(() => first.receive({ ...message("bad"), origin: { plugin: "ink-link" } }), /路由策略/);
  assert.throws(() => app.channels.register({ id: "bad", name: "x\ny", account: "a", persona: "a", send: async () => {} }), /来源/);
});

test("plugin actions, tool observations and explicit experiences preserve declared origin through search and recall", async (t) => {
  const { app, requests, install } = await fixture(t);
  let memory: any;
  await install("orbit-video", (ctx: any) => {
    memory = ctx.memory;
    ctx.tools.register({ name: "orbit_read", description: "读取虚构视频", schema: {}, danger: "safe",
      origin: { platform: "轨道视频", action: "读取视频内容" }, run: async () => "视频介绍星光，不是用户的个人观点" });
  });
  await app.memory.saveSessionMeta("one", {});
  await app.tools.call("orbit_read", {}, { id: "one", permission: "full" }, "call-one");
  await memory.recordExperience("one", { event_id: "view-one", outcome: "succeeded", text: "阅读了星光视频的字幕。",
    origin: { platform: "轨道视频", action: "读取字幕" } });
  await assert.rejects(memory.recordExperience("one", { event_id: "spoof", outcome: "succeeded", text: "bad", origin: { plugin: "other" } }), /来源/);
  const state = await app.memoryEngine.state("one");
  assert.equal(state.records[0].origin.plugin, "orbit-video");
  assert.equal(state.records[0].origin.action, "读取视频内容");
  assert.equal(state.records[1].origin.platform, "轨道视频");
  const found = await app.memoryEngine.search("one", "轨道视频", { manual: true });
  assert.equal(found.items.length, 2, "platform names are searchable without rewriting the action text");
  const recalled = await app.tools.call("recall_memory", { query: "轨道视频" }, { id: "one", permission: "full" });
  assert.ok(recalled.result.every((x: any) => x.origin.plugin === "orbit-video"));
  await app.sessions.chat("one", "轨道视频里的星光是什么", () => {});
  assert.match(requests.at(-1).messages[0].content, /orbit-video.*轨道视频/);
  const isolated = await app.memoryEngine.search("isolated", "轨道视频", { manual: true });
  assert.equal(isolated.items.length, 0);
});

test("summarization receives origins and stores bounded attribution independently of generated prose", async (t) => {
  const { app, requests } = await fixture(t), key = "p_source";
  const origins = [{ plugin: "nebula-link", channel: "nebula", platform: "星港交流", action: "接收消息" },
    { plugin: "ink-link", channel: "ink", platform: "墨湾交流", action: "接收消息" }];
  for (let i = 0; i < 12; i++) await app.memory.appendEvent({ session: "one", type: "message", role: "user", text: "星光讨论".repeat(20),
    ts: new Date(Date.now() - 30 * 86400000).toISOString(), origin: origins[i % 2] });
  const rows = await app.memory.readSession("one");
  const options = { services: app, id: "one", provider: {}, limit: 200000, rows };
  await compressShort({ ...options, key: shortSummaryKey(key), overflow: rows.slice(0, 4), checkpoint: { covered: 0 } });
  const short = await app.memoryEngine.summaryState("one", shortSummaryKey(key));
  assert.deepEqual(short.origins, origins);
  assert.equal(JSON.parse(requests[0].messages[1].content).episodes[0].origin.platform, "星港交流");
  await consolidateLong({ ...options, key, policy: contextPolicy({ short_term_min_messages: 2 }), revision: "test" });
  const state = await app.memoryEngine.state("one");
  assert.deepEqual(state.summaries[key].origins, origins);
  assert.deepEqual(state.records[0].origins, [origins[0]], "cognition origin is derived from evidence, not model-supplied labels");
  const reopened = new MemoryEngine(app.memory);
  assert.deepEqual((await reopened.summaryState("one", key)).origins, origins);
  const candidates = await reopened.cognitionCandidates("one", "星光");
  assert.deepEqual(candidates[0].origins, [origins[0]]);
  const actualKey = "p_" + createHash("sha256").update("one:session").digest("hex").slice(0, 40);
  await reopened.summaryState("one", actualKey, state.summaries[key]);
  await app.sessions.chat("one", "还记得星光吗", () => {});
  assert.match(requests.at(-1).messages[0].content, /星港交流/);
  const damaged = structuredClone(state); damaged.records[0].origins[0].platform = "字".repeat(33);
  assert.throws(() => validateMemoryState(damaged), /来源/);
});

test("legacy and mixed provenance stays honest; source lists are bounded and trimming restores the first label", () => {
  assert.deepEqual(originOf({ channel: "legacy-transport" }), { channel: "legacy-transport" });
  assert.equal(originOf({ text: "I mentioned QQ but the source is unknown" }), undefined);
  const summary = collectOrigins({ text: "legacy summary" }, Array.from({ length: 12 }, (_, i) => ({ origin: { plugin: "plugin-" + i } })));
  assert.equal(summary.origins.length, 8); assert.equal(summary.origins_incomplete, true);
  assert.throws(() => pluginOrigin("mine", { platform: "x".repeat(33) }), /来源/);
  const rows = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "正文".repeat(10),
    origin: { plugin: "nebula-link", channel: "nebula", platform: "星港交流", action: i % 2 ? "生成回复" : "接收消息" } }));
  assert.equal(renderHistory(rows).filter(x => x.content.includes("历史来源")).length, 1);
  const trimmed = historyTail(rows, 200, estimateTokens);
  const rendered = renderHistory(trimmed.rows);
  assert.ok(trimmed.omitted > 0 && rendered.length > 0);
  assert.match(rendered[0].content, /星港交流/);
  assert.ok(estimateTokens(JSON.stringify(rendered)) <= trimmed.tokens && trimmed.tokens <= 200);
});
