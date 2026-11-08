import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryEngine, charCount } from "../core/memory-engine.ts";
import { Tools } from "../core/tools.ts";
import { registerMemoryTools } from "../core/memory-tools.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-memory-engine-"));
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  const engine = new MemoryEngine(memory);
  t.after(async () => {
    await memory.queue;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, memory, engine, logger };
}

test("independent facts have a whole-document 100-code-point limit and revision-safe history", async (t) => {
  const { engine } = await fixture(t);
  const empty = await engine.localFacts("one");
  assert.equal(empty.text, "");
  const hundred = "🐋".repeat(98) + " \n";
  assert.equal(charCount(hundred), 100);
  const saved = await engine.saveLocalFacts("one", hundred, empty.revision);
  assert.equal(saved.text, hundred);
  assert.equal(saved.chars, 100);
  await assert.rejects(engine.saveLocalFacts("one", hundred + "!"), /100/);
  assert.equal((await engine.localFacts("one")).text, hundred);
  await assert.rejects(
    engine.saveLocalFacts("one", "误覆盖", empty.revision),
    /变更/,
  );
  const revised = await engine.saveLocalFacts(
    "one",
    "喜欢蓝色",
    saved.revision,
  );
  assert.equal(revised.history[0].text, hundred);
  assert.equal((await engine.localFacts("two")).text, "");
  assert.equal(
    (await engine.saveLocalFacts("one", "", revised.revision)).chars,
    0,
  );
});

