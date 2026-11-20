/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureCacheCostBaseline, readCacheAdvice } from "../core/cache-advice.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const now = Date.parse("2026-11-10T12:00:00.000Z");
const minute = 60_000, day = 24 * 60 * minute;
const ctx = { provider: "saved-provider", model: "same-model", model_id: "saved-chat" };
const target = (archiveRoot: string) => ({ archiveRoot, providerId: ctx.provider, modelId: ctx.model_id,
  model: ctx.model, uniqueModel: true, configMtimeMs: now - 2 * day, now });
const usage = (input: number, hit: number) => ({ prompt_tokens: input, prompt_tokens_details: { cached_tokens: hit } });
type Row = { kind: string; data: any };
type Options = { session?: string; kind?: string; context?: Record<string, unknown>; later?: Row[]; before?: Row[] };
async function run(root: string, at: number, initialUsage: unknown, opts: Options = {}) {
  const ts = new Date(at).toISOString();
  const group = join(root, opts.session ?? "private-session");
  await mkdir(group, { recursive: true });
  const name = ts.replace(/\D/g, "") + "_" + randomUUID().replaceAll("-", "") + ".jsonl";
  const rows: Row[] = [
    { kind: "start", data: { kind: opts.kind ?? "conversation", trigger: "private conversation text" } },
    { kind: "context", data: opts.context ?? ctx },
    { kind: "model_start", data: { round: 1 } },
    ...(opts.before ?? []),
    { kind: "model_result", data: { round: 1, usage: initialUsage } },
    ...(opts.later ?? []),
    { kind: "finish", data: { status: "completed" } },
  ];
  const file = join(group, name);
  await writeFile(file, rows.map((row, seq) => JSON.stringify({ seq, ts, ...row })).join("\n") + "\n");
  return file;
}
const fixture = () => temporaryDirectory("whale-cache-advice-");

test("old records require a unique complete provider/model match after the real config save", async () => {
  const root = await fixture(), key = target(root);
  const old = { provider: ctx.provider, model: ctx.model };
  await run(root, now - minute, usage(8192, 8000), { context: old });
  await run(root, now - 2 * minute, usage(8192, 0), { context: { ...ctx, provider: "other-provider" } });
  await run(root, now - 3 * minute, usage(8192, 0), { context: { ...ctx, model_id: "other-chat" } });
  await run(root, now - 4 * minute, usage(8192, 0), { context: { ...ctx, model: "another-model" } });
  await run(root, now - 5 * minute, usage(8192, 0), { kind: "technical_task" });
  await run(root, now - 6 * minute, usage(8192, 0), { kind: "direct_tool" });
  await run(root, now - 8 * minute, usage(8192, 0), { context: { ...ctx, cache_layout_eligible: false } });
  await run(root, key.configMtimeMs, usage(8192, 0));
  await run(root, key.configMtimeMs - 1, usage(8192, 0));
  await run(root, now + minute, usage(8192, 0));
  const identified = await readCacheAdvice(key);
  assert.equal(identified.observed.turns, 1);
  assert.equal(identified.advice.code, "healthy");
  assert.doesNotMatch(JSON.stringify(identified), /private conversation|private-session|saved-provider|same-model|saved-chat/);
  const ambiguous = await readCacheAdvice({ ...key, uniqueModel: false });
  assert.equal(ambiguous.observed.turns, 0);
  assert.equal(ambiguous.observed.limited, true);
  await run(root, now - 7 * minute, usage(8192, 8192), { context: { ...ctx, cache_layout_eligible: true } });
  assert.equal((await readCacheAdvice({ ...key, uniqueModel: false })).observed.turns, 1);
  assert.equal((await readCacheAdvice({ ...key, configMtimeMs: NaN })).observed.turns, 0);
});

test("only the first result per ordinary conversation counts, including missing and conflicting fields", async () => {
  const root = await fixture();
  const later = Array.from({ length: 15 }, (_, i) => ({
    kind: "model_result", data: { round: i + 2, usage: usage(10000, 0) },
  }));
  await run(root, now - minute, usage(8192, 6144), { later });
  await run(root, now - 2 * minute, usage(4096, 0));
  await run(root, now - 3 * minute, { prompt_tokens: 9000 });
  await run(root, now - 4 * minute, { prompt_tokens: 7000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 3 });
  await run(root, now - 5 * minute, null);
  await run(root, now - 6 * minute, { prompt_tokens: 0, prompt_cache_hit_tokens: 0 });
  const report = await readCacheAdvice(target(root));
  assert.deepEqual(report.observed, { window_days: 7, max_turns: 12, long_input_tokens: 4096,
    turns: 6, measured_turns: 2, long_turns: 4, measured_long_turns: 2, cached_input_percent: 50, limited: false });
});

