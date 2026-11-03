import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { clock, timezone, timestamp, occurrence, timeContext, timeLabel, collectTimes, summaryTime } from "../core/time.ts";
import { renderHistory, historyTail } from "../core/provenance.ts";
import { estimateTokens } from "../core/memory-engine.ts";
import { compressShort, consolidateLong } from "../core/memory-lifecycle.ts";
import { contextPolicy } from "../core/session-context.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

test("local clocks handle timezone, midnight, month/year boundaries and repeated DST hours", () => {
  const instant = Date.parse("2026-12-31T16:05:00Z");
  assert.equal(timezone(), "Asia/Shanghai");
  assert.equal(clock(undefined, instant).local, "2027-01-01 00:05");
  assert.equal(clock(undefined, instant).weekday, "星期五");
  assert.equal(clock("UTC", instant).local, "2026-12-31 16:05");
  assert.equal(clock("Asia/Shanghai", Date.parse("2028-02-29T16:01:00Z")).local, "2028-03-01 00:01");
  const a = clock("America/New_York", Date.parse("2026-11-01T05:30:00Z"));
  const b = clock("America/New_York", Date.parse("2026-11-01T06:30:00Z"));
  assert.equal(a.local, b.local); assert.notEqual(a.offset, b.offset);
  for (const invalid of [null, "", "not/a-zone", 8]) assert.throws(() => timezone(invalid), /时区/);
  for (const invalid of [undefined, "2026-10-30", "2026-10-30T10:00:00", "2026-02-30T12:00:00Z", "2026-01-01T24:00:00Z", "bad"])
    assert.equal(timestamp(invalid), null);
  assert.equal(occurrence("2026-10-30T08:00:00+08:00"), "2026-10-30T00:00:00.000Z");
  assert.match(timeLabel("bad"), /未记录或无效/);
});

test("conversation gaps ignore tool/background events and never invent missing or negative durations", () => {
  const now = Date.parse("2026-10-30T00:00:00Z"), received = new Date(now).toISOString();
  const history = [{ type: "message", role: "assistant", ts: "2026-10-28T00:00:00Z" },
    { type: "tool", ts: received }, { type: "channel_receipt", ts: received }];
  assert.match(timeContext("Asia/Shanghai", received, history, now), /上次交流约2天/);
  assert.match(timeContext("Asia/Shanghai", received, [], now), /上次交流未知/);
  assert.match(timeContext("Asia/Shanghai", received, [...history, { type: "message", role: "user" }], now), /上次交流未知/);
  assert.match(timeContext("Asia/Shanghai", received, [{ type: "message", role: "user", ts: "2027-01-01T00:00:00Z" }], now), /时间记录异常/);
});

test("history groups time/source labels, restores the trimmed boundary and includes label tokens", () => {
  const rows = ["2026-10-30T15:59:00Z", "2026-10-30T15:59:30Z", "2026-10-30T16:01:00Z"].map((ts, i) =>
    ({ role: i % 2 ? "assistant" : "user", content: "一段对话".repeat(25), ts, origin: { channel: "web" } }));
  const rendered = renderHistory(rows, "Asia/Shanghai");
  assert.match(rendered[0].content, /2026-10-30 23:59/);
  assert.doesNotMatch(rendered[1].content, /历史来源/);
  assert.match(rendered[2].content, /2026-10-31 00:01/);
  const capacity = historyTail(rows.slice(1), Infinity, estimateTokens, 0, "Asia/Shanghai").tokens;
  const tail = historyTail(rows, capacity, estimateTokens, 0, "Asia/Shanghai");
  assert.equal(tail.omitted, 1);
  assert.match(renderHistory(tail.rows, "Asia/Shanghai")[0].content, /2026-10-30 23:59/);
  assert.ok(estimateTokens(JSON.stringify(renderHistory(tail.rows, "Asia/Shanghai"))) <= tail.tokens);
  assert.match(renderHistory([{ role: "user", content: "旧消息" }], "UTC")[0].content, /时间未记录/);
  assert.match(summaryTime(collectTimes({ text: "旧摘要" }, [{ ts: rows[0].ts }]), "UTC"), /部分时间缺失/);
});

