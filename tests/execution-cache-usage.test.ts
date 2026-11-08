/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionArchive, diagnosticSnapshot } from "../core/execution-archive.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

test("diagnostics retain numeric cache usage without accepting credentials disguised as token counts", () => {
  const snapshot = diagnosticSnapshot({ usage: { prompt_tokens: 100, completion_tokens: 4,
    prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20,
    prompt_tokens_details: { cached_tokens: 80, audio_tokens: 0, api_key: "synthetic-secret", text: "private note" },
    completion_tokens_details: { reasoning_tokens: 0, accepted_prediction_tokens: 1 },
  }, access_token: "synthetic-secret", token: "synthetic-secret" });
  assert.equal(snapshot.usage.prompt_cache_hit_tokens, 80);
  assert.equal(snapshot.usage.prompt_cache_miss_tokens, 20);
  assert.equal(snapshot.usage.prompt_tokens_details.cached_tokens, 80);
  assert.equal(snapshot.usage.prompt_tokens_details.audio_tokens, 0);
  assert.equal(snapshot.usage.completion_tokens_details.reasoning_tokens, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-secret|private note/);
  for (const invalid of ["synthetic-secret", -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, { secret: "nested" }, [123]]) {
    const value = diagnosticSnapshot({ prompt_tokens: invalid, prompt_cache_hit_tokens: invalid,
      prompt_tokens_details: { cached_tokens: invalid } });
    assert.equal(value.prompt_tokens, "[已隐藏]");
    assert.equal(value.prompt_cache_hit_tokens, "[已隐藏]");
    assert.equal(value.prompt_tokens_details.cached_tokens, "[已隐藏]");
  }
});

test("execution archive persists and reads supplier cache counts while keeping secrets hidden", async () => {
  const root = await temporaryDirectory("whale-execution-cache-");
  const archive = new ExecutionArchive(root, { secrets: ["synthetic-secret"], warn() {} } as any);
  const run = await archive.start("synthetic", { kind: "chat" });
  assert.ok(run);
  await run.write("model_result", { usage: { prompt_tokens: 100, completion_tokens: 2,
    prompt_cache_hit_tokens: 96, prompt_cache_miss_tokens: 4,
    prompt_tokens_details: { cached_tokens: 96, access_token: "synthetic-secret" } } });
  await run.end("completed");
  const page = await archive.inspect("synthetic", { execution_id: run.id });
  assert.ok("entries" in page);
  const result = page.entries.find((entry: any) => entry.kind === "model_result");
  assert.deepEqual([result.data.usage.prompt_tokens, result.data.usage.prompt_cache_hit_tokens,
    result.data.usage.prompt_cache_miss_tokens, result.data.usage.prompt_tokens_details.cached_tokens], [100, 96, 4, 96]);
  assert.doesNotMatch(JSON.stringify(page), /synthetic-secret/);
});