test("missing cache counters stay unknown while an explicit zero is an observation", async () => {
  const root = await fixture(), key = target(root);
  const empty = await readCacheAdvice(key);
  assert.equal(empty.advice.code, "insufficient");
  assert.equal(empty.observed.cached_input_percent, null);
  await run(root, now - 3 * minute, { prompt_tokens: 8000 });
  await run(root, now - 2 * minute, { ...usage(8000, 8), prompt_cache_hit_tokens: 0 });
  const unknown = await readCacheAdvice(key);
  assert.equal(unknown.advice.code, "unknown");
  assert.equal(unknown.observed.cached_input_percent, null);
  await run(root, now - minute, usage(8192, 0));
  const zero = await readCacheAdvice(key);
  assert.equal(zero.observed.cached_input_percent, 0);
  assert.equal(zero.advice.code, "insufficient");
});

test("only repeated, recent low hits in long inputs from one conversation suggest an optional paid test", async () => {
  const root = await fixture(), key = target(root);
  for (let i = 1; i <= 3; i++) await run(root, now - i * minute, usage(8192, 128));
  const report = await readCacheAdvice(key);
  assert.equal(report.advice.code, "test");
  assert.match(report.advice.message, /如果实际输入费用/);
  await run(root, now - 1, { prompt_tokens: 16384 });
  assert.equal((await readCacheAdvice(key)).advice.code, "insufficient");

  for (const variation of ["short", "scattered", "separate sessions", "only two", "mixed"]) {
    const other = await fixture();
    for (let i = 1; i <= (variation === "only two" ? 2 : 3); i++) {
      const at = now - i * (variation === "scattered" ? 65 * minute : minute);
      await run(other, at, usage(variation === "short" ? 2048 : 8192, variation === "mixed" && i === 2 ? 4096 : 0),
        { session: variation === "separate sessions" ? "session-" + i : "one-session" });
    }
    const report = await readCacheAdvice(target(other));
    assert.equal(report.advice.code, "insufficient", variation);
    if (variation === "separate sessions") assert.equal(report.observed.turns, 3);
  }
});

test("the sample covers seven days and at most the twelve latest matching turns across sessions", async () => {
  const root = await fixture(), key = { ...target(root), configMtimeMs: now - 10 * day };
  await run(root, now - 8 * day, usage(6000, 0));
  await run(root, now - 6 * day, usage(6000, 6000));
  assert.equal((await readCacheAdvice(key)).observed.turns, 1);
  for (let i = 1; i <= 14; i++)
    await run(root, now - i * minute, usage(6000, i <= 12 ? 6000 : 0), { session: "session-" + i % 2 });
  const report = await readCacheAdvice(key);
  assert.equal(report.observed.turns, 12);
  assert.equal(report.observed.cached_input_percent, 100);
});

test("partial rows, oversized preambles and linked archive files cannot supply paid advice", async () => {
  const root = await fixture(), key = target(root);
  await run(root, now - 4 * minute, usage(8192, 0));
  await run(root, now - 3 * minute, usage(8192, 0));
  await run(root, now - 2 * minute, usage(8192, 0));
  const huge = await run(root, now - minute, usage(8192, 0), {
    before: [{ kind: "context_detail", data: { text: "x".repeat(70 * 1024) } }],
  });
  const limited = await readCacheAdvice(key);
  assert.equal(limited.observed.turns, 4);
  assert.equal(limited.observed.measured_turns, 3);
  assert.equal(limited.observed.limited, true);
  assert.equal(limited.advice.code, "insufficient");
  await writeFile(huge, '{"kind":"start","data":{"kind":"conversation"}');
  const incomplete = await readCacheAdvice(key);
  assert.equal(incomplete.observed.turns, 3);
  assert.equal(incomplete.observed.limited, true);
  const linked = await run(root, now - 1, usage(65536, 65536));
  await link(linked, join(root, "private-other.jsonl"));
  const result = await readCacheAdvice(key);
  assert.equal(result.observed.measured_turns, 3);
  assert.equal(result.advice.code, "insufficient");
});

const billed = (cost: number, input = 8000, output = 100, currency = "USD") =>
  ({ ...usage(input, input), completion_tokens: output, cost, currency });