async function fixture(t: TestContext, isolated = false) {
  const root = await temporaryDirectory("whale-time-context-");
  let app: any;
  t.after(async () => { t.mock.timers.reset(); await app?.close(); });
  await mkdir(join(root, "config"));
  await mkdir(join(root, "plugins"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 }, providers: [{ id: "test", base_url: "https://unused.invalid/v1" }],
    models: [{ id: "chat", name: "Chat", provider: "test", model: "test", type: "chat", enabled: true, context_window: 32000 }],
    model_bindings: { chat: "chat" },
    personas: { a: { name: "A", file: "a.md", permission: "full" }, b: { name: "B", file: "b.md", permission: "off" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  if (isolated) {
    await mkdir(join(root, "plugins/time-probe"));
    await writeFile(join(root, "plugins/time-probe/plugin.yaml"), 'id: time-probe\nname: Time probe\nversion: 1.0.0\ndescription: Test only\n');
    await writeFile(join(root, "plugins/time-probe/index.ts"), `export function apply(ctx) {
      ctx.provide('time-probe', { run: (text) => ctx.sessions.run({text}),
        experience: (id, input) => ctx.memory.recordExperience(id, input),
        raw: () => ctx.llm.chat({model:'chat',messages:[{role:'user',content:'raw request'}]}) });
    }`);
  }
  app = await boot(root);
  const requests: any[] = [];
  app.llm.chat = async (r: any) => { requests.push(structuredClone(r.messages)); return { text: "模拟回复", toolCalls: [], usage: { prompt_tokens: 51, completion_tokens: 9 } }; };
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  const cookie = (await fetch(url + "/api/login", { method: "POST", body: "{}" })).headers.get("set-cookie")!.split(";")[0];
  const api = async (path: string, input?: any) => {
    const r = await fetch(url + path, { method: input === undefined ? "GET" : "POST", headers: { Cookie: cookie }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const data = await r.json(); if (!r.ok) throw Error(data.error); return data;
  };
  const draft = () => { const s = app.modelConfig.snapshot(); return { ...s, personaModels: Object.fromEntries(s.personas.map((p: any) => [p.id, p.model])) }; };
  return { app, root, requests, api, draft };
}

test("Web and isolated plugin sessions receive time by default; direct LLM stays raw and usage/facts remain correct", async (t) => {
  const { app, requests, api } = await fixture(t, true), id = await app.sessions.current();
  const probe = app.runtime.services.get("time-probe").value;
  await app.channels.web(id, "今天是哪天", () => {});
  await probe.run("继续昨天的话题");
  const status = await api("/api/status");
  for (const messages of requests) assert.match(messages[0].content, /主干时间.*Asia\/Shanghai/);
  assert.ok(requests.at(-1)[0].content.includes(status.clock.local.slice(0, 10)));
  assert.match(requests.at(-1)[1].content, /消息时间/);
  assert.equal((await app.memoryEngine.state(id)).usage.chat.input_tokens, 102);
  assert.equal((await app.memoryEngine.state(id)).usage.chat.requests, 2);
  assert.equal((await app.memoryEngine.localFacts(id)).text, "");
  const item = await probe.experience(id, { event_id: "imported", outcome: "succeeded", text: "旧星图阅读经历", occurred_at: "2020-01-01T08:00:00+08:00" });
  assert.equal(item.occurred_at, "2020-01-01T00:00:00.000Z");
  assert.notEqual(item.ts.slice(0, 10), "2020-01-01");
  await app.sessions.chat(id, "旧星图阅读经历是什么", () => {});
  assert.match(requests.at(-1)[0].content, /occurred_time.*2020-01-01 08:00/);
  await assert.rejects(app.memoryEngine.experience(id, "test", { event_id: "bad", outcome: "succeeded", text: "bad", occurred_at: "2026-02-30T12:00:00Z" }), /发生时间/);
  await probe.raw();
  assert.deepEqual(requests.at(-1), [{ role: "user", content: "raw request" }]);
});

test("timezone settings save atomically, survive restart, preserve old clients and render the server clock", async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.root, "config/config.json"), "utf8");
  await assert.rejects(f.api("/api/model-config", { ...f.draft(), timezone: "not/a-zone" }), /时区/);
  assert.equal(await readFile(join(f.root, "config/config.json"), "utf8"), original);
  const saved = await f.api("/api/model-config", { ...f.draft(), timezone: "America/New_York" });
  assert.equal(saved.timezone, "America/New_York");
  await assert.rejects(f.api("/api/model-config", { ...f.draft(), revision: "stale", timezone: "UTC" }), /修改/);
  const old = f.draft(); delete old.timezone;
  await f.api("/api/model-config", old);
  assert.equal(f.app.config.timezone, "America/New_York");
  const status = await f.api("/api/status");
  const { renderBindings } = await import(new URL("../core/ui/views.js", import.meta.url).href);
  const html = renderBindings({ state: { config: f.app.modelConfig.snapshot(), status } });
  assert.doesNotMatch(html, /name="timezone"|workspace-timezone|timezone-options/);
  assert.ok(html.includes(status.clock.local));
  await f.api("/api/model-config", { ...f.draft(), timezone: "Asia/Shanghai" });
  await f.app.sessions.chat("zone-history", "明天见", () => {});
  await f.api("/api/model-config", { ...f.draft(), timezone: "America/New_York" });
  await f.app.sessions.chat("zone-history", "继续", () => {});
  assert.match(f.requests.at(-1)[0].content, /主干时间.*America\/New_York/);
  assert.match(f.requests.at(-1)[1].content, /消息时间.*UTC\+8/);
  assert.equal((await f.app.memory.readSession("zone-history"))[0].timezone, "Asia/Shanghai");
  await f.app.close();
  const restarted = await boot(f.root); t.after(() => restarted.close());
  assert.equal(restarted.config.timezone, "America/New_York");
});

test("tool continuation refreshes time across midnight and preserves the original message date", async (t) => {
  const { app, requests } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-31T15:59:00Z") });
  await app.runtime.load("date-turn", { id: "date-turn", name: "Test", version: "1", description: "Test" }, (ctx: any) => {
    ctx.tools.register({ name: "date_turn", description: "Test", schema: {}, danger: "safe", run: () => {
      t.mock.timers.setTime(Date.parse("2026-12-31T16:01:00Z")); return "completed";
    } });
  });
  app.llm.chat = async (r: any) => {
    requests.push(structuredClone(r.messages));
    return { text: requests.length === 1 ? "" : "结束", toolCalls: requests.length === 1 ? [{ id: "one", name: "date_turn", arguments: "{}" }] : [], usage: { prompt_tokens: 80, completion_tokens: 10 } };
  };
  await app.sessions.chat("test", "明天去看牙", () => {});
  assert.match(requests[0][0].content, /当前 2026-12-31 23:59/);
  assert.match(requests[1][0].content, /当前 2027-01-01 00:01/);
  assert.match(requests[1][0].content, /本条消息 2026-12-31 23:59/);
  assert.equal(requests[0][0].content.split("【主干时间】")[0], requests[1][0].content.split("【主干时间】")[0]);
  assert.equal((await app.memoryEngine.state("test")).usage.chat.input_tokens, 160);
  assert.equal((await app.memory.readSession("test"))[0].text, "明天去看牙");
});

test("gap metadata respects disabled history and persona boundaries", async (t) => {
  const { app, requests } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-30T00:00:00Z") });
  await app.memory.appendEvent({ session: "test", type: "message", role: "user", ts: "2026-10-28T00:00:00Z", text: "旧消息", persona_revision: "other" });
  await app.memory.appendEvent({ session: "test", type: "tool", text: "后台记录" });
  await app.sessions.chat("test", "现在呢", () => {});
  assert.match(requests.at(-1)[0].content, /上次交流约2天/);
  await app.sessions.updateContext("test", { ...contextPolicy({}), history_enabled: false });
  await app.sessions.chat("test", "不带历史", () => {});
  assert.match(requests.at(-1)[0].content, /上次交流未知/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /旧消息/);
  await app.sessions.updateContext("test", { ...contextPolicy({}), history_scope: "persona" });
  app.config.channels.web.persona = "b";
  await app.sessions.chat("test", "另一人格", () => {});
  assert.match(requests.at(-1)[0].content, /上次交流未知/);
});

test("short/long summaries receive dated evidence and persist source ranges independently of model output", async (t) => {
  const { app, requests } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-30T00:00:00Z") });
  for (let i = 0; i < 12; i++) await app.memory.appendEvent({ session: "past", type: "message", role: "user",
    ts: `2026-09-30T${String(i).padStart(2, "0")}:00:00Z`, timezone: "Asia/Shanghai", text: "明天去看牙，保留关键日期。".repeat(40) });
  app.llm.chat = async (r: any) => {
    requests.push(structuredClone(r.messages));
    const data = JSON.parse(r.messages[1].content);
    return { text: JSON.stringify(r.max_tokens === 1024 ? { summary: "约定2026-10-01看牙。" } : {
      summary: "2026-09-30讨论过看牙约定。", cognition: [{ text: "2026-09-30提到牙科安排。", evidence: [data.episodes[0].id], time_range: { start: "forged" } }],
    }), toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 20 } };
  };
  const rows = await app.memory.readSession("past"), options = { services: app, id: "past", provider: {}, limit: 32000, rows, timezone: "Asia/Shanghai" };
  await compressShort({ ...options, key: "s_time", checkpoint: { covered: 0 }, overflow: rows.slice(0, 4) });
  await consolidateLong({ ...options, key: "p_time", policy: contextPolicy({ short_term_min_messages: 1 }), revision: "test" });
  assert.equal(requests.length, 2);
  for (const messages of requests) {
    assert.match(messages[0].content, /记录时间不等于事情发生时间/);
    const data = JSON.parse(messages[1].content);
    assert.match(data.episodes[0].message_time, /2026-09-30 08:00/);
    assert.equal(data.episodes[0].ts, "2026-09-30T00:00:00Z");
    assert.equal(data.timezone, "Asia/Shanghai");
  }
  const state = await app.memoryEngine.state("past");
  assert.equal(state.summaries.s_time.time_range.start, "2026-09-30T00:00:00.000Z");
  const cognition = state.records.find((r: any) => r.kind === "cognition");
  assert.equal(cognition.time_range.start, "2026-09-30T00:00:00.000Z");
  assert.equal(cognition.ts.slice(0, 10), "2026-10-30");
  assert.equal((await app.memoryEngine.localFacts("past")).text, "");
  assert.equal((await app.memory.readSession("past"))[0].text, rows[0].text);
});
