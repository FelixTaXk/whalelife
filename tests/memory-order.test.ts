import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-memory-order-");
  const memory = new Memory(join(root, "memory"), { info() {}, warn() {}, error() {} } as any);
  t.after(async () => { await memory.queue; });
  await memory.init();
  return { memory, engine: new MemoryEngine(memory) };
}

test("default memory list sorts all sources by recorded time before the 100-item limit", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  const { memory, engine } = await fixture(t);
  for (let i = 0; i < 110; i++) await memory.appendEvent({
    session: "one", id: `chat_${i}`, type: "message", role: i % 2 ? "assistant" : "user",
    text: `旧聊天${i}`, ts: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
  });
  const episode = await engine.experience("one", "probe", { event_id: "decision", outcome: "succeeded",
    text: "新插件判断", occurred_at: "2010-01-01T00:00:00Z" });
  t.mock.timers.tick(1000);
  const shared = await engine.experience("two", "other", { event_id: "shared", outcome: "succeeded", text: "共享经历" });
  const space = await engine.createSpace("测试共享");
  for (const id of ["one", "two"]) await engine.settings(id, (await engine.state(id)).settings, [space.id]);
  await engine.change("two", shared.id, "share", space.id);
  const original = await memory.readSession("one"), result = (await engine.inspect("one")).items;
  assert.equal(result.length, 100);
  assert.deepEqual(result.slice(0, 3).map(x => x.id), [shared.id, episode.id, "chat_109"]);
  assert.equal(result[0].shared_space, "测试共享");
  assert.equal(result.at(-1)?.id, "chat_12");
  assert.deepEqual(await memory.readSession("one"), original);
});

test("equal or unavailable timestamps have a deterministic order, and invalid times sort last", async t => {
  const { memory, engine } = await fixture(t);
  for (const [id, ts] of [["b", "2020-01-01T08:00:00+08:00"], ["a", "2020-01-01T00:00:00Z"],
    ["z", undefined], ["c", "not-a-date"], ["d", "2026-02-30T00:00:00Z"], ["new", "2021-01-01T00:00:00Z"]])
    await memory.appendEvent({ session: "one", id, type: "message", role: "user", text: String(id), ts });
  const expected = ["new", "a", "b", "c", "d", "z"];
  assert.deepEqual((await engine.inspect("one")).items.map(x => x.id), expected);
  assert.deepEqual((await engine.inspect("one")).items.map(x => x.id), expected);
});

test("keyword search still ranks relevant older memories instead of forcing timestamp order", async t => {
  const { memory, engine } = await fixture(t);
  await memory.appendEvent({ session: "one", id: "relevant", type: "message", role: "user", text: "海盐冰淇淋", ts: "2020-01-01T00:00:00Z" });
  await engine.experience("one", "probe", { event_id: "new", outcome: "succeeded", text: "阅读完成" });
  assert.equal((await engine.inspect("one", "海盐冰淇淋")).items[0].id, "relevant");
});