test("manual optimization compares the latest three same-session first requests with a real pre-enable baseline", async () => {
  const root = await fixture(), key = target(root);
  for (let i = 4; i <= 6; i++) await run(root, now - i * minute, billed(i === 6 ? 0.02 : 0.01));
  const baseline = await captureCacheCostBaseline(key);
  assert.ok(baseline);
  assert.doesNotMatch(JSON.stringify(baseline), /private-session|saved-chat|saved-provider/);
  for (let i = 1; i <= 3; i++) await run(root, now - i * minute, billed(0.03, 7900, 99));
  await run(root, now - 1.5 * minute, billed(9, 1, 1), { session: "another-session" });
  const active = { ...key, optimized: true, costBaseline: baseline, configMtimeMs: now - 3.5 * minute };
  const result = await readCacheAdvice(active);
  assert.equal(result.advice.code, "review_cost");
  assert.match(result.advice.message, /开启前.*0\.02 USD.*连续三轮.*0\.03.*手动关闭/);
  assert.equal(result.observed.cached_input_percent, 100);
  assert.doesNotMatch(JSON.stringify(result), /private-session|session_hash|saved-chat/);
  assert.equal((await readCacheAdvice({ ...active, optimized: false })).advice.code, "healthy");
  assert.equal((await readCacheAdvice({ ...active, costBaseline: undefined })).advice.code, "healthy");
  assert.equal((await readCacheAdvice({ ...active, costBaseline: { ...baseline, oldest_at: now - 8 * day } })).advice.code, "healthy");
  assert.equal((await readCacheAdvice({ ...active, costBaseline: { ...baseline, session_hash: "another-session" } })).advice.code, "healthy");
});

test("already optimized configurations use the preceding three real turns and do not require cache counters", async () => {
  const root = await fixture(), key = { ...target(root), optimized: true };
  for (let i = 1; i <= 6; i++) {
    const { prompt_tokens_details, ...usage } = billed(i <= 3 ? 0.02 : 0, 8000, 0);
    await run(root, now - i * minute, usage);
  }
  const report = await readCacheAdvice(key);
  assert.equal(report.advice.code, "review_cost");
  assert.match(report.advice.message, /当前配置下.*前三轮.*0 USD/);
  assert.equal(report.observed.cached_input_percent, null);
  assert.equal((await readCacheAdvice({ ...key, configMtimeMs: now - 5 * minute })).advice.code, "unknown");
});

test("each of three higher bills needs the same currency and no extra input or output", async () => {
  const invalid = [billed(0.03, 8001), billed(0.03, 8000, 101), billed(0.02),
    billed(0.03, 8000, 100, "CNY"), { ...billed(0.03), currency: undefined },
    { ...billed(0.03), cost: undefined, cost_details: { upstream_inference_cost: 0.03 } },
    { ...billed(0.03), cost: undefined, reference_cost: { amount: 0.03, currency: "USD" } },
    { ...billed(0.03), completion_tokens: undefined }, { ...billed(0.03), prompt_tokens: undefined }];
  for (const sample of invalid) {
    const root = await fixture(), key = { ...target(root), optimized: true };
    for (let i = 1; i <= 6; i++)
      await run(root, now - i * minute, i === 2 ? sample : billed(i <= 3 ? 0.03 : 0.02),
        { later: [{ kind: "model_result", data: { round: 2, usage: billed(3) } }] });
    assert.notEqual((await readCacheAdvice(key)).advice.code, "review_cost", JSON.stringify(sample));
  }
});

test("cost comparisons never take a baseline from a different session, provider, model or prior configuration", async () => {
  for (const other of [{ session: "other" }, { context: { ...ctx, model_id: "other" } },
      { context: { ...ctx, provider: "other" } }, { kind: "technical_task" }]) {
    const root = await fixture(), key = { ...target(root), optimized: true };
    for (let i = 1; i <= 6; i++)
      await run(root, now - i * minute, billed(i <= 3 ? 0.05 : 0.01), i <= 3 ? {} : other);
    assert.notEqual((await readCacheAdvice(key)).advice.code, "review_cost");
  }
});

test("a busy archive bounds file reads and discloses that the sample is incomplete", async () => {
  const root = await fixture(), key = target(root);
  await run(root, now - 70 * minute, usage(8192, 8192));
  for (let i = 1; i <= 64; i++)
    await run(root, now - i * minute, usage(8192, 0), { kind: "technical_task" });
  const result = await readCacheAdvice(key);
  assert.equal(result.observed.turns, 0);
  assert.equal(result.observed.limited, true);
  assert.equal(result.advice.code, "insufficient");
});
