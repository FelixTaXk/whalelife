/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelConfig, resolveModel, validateModelParameters } from "../core/model-config.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const mapping = { response_field: "metadata.thought", request_field: "reasoning_content", fill_missing: true };
async function fixture() {
  const root = await temporaryDirectory("whale-compatibility-config-");
  await mkdir(join(root, "config"));
  const config: any = {
    providers: [{ id: "p", name: "synthetic", protocol: "openai-compatible", base_url: "https://unused.invalid/v1",
      api_key: "SYNTHETIC_SECRET", enabled: true, timeout_seconds: 15, proxy_url: "" }],
    models: ["a", "b"].map(id => ({ id, name: id, provider: "p", model: id, type: "chat", enabled: true,
      parameters: {}, dimensions: null, context_window: null })),
    model_bindings: { chat: "a" }, personas: {}, channels: { web: {} }, custom: { keep: true },
  };
  const file = join(root, "config/config.json");
  await writeFile(file, JSON.stringify(config));
  const manager = new ModelConfig(root, config, { secrets: [], info() {}, warn() {}, error() {} } as any);
  const input = () => { const s = manager.snapshot(); return { ...s, personaModels: {} }; };
  return { file, config, manager, input };
}

test("compatibility stays absent by default and is saved for one model without touching sibling settings", async () => {
  const f = await fixture(), initial = f.manager.snapshot();
  assert.ok(initial.models.every((m: any) => !Object.hasOwn(m, "reasoning_compatibility")));
  assert.equal(Object.hasOwn(resolveModel(f.config, "a"), "reasoning_compatibility"), false);
  assert.equal(Object.hasOwn(f.manager.connection("a"), "reasoning_compatibility"), false);
  const edit: any = f.input(); edit.models[0].reasoning_compatibility = mapping;
  const snapshot = await f.manager.save(edit);
  assert.deepEqual(snapshot.models[0].reasoning_compatibility, mapping);
  assert.deepEqual(snapshot.models[1], initial.models[1]);
  assert.deepEqual(resolveModel(f.config, "a").reasoning_compatibility, mapping);
  assert.deepEqual(f.manager.connection("a").reasoning_compatibility, mapping);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).custom, { keep: true });
  assert.ok(!JSON.stringify(snapshot).includes("SYNTHETIC_SECRET"));
  const connection = f.manager.connection("a"); connection.reasoning_compatibility!.response_field = "other";
  assert.deepEqual(f.manager.connection("a").reasoning_compatibility, mapping);
});

test("old clients omitting compatibility preserve it, explicit null clears it", async () => {
  const f = await fixture();
  const edit: any = f.input(); edit.models[0].reasoning_compatibility = mapping; await f.manager.save(edit);
  const oldClient: any = f.input(); delete oldClient.models[0].reasoning_compatibility;
  oldClient.models[0].name = "renamed";
  await f.manager.save(oldClient);
  assert.deepEqual(f.manager.snapshot().models[0].reasoning_compatibility, mapping);
  const clear: any = f.input(); clear.models[0].reasoning_compatibility = null;
  await f.manager.save(clear);
  assert.equal(Object.hasOwn(f.manager.snapshot().models[0], "reasoning_compatibility"), false);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(f.file, "utf8")).models[0], "reasoning_compatibility"), false);
});

test("compatibility rejects non-chat models, other protocols, unsafe mappings and parameters embedding", async () => {
  const f = await fixture(), before = await readFile(f.file, "utf8");
  const embedding: any = f.input(); embedding.models[1].type = "embedding"; embedding.models[1].reasoning_compatibility = mapping;
  await assert.rejects(f.manager.save(embedding), /仅适用/);
  const other: any = f.input(); other.models[1].reasoning_compatibility = mapping;
  other.providers[0].protocol = "custom-protocol"; other.providers[0].api_key = "SYNTHETIC_SECRET";
  await assert.rejects(f.manager.save(other), /OpenAI/);
  const unsafe: any = f.input(); unsafe.models[0].reasoning_compatibility = { response_field: "__proto__.value" };
  await assert.rejects(f.manager.save(unsafe));
  assert.throws(() => validateModelParameters({ reasoning_compatibility: mapping }));
  assert.equal(await readFile(f.file, "utf8"), before);
});
