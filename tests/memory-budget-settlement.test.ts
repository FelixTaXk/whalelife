/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryEngine, validateMemoryState } from "../core/memory-engine.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext, budget = 20000) {
  const root = await temporaryDirectory("whale-memory-budget-");
  const memory = new Memory(join(root, "memory"), { info() {}, warn() {}, error() {} } as any);
  t.after(async () => { await memory.queue; });
  await memory.init();
  const engine = new MemoryEngine(memory);
  await engine.settings("one", { ...(await engine.state("one")).settings, daily_memory_tokens: budget }, []);
  const reserved = async () => (await engine.state("one")).daily.reserved;
  return { memory, engine, reserved };
}

test("a request holds its full estimate until settlement and then charges measured input plus output once", async t => {
  const f = await fixture(t);
  const ticket = await f.engine.reserveMemoryRequest("one", 5000);
  assert.ok(ticket);
  assert.equal(await f.reserved(), 5000);
  await f.engine.settleMemoryRequest("one", ticket, { prompt_tokens: 250, completion_tokens: 120 });
  assert.equal(await f.reserved(), 370);
  await f.engine.settleMemoryRequest("one", ticket, { prompt_tokens: 1, completion_tokens: 1 });
  await f.engine.settleMemoryRequest("one", ticket, undefined, { notSent: true });
  assert.equal(await f.reserved(), 370, "duplicate completion cannot refund a second time");
  assert.equal((await f.engine.state("one")).usage.memory.requests, 0, "usage reporting remains an independent ledger");
});

test("concurrent reservations enforce the limit and settlements refund only their own reservation", async t => {
  const f = await fixture(t, 900);
  const tickets = await Promise.all([400, 400, 400].map(tokens => f.engine.reserveMemoryRequest("one", tokens)));
  const accepted = tickets.filter(x => x !== null);
  assert.equal(accepted.length, 2); assert.equal(await f.reserved(), 800);
  await Promise.all([
    f.engine.settleMemoryRequest("one", accepted[0], { prompt_tokens: 100, completion_tokens: 20 }),
    f.engine.settleMemoryRequest("one", accepted[0], { prompt_tokens: 100, completion_tokens: 20 }),
    f.engine.settleMemoryRequest("one", accepted[1], { prompt_tokens: 150, completion_tokens: 30 }),
  ]);
  assert.equal(await f.reserved(), 300);
  assert.ok(await f.engine.reserveMemoryRequest("one", 600), "unused estimates become available to later work");
  assert.equal(await f.engine.reserveMemoryRequest("one", 1), null);
});

test("failed or malformed usage conservatively retains the full reservation", async t => {
  const f = await fixture(t);
  const variants = [undefined, {}, { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: "1", completion_tokens: 2 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 2 }];
  for (const usage of variants) {
    const ticket = await f.engine.reserveMemoryRequest("one", 100);
    assert.ok(ticket);
    await f.engine.settleMemoryRequest("one", ticket, usage);
  }
  assert.equal(await f.reserved(), variants.length * 100);
});

test("cancellation before sending releases the reservation and a zero limit still blocks new requests", async t => {
  const f = await fixture(t, 500), controller = new AbortController();
  const original = f.engine.reserveConsolidation.bind(f.engine);
  f.engine.reserveConsolidation = async (id, tokens, capture) => {
    const ok = await original(id, tokens, capture);
    controller.abort();
    return ok;
  };
  const ticket = await f.engine.reserveMemoryRequest("one", 500);
  assert.ok(ticket); assert.equal(controller.signal.aborted, true);
  assert.equal(await f.reserved(), 500);
  await f.engine.settleMemoryRequest("one", ticket, undefined, { notSent: true });
  assert.equal(await f.reserved(), 0);
  await f.engine.settings("one", { ...(await f.engine.state("one")).settings, daily_memory_tokens: 0 }, []);
  assert.equal(await f.engine.reserveMemoryRequest("one", 1), null);
});