test("concurrent append cannot evade the aggregate character cap", async (t) => {
  const { engine } = await fixture(t);
  await engine.saveLocalFacts("one", "甲".repeat(98));
  const results = await Promise.allSettled([
    engine.saveLocalFacts("one", "乙", undefined, true),
    engine.saveLocalFacts("one", "丙", undefined, true),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(results.filter((x) => x.status === "rejected").length, 1);
  assert.equal((await engine.localFacts("one")).chars, 100);
});

test("AI tools cannot write shared or another session's facts even with full permission", async (t) => {
  const { engine, memory, logger } = await fixture(t);
  await memory.writeFacts(["人类维护的共享事实"]);
  await engine.saveLocalFacts("other", "其他会话");
  const tools = new Tools(logger);
  const dispose = registerMemoryTools(tools, engine);
  const session = { id: "one", permission: "full" };
  const added = await tools.call(
    "remember_fact",
    { text: "喜欢蓝色" },
    session,
  );
  assert.equal(added.ok, true);
  assert.equal(
    added.result.history,
    undefined,
    "model tool results must not inject archived fact revisions",
  );
  for (const extra of [
    { scope: "shared" },
    { session: "other" },
    { id: "other" },
    { actor: "user" },
  ]) {
    assert.equal(
      (await tools.call("edit_facts", { text: "越权", ...extra }, session)).ok,
      false,
    );
  }
  assert.equal(
    (await tools.call("edit_facts", { text: "甲".repeat(101) }, session)).ok,
    false,
  );
  assert.equal((await engine.localFacts("one")).text, "喜欢蓝色");
  assert.equal((await engine.localFacts("other")).text, "其他会话");
  assert.deepEqual(await memory.readFacts(), ["人类维护的共享事实"]);
  assert.equal(
    (await tools.call("edit_facts", { text: "" }, session)).ok,
    true,
  );
  assert.equal((await engine.localFacts("one")).text, "");
  dispose();
  assert.equal(tools.entries.has("remember_fact"), false);
});

test("shared memories require explicit publication and membership, which is revocable", async (t) => {
  const { engine } = await fixture(t);
  const note = await engine.record("one", {
    kind: "episode",
    text: "蓝鲸计划在周五交付",
    source: "user",
  });
  assert.equal(
    (await engine.search("two", "蓝鲸计划", { manual: true })).items.length,
    0,
  );
  const space = await engine.createSpace("工作小组");
  const settings = (await engine.state("one")).settings;
  await engine.settings("one", settings, [space.id]);
  await engine.settings("two", settings, [space.id]);
  assert.equal(
    (await engine.search("two", "蓝鲸计划", { manual: true })).items.length,
    0,
  );
  await engine.change("one", note.id, "share", space.id);
  const found = (await engine.search("two", "蓝鲸计划", { manual: true }))
    .items;
  assert.equal(found.length, 1);
  assert.equal(found[0].id, note.id);
  assert.equal(found[0].shared_space, "工作小组");
  await assert.rejects(engine.change("two", note.id, "archive"), /不属于/);
  await engine.settings("two", settings, []);
  assert.equal(
    (await engine.search("two", "蓝鲸计划", { manual: true })).items.length,
    0,
  );
});

test("old experiences decay without disappearing, and exact historical queries can still retrieve them", async (t) => {
  const { engine, memory } = await fixture(t);
  await memory.appendEvent({
    session: "one",
    type: "message",
    role: "user",
    text: "旧蓝鲸计划：周五交付",
    ts: "2020-01-01T00:00:00Z",
  });
  await memory.appendEvent({
    session: "one",
    type: "message",
    role: "user",
    text: "新蓝鲸计划：周六交付",
  });
  const result = await engine.search("one", "蓝鲸计划", { manual: false });
  assert.equal(result.items.length, 2);
  assert.match(result.items[0].text, /新蓝鲸/);
  assert.ok(result.items[1].freshness < 0.01);
  const history = await engine.search("one", "2020 蓝鲸计划", { manual: true });
  assert.ok(history.items.some((x) => x.text.includes("旧蓝鲸")));
  assert.equal((await memory.readSession("one")).length, 2);
  assert.equal((await engine.search("one", "你好")).items.length, 0);
});

test("archive, restore and pin change recall without modifying source episodes", async (t) => {
  const { engine, memory } = await fixture(t);
  await memory.appendEvent({
    session: "one",
    type: "message",
    role: "user",
    text: "生日是五月十二日",
  });
  const source = (await memory.readSession("one"))[0];
  await engine.change("one", source.id, "archive");
  assert.equal(
    (await engine.search("one", "生日", { manual: true })).items.length,
    0,
  );
  assert.ok(
    (await engine.inspect("one", "", true)).items.some(
      (x) => x.id === source.id,
    ),
  );
  assert.equal((await engine.inspect("one", "生日", false)).items.length, 0);
  const archivedMatches = (await engine.inspect("one", "生日", true)).items;
  assert.equal(archivedMatches.length, 1);
  assert.equal(archivedMatches[0].id, source.id);
  assert.equal(archivedMatches[0].status, "archived");
  await engine.change("one", source.id, "restore");
  await engine.change("one", source.id, "pin");
  const found = (await engine.search("one", "诞辰", { manual: true })).items;
  assert.equal(found.length, 1);
  assert.equal(found[0].pinned, true);
  assert.equal(found[0].freshness, 1);
  assert.deepEqual((await memory.readSession("one"))[0], source);
});

test("automatic recall obeys the enabled flag and token budget while manual lookup remains possible", async (t) => {
  const { engine } = await fixture(t);
  await engine.record("one", {
    kind: "episode",
    text: "项目密语是蓝鲸计划",
    source: "user",
  });
  const settings = (await engine.state("one")).settings;
  await engine.settings("one", { ...settings, enabled: false }, []);
  assert.equal((await engine.search("one", "蓝鲸计划")).items.length, 0);
  assert.equal(
    (await engine.search("one", "蓝鲸计划", { manual: true })).items.length,
    1,
  );
  await engine.settings("one", { ...settings, recall_tokens: 0 }, []);
  assert.equal((await engine.search("one", "蓝鲸计划")).items.length, 0);
});

test("plugin experiences are idempotent and preserve pending, failed and succeeded outcomes", async (t) => {
  const { engine } = await fixture(t);
  const disposers: (() => void)[] = [];
  const plugin = engine.plugin("qq", (fn) => disposers.push(fn));
  const pending = {
    event_id: "send-1",
    outcome: "pending",
    text: "问候消息已提交",
  };
  await plugin.recordExperience("one", pending);
  await plugin.recordExperience("one", pending);
  await plugin.recordExperience("one", {
    event_id: "send-1",
    outcome: "succeeded",
    text: "问候消息发送成功",
  });
  await plugin.recordExperience("one", {
    event_id: "send-2",
    outcome: "failed",
    text: "问候消息发送失败",
  });
  const records = (await engine.inspect("one")).items;
  assert.equal(records.length, 3);
  assert.deepEqual(
    new Set(records.map((x) => x.outcome)),
    new Set(["pending", "succeeded", "failed"]),
  );
  disposers.reverse().forEach((fn) => fn());
  await assert.rejects(plugin.recordExperience("one", pending), /停用/);
  assert.equal((await engine.inspect("one")).items.length, 3);
});

test("intent types only exist with the owning plugin and survive unload as inactive historical data", async (t) => {
  const { engine } = await fixture(t);
  await assert.rejects(
    engine.record("one", { kind: "intent", text: "主动问候" }),
    /未注册/,
  );
  const disposers: (() => void)[] = [];
  const plugin = engine.plugin("proactive", (fn) => disposers.push(fn));
  const registered = plugin.registerType("intent", 1);
  await plugin.saveExtension("one", {
    kind: registered.kind,
    key: "greeting",
    text: "主动问候蓝鲸朋友",
    data: { state: "planned", next: "qq" },
  });
  assert.equal(
    (await plugin.readExtension("one", registered.kind, "greeting")).data.state,
    "planned",
  );
  assert.equal(
    (await engine.search("one", "问候", { manual: true })).items.length,
    1,
  );
  const other = engine.plugin("bili", () => {});
  await assert.rejects(
    other.saveExtension("one", {
      kind: registered.kind,
      key: "greeting",
      text: "抢占",
    }),
    /不属于/,
  );
  disposers.reverse().forEach((fn) => fn());
  assert.equal(
    (await engine.search("one", "问候", { manual: true })).items.length,
    0,
  );
  assert.equal(
    (await engine.inspect("one")).items.length,
    1,
    "unload must not delete history",
  );
  const reloaded = engine.plugin("proactive", () => {});
  reloaded.registerType("intent", 1);
  assert.equal(
    (await reloaded.readExtension("one", registered.kind, "greeting")).data
      .state,
    "planned",
  );
});

test("cognition must reference real evidence and remains distinct from editable facts", async (t) => {
  const { engine, memory } = await fixture(t);
  await assert.rejects(
    engine.record("one", {
      kind: "cognition",
      text: "可能喜欢蓝色",
      evidence: ["missing"],
    }),
    /来源不存在/,
  );
  await memory.appendEvent({
    session: "one",
    type: "message",
    role: "user",
    text: "蓝色看着舒服",
  });
  const source = (await memory.readSession("one"))[0];
  await engine.record("one", {
    kind: "cognition",
    text: "可能偏好蓝色，尚未确认",
    evidence: [source.id],
    source: "core",
  });
  assert.equal((await engine.localFacts("one")).text, "");
  const cognition = (await engine.inspect("one")).items.find(
    (x) => x.kind === "cognition",
  );
  assert.deepEqual(cognition.evidence, [source.id]);
});

test("chat and memory usage remain separate and missing usage is explicitly unknown", async (t) => {
  const { engine, memory } = await fixture(t);
  await engine.usage("one", "chat", {
    prompt_tokens: 80,
    completion_tokens: 20,
  });
  await engine.usage("one", "chat", undefined);
  await engine.usage("one", "memory", {
    prompt_tokens: 30,
    completion_tokens: 10,
  });
  const reloaded = new MemoryEngine(memory);
  const { usage } = await reloaded.inspect("one");
  assert.deepEqual(usage.chat, {
    input_tokens: 80,
    output_tokens: 20,
    requests: 2,
    unknown_requests: 1,
  });
  assert.deepEqual(usage.memory, {
    input_tokens: 30,
    output_tokens: 10,
    requests: 1,
    unknown_requests: 0,
  });
});

test("daily consolidation reservations persist across restart, cannot overspend concurrently, and reset by UTC day", async (t) => {
  const { engine, memory } = await fixture(t);
  const original = (await engine.state("one")).settings;
  assert.equal(original.daily_memory_tokens, 20000);
  for (const daily_memory_tokens of [-1, 10000001, 1.5]) {
    await assert.rejects(
      engine.settings("one", { ...original, daily_memory_tokens }, []),
      /预算/,
    );
  }
  await engine.settings("one", { ...original, daily_memory_tokens: 100 }, []);
  assert.equal(await engine.reserveConsolidation("one", 70), true);
  const restarted = new MemoryEngine(memory);
  const results = await Promise.all([
    restarted.reserveConsolidation("one", 30),
    restarted.reserveConsolidation("one", 30),
  ]);
  // Either concurrent caller may reserve first; exactly one must succeed.
  assert.deepEqual([...results].sort(), [false, true]);
  assert.equal(await restarted.reserveConsolidation("one", 1), false);
  const current = await restarted.state("one");
  assert.equal(current.daily.reserved, 100);
  assert.equal(current.daily.day, new Date().toISOString().slice(0, 10));
  // Simulate persisted data from a previous UTC day without waiting for midnight.
  current.daily.day = "2000-01-01";
  await writeFile(
    join(memory.root, "sessions", "one", "knowledge", "state.json"),
    JSON.stringify(current),
  );
  assert.equal(await restarted.reserveConsolidation("one", 100), true);
  assert.equal((await restarted.state("one")).daily.reserved, 100);
  assert.equal(
    (await restarted.state("one")).daily.day,
    new Date().toISOString().slice(0, 10),
  );
});

test("invalid consolidation reservation amounts cannot lower or corrupt the budget ledger", async (t) => {
  const { engine } = await fixture(t);
  await engine.reserveConsolidation("one", 100);
  for (const amount of [-1, NaN, Infinity, 1.5]) {
    await assert.rejects(engine.reserveConsolidation("one", amount));
  }
  assert.equal((await engine.state("one")).daily.reserved, 100);
});
