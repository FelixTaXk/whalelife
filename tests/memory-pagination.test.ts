/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-memory-pagination-");
  const memory = new Memory(join(root, "memory"), { info() {}, warn() {}, error() {} } as any);
  t.after(async () => { await memory.queue; });
  await memory.init();
  const engine = new MemoryEngine(memory);
  await engine.settings("one", (await engine.state("one")).settings, []);
  const seed = async (session: string, count: number, text = "蓝鲸计划的交付记录") => {
    for (let index = 0; index < count; index++) await memory.appendEvent({ session,
      id: "row-" + String(index).padStart(3, "0"), type: "message", role: "user", text,
      ts: new Date(Date.parse("2026-01-01T00:00:00Z") + Math.floor(index / 3) * 1000).toISOString() });
    return memory.readSession(session);
  };
  const stateBytes = () => readFile(join(memory.root, "sessions", "one", "knowledge", "state.json"), "utf8");
  return { memory, engine, seed, stateBytes };
}
const identity = (item: any) => item.session + ":" + item.id;
const expectedOrder = (a: any, b: any) => Date.parse(b.ts) - Date.parse(a.ts) ||
  a.session.localeCompare(b.session) || a.id.localeCompare(b.id);

test("all 137 visible records are reachable across stable server pages while legacy inspect stays capped", async t => {
  const f = await fixture(t), rows = await f.seed("one", 137), before = await f.stateBytes();
  const expected = [...rows].sort(expectedOrder).map(identity), collected: string[] = [];
  const first = await f.engine.inspect("one", "", false, {});
  assert.equal(first.total, 137); assert.equal(first.offset, 0); assert.equal(first.limit, 25);
  for (let offset = 0; offset < first.total!; offset += 25) {
    const page = await f.engine.inspect("one", "", false, { offset });
    assert.equal(page.total, 137); assert.equal(page.offset, offset); assert.equal(page.limit, 25);
    assert.deepEqual(page.items.map(identity), expected.slice(offset, offset + 25));
    collected.push(...page.items.map(identity));
  }
  assert.deepEqual(collected, expected); assert.equal(new Set(collected).size, 137);
  const custom = await f.engine.inspect("one", "", false, { offset: 7, limit: 100 });
  assert.deepEqual(custom.items.map(identity), expected.slice(7, 107));
  const legacy = await f.engine.inspect("one");
  assert.equal(legacy.items.length, 100); assert.equal(legacy.total, undefined);
  assert.equal(legacy.offset, undefined); assert.equal(legacy.limit, undefined);
  assert.equal(await f.stateBytes(), before, "page reads must not persist traces, cursor or other state");
  assert.deepEqual(await f.memory.readSession("one"), rows);
});

test("query pages rank all matching records before slicing and ignore recall's six-item and token caps", async t => {
  const f = await fixture(t), text = "蓝鲸计划：" + "完整资料。".repeat(400);
  const matches = await f.seed("one", 33, text);
  for (let index = 0; index < 8; index++) await f.memory.appendEvent({ session: "one", id: "unrelated-" + index,
    type: "message", role: "assistant", text: "完全无关的旅行记录" });
  const before = await f.stateBytes(), expected = [...matches].sort(expectedOrder).map(identity);
  const first = await f.engine.inspect("one", "蓝鲸计划", false, {});
  const second = await f.engine.inspect("one", "蓝鲸计划", false, { offset: 25 });
  assert.equal(first.total, 33); assert.equal(first.items.length, 25); assert.equal(second.items.length, 8);
  assert.deepEqual([...first.items, ...second.items].map(identity), expected);
  assert.ok(first.items.every(item => item.score > 0 && item.reason.includes("命中")));
  assert.equal(Array.from(first.items[0].text).length, 1500, "only returned page previews receive the inspection text cap");
  assert.equal((await f.engine.inspect("one", "没有这个关键字", false, { offset: 999 })).total, 0);
  assert.equal(await f.stateBytes(), before);
  const legacy = await f.engine.inspect("one", "蓝鲸计划");
  assert.ok(legacy.items.length <= 6); assert.equal(legacy.total, undefined);
});

test("query score takes precedence over timestamp and same-score ordering remains deterministic", async t => {
  const f = await fixture(t);
  await f.memory.appendEvent({ session: "one", id: "older-better", type: "message", role: "user",
    text: "蓝鲸 交付", ts: "2020-01-01T00:00:00Z" });
  await f.memory.appendEvent({ session: "one", id: "newer-weaker", type: "message", role: "user",
    text: "蓝鲸", ts: "2026-01-01T00:00:00Z" });
  const page = await f.engine.inspect("one", "蓝鲸 交付", false, {});
  assert.equal(page.items[0].id, "older-better"); assert.ok(page.items[0].score > page.items[1].score);
  assert.equal((await f.engine.inspect("one", "", false, {})).items[0].id, "newer-weaker");
});

