/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { resolveModel } from "../core/model-config.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

test("authenticated cache check, paid consent, one-time application and rollback through the saved connection", async t => {
  const requests: any[] = [];
  const relay = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    const stable = payload.messages.slice(1).some((m: any) => m.role === "system");
    const code = JSON.stringify(payload.messages).match(/本轮合成回执码为 ([A-F0-9]+)/)?.[1] ?? "MISSING";
    const usage = { prompt_tokens: 5000, completion_tokens: 4, prompt_cache_hit_tokens: stable ? 4000 : 0,
      cost: stable ? 0.001 : 0.003, currency: "USD" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: " + JSON.stringify({ choices: [{ delta: { content: code }, finish_reason: "stop" }], usage }) + "\n\ndata: [DONE]\n\n");
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const address = relay.address();
  if (!address || typeof address === "string") throw Error("Missing test listener");
  const root = await temporaryDirectory("whale-cache-web-");
  const file = join(root, "config/config.json");
  await mkdir(join(root, "config"));
  const model = { id: "chat-one", model: "example-chat", provider: "relay", type: "chat", name: "One", enabled: true, parameters: {}, context_window: 32000 };
  const provider = { id: "relay", name: "Synthetic relay", protocol: "openai-compatible", enabled: true,
    base_url: "http://127.0.0.1:" + address.port + "/v1", api_key: "", timeout_seconds: 5 };
  await writeFile(file, JSON.stringify({
    web: { host: "127.0.0.1", port: 0, password: "test" }, log: { level: "error" },
    providers: [provider, { ...provider, id: "official", base_url: "https://api.deepseek.com" }],
    models: [model, { ...model, id: "sibling" }, { ...model, id: "builtin", provider: "official" }],
    model_bindings: { chat: model.id }, memory: { root: "memory" },
    personas: { fish: { name: "Test persona", file: "memory/personas/fish.md", model: model.id, permission: "off" } },
    channels: { web: { persona: "fish", permission: "off" } },
  }));
  const app = await boot(root);
  t.after(() => app.close());
  const serverAddress = app.web.server.address();
  if (!serverAddress || typeof serverAddress === "string") throw Error("Missing console");
  const url = "http://127.0.0.1:" + serverAddress.port;
  const auth = await fetch(url + "/api/login", { method: "POST", body: JSON.stringify({ password: "test" }) });
  const cookie = auth.headers.get("set-cookie")!.split(";")[0];
  const path = "/api/cache-diagnostics";
  const get = (id = model.id) => fetch(url + path + "?model=" + id, {headers: {Cookie: cookie}}).then(r => r.json());
  const post = (action: string, body: any, contentType = "application/json") => fetch(url + path + "/" + action, {
    method: "POST", headers: {Cookie: cookie, "Content-Type": contentType}, body: JSON.stringify(body) });
  await utimes(file, new Date(0), new Date(Date.now() - 60000));
  const original = await readFile(file, "utf8");
  assert.equal((await fetch(url + path + "?model=chat-one")).status, 401);
  assert.equal((await post("test", {}, "text/plain")).status, 415);
  assert.equal((await get()).advice.code, "insufficient");
  assert.equal((await get("builtin")).mode, "builtin");
  for (let i = 0; i < 3; i++) {
    const run = await app.executionArchive.start("one", { kind: "conversation" });
    await run!.write("context", { provider: "relay", model: model.model, model_id: model.id });
    await run!.write("model_start", { round: 1 });
    await run!.write("model_result", { round: 1, usage: { prompt_tokens: 5000, prompt_cache_hit_tokens: 0 } });
    await run!.end("completed");
  }
  const check = await get();
  assert.equal(check.advice.code, "test");
  assert.equal(check.mode, "standard");
  assert.ok(check.confirm_token);
  const confirmed = { model: model.id, revision: check.revision, confirm_token: check.confirm_token, confirm_paid: true };
  assert.equal((await post("test", { ...confirmed, confirm_paid: false })).status, 400);
  assert.equal((await post("test", { ...confirmed, model: "sibling" })).status, 409);
  assert.equal((await post("apply", { ...confirmed, enabled: true, test_id: "made-up" })).status, 409);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal(requests.length, 0);
  const pending = post("test", confirmed);
  // Wait for the relay to receive the first authorized request before trying to replay it.
  const deadline = Date.now() + 6000;
  while (!requests.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(requests.length);
  assert.equal((await post("test", confirmed)).status, 409);
  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.verdict, "better", result.message);
  assert.ok(result.test_id);
  assert.equal(requests.length, check.plan.max_requests);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal((await get()).result.test_id, result.test_id);
  const activate = { model: model.id, revision: check.revision, enabled: true, test_id: result.test_id };
  assert.equal((await post("apply", { ...activate, model: "sibling" })).status, 409);
  assert.equal((await post("apply", activate)).status, 200);
  assert.equal((await get()).mode, "optimized");
  assert.equal((await get("sibling")).mode, "standard");
  assert.equal((await post("apply", activate)).status, 409);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(resolveModel(persisted, model.id).cache_prefix_optimized, true);
  assert.deepEqual(persisted.providers, JSON.parse(original).providers);
  assert.deepEqual(persisted.models.slice(1), JSON.parse(original).models.slice(1));
  const edited = structuredClone(persisted);
  edited.providers[0].base_url += "/elsewhere";
  assert.equal(resolveModel(edited, model.id).cache_prefix_optimized, undefined);
  const snapshot = app.modelConfig.snapshot();
  snapshot.models[0].name = "Renamed";
  await app.modelConfig.save({ ...snapshot, personaModels: { fish: model.id } });
  assert.equal((await get()).mode, "optimized");
  const layouts: boolean[] = [];
  app.llm.chat = async ({ messages }: any) => {
    layouts.push(messages.slice(1).some((m: any) => m.role === "system" && m.content.includes("【主干时间】")));
    return { text: "模拟聊天回复", toolCalls: [], finish_reason: "stop", usage: { prompt_tokens: 75, completion_tokens: 5 } };
  };
  await app.memory.saveSessionMeta("layout-check", { name: "模拟聊天", context: { history_enabled: true } });
  await app.sessions.chat("layout-check", "第一句", () => {});
  assert.equal((await post("apply", { model: model.id, revision: app.modelConfig.revision, enabled: false })).status, 200);
  assert.equal((await get()).mode, "standard");
  await app.sessions.chat("layout-check", "第二句", () => {});
  assert.deepEqual(layouts, [true, false]);
  assert.equal(requests.length, check.plan.max_requests);
});