test("actual usage above the estimate is charged and prevents further reservations", async t => {
  const f = await fixture(t, 500);
  const ticket = await f.engine.reserveMemoryRequest("one", 400);
  assert.ok(ticket);
  await f.engine.settleMemoryRequest("one", ticket, { prompt_tokens: 500, completion_tokens: 100 });
  assert.equal(await f.reserved(), 600);
  assert.equal(await f.engine.reserveMemoryRequest("one", 1), null);
});

test("a previous UTC day's late settlement cannot alter the next day's reservations", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-08T23:59:59Z") });
  const f = await fixture(t);
  const old = await f.engine.reserveMemoryRequest("one", 5000);
  assert.ok(old); assert.equal(old.day, "2026-11-08");
  t.mock.timers.setTime(new Date("2026-11-09T00:00:01Z").getTime());
  const next = await f.engine.reserveMemoryRequest("one", 2000);
  assert.ok(next); assert.equal(next.day, "2026-11-09");
  await f.engine.settleMemoryRequest("one", old, { prompt_tokens: 10, completion_tokens: 10 });
  assert.equal(await f.reserved(), 2000);
  await f.engine.settleMemoryRequest("one", next, { prompt_tokens: 70, completion_tokens: 10 });
  assert.equal(await f.reserved(), 80);
});

test("foreign session, altered and previous-process tickets cannot refund another request", async t => {
  const f = await fixture(t);
  const ticket = await f.engine.reserveMemoryRequest("one", 500);
  assert.ok(ticket);
  await assert.rejects(f.engine.settleMemoryRequest("other", ticket, undefined, { notSent: true }), /不匹配/);
  await assert.rejects(f.engine.settleMemoryRequest("one", { ...ticket, reserved: 1000 }, undefined, { notSent: true }), /不匹配/);
  const restarted = new MemoryEngine(f.memory);
  await restarted.settleMemoryRequest("one", ticket, undefined, { notSent: true });
  assert.equal(await f.reserved(), 500, "a crash keeps its conservative durable charge");
  await f.engine.settleMemoryRequest("one", ticket, { prompt_tokens: 10, completion_tokens: 10 });
  assert.equal(await f.reserved(), 20);
});

test("legacy reservation stays estimate based and invalid token counts cannot charge the ledger", async t => {
  const f = await fixture(t, 1000);
  assert.equal(await f.engine.reserveConsolidation("one", 900), true);
  assert.equal(await f.engine.reserveConsolidation("one", 101), false);
  assert.equal(await f.reserved(), 900);
  for (const tokens of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(f.engine.reserveMemoryRequest("one", tokens), /非负整数/);
  assert.equal(await f.reserved(), 900);
});

test("summary maintenance metadata validates at the shared storage and restore boundary while old states remain valid", async t => {
  const f = await fixture(t), original = await f.engine.state("one");
  original.summaries.p_legacy = { covered: 0, text: "保留旧概览" };
  assert.doesNotThrow(() => validateMemoryState(original));
  const valid = { covered: 0, mode: "long", text: "有效概览", attempt_sequence: 2, failure_count: 1,
    last_attempt_at: Date.now(), retry_start_id: "first", last_error: "摘要字段缺失", updated_at: new Date().toISOString() };
  original.summaries.p_current = valid;
  assert.doesNotThrow(() => validateMemoryState(original));
  for (const patch of [
    { attempt_sequence: -1 }, { attempt_sequence: Number.MAX_SAFE_INTEGER + 1 }, { failure_count: 1.5 },
    { last_attempt_at: "now" }, { retry_start_id: 12 }, { last_error: "" }, { last_error: " " },
    { last_error: "🐋".repeat(201) }, { updated_at: 10 }, { updated_at: "not-a-date" },
  ]) {
    const corrupted = structuredClone(original);
    corrupted.summaries.p_current = { ...valid, ...patch };
    assert.throws(() => validateMemoryState(corrupted), /摘要游标损坏/);
  }
});