test("archive filters and explicitly shared visibility apply before totals and paging", async t => {
  const f = await fixture(t);
  await f.seed("one", 3); await f.seed("other", 4);
  await f.engine.change("one", "row-002", "archive");
  await f.engine.change("other", "row-001", "archive");
  const space = await f.engine.createSpace("公开给小组的经历");
  const settings = (await f.engine.state("one")).settings;
  await f.engine.settings("one", settings, [space.id]);
  await f.engine.settings("other", settings, [space.id]);
  await f.engine.change("other", "row-000", "share", space.id);
  await f.engine.change("other", "row-001", "share", space.id);
  const active = await f.engine.inspect("one", "蓝鲸计划", false, { limit: 2 });
  assert.equal(active.total, 3);
  const all = await f.engine.inspect("one", "蓝鲸计划", true, { limit: 100 });
  assert.equal(all.total, 5); assert.equal(new Set(all.items.map(identity)).size, 5);
  assert.ok(all.items.some(item => item.session === "other" && item.status === "archived"));
  assert.ok(!all.items.some(item => item.session === "other" && ["row-002", "row-003"].includes(item.id)));
  const tied = all.items.filter(item => item.id === "row-000");
  assert.deepEqual(tied.map(item => item.session), ["one", "other"]);
  assert.equal((await f.engine.inspect("outsider", "蓝鲸计划", true, {})).total, 0);
  await f.engine.settings("one", settings, []);
  assert.equal((await f.engine.inspect("one", "蓝鲸计划", true, {})).total, 3);
});

test("every visible extension remains queryable in inspection while disabled-plugin automatic recall stays unchanged", async t => {
  const f = await fixture(t), plugin = f.engine.plugin("pagination-fixture", () => {});
  const type = plugin.registerType("note");
  await plugin.saveExtension("one", { kind: type.kind, key: "visible-note", text: "蓝鲸计划扩展资料", data: {} });
  type.dispose();
  assert.equal((await f.engine.inspect("one", "", false, {})).total, 1);
  assert.equal((await f.engine.inspect("one", "蓝鲸计划", false, {})).total, 1);
  assert.equal((await f.engine.search("one", "蓝鲸计划", { persistTrace: false })).items.length, 0);
});

test("out-of-range offsets use the last populated page and invalid paging values are rejected", async t => {
  const f = await fixture(t);
  await f.seed("one", 31);
  for (const offset of [31, 1000, Number.MAX_SAFE_INTEGER]) {
    const page = await f.engine.inspect("one", "", false, { offset, limit: 10 });
    assert.equal(page.offset, 30); assert.equal(page.limit, 10); assert.equal(page.items.length, 1); assert.equal(page.total, 31);
  }
  const empty = await f.engine.inspect("one", "未命中", false, { offset: 1000, limit: 10 });
  assert.equal(empty.offset, 0); assert.equal(empty.total, 0); assert.deepEqual(empty.items, []);
  for (const page of [null, [], "page", 5, { offset: -1 }, { offset: 0.5 }, { offset: Infinity },
    { offset: NaN }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: "0" }, { offset: null },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: Infinity }, { limit: "25" }, { limit: null }])
    await assert.rejects(f.engine.inspect("one", "", false, page as any), /分页/);
  await assert.rejects(f.engine.inspect("one", "字".repeat(16001), false, {}), /检索文字/);
  await assert.rejects(f.engine.inspect("one", 5 as any, false, {}), /检索文字/);
});

test("automatic recall still uses six results, configured token budget and its own trace lifecycle", async t => {
  const f = await fixture(t);
  await f.seed("one", 20);
  const all = await f.engine.search("one", "蓝鲸计划", { budget: 4000 });
  assert.equal(all.items.length, 6); assert.equal(all.trace.omitted, 14);
  const saved = await f.stateBytes();
  const page = await f.engine.inspect("one", "蓝鲸计划", false, { limit: 15 });
  assert.equal(page.items.length, 15); assert.equal(page.total, 20); assert.deepEqual(page.trace, all.trace);
  assert.equal(await f.stateBytes(), saved);
  const disabledBudget = await f.engine.search("one", "蓝鲸计划", { budget: 0, persistTrace: false });
  assert.equal(disabledBudget.items.length, 0); assert.equal(disabledBudget.trace.estimated_tokens, 0);
  assert.equal(await f.stateBytes(), saved);
  const settings = (await f.engine.state("one")).settings;
  await f.engine.settings("one", { ...settings, enabled: false }, []);
  assert.equal((await f.engine.search("one", "蓝鲸计划")).items.length, 0);
  assert.equal((await f.engine.inspect("one", "蓝鲸计划", false, {})).total, 20);
});
