/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { startWeb } from "../core/web.ts";
import { Logger } from "../core/logger.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext, probe: (input: any, signal: AbortSignal) => Promise<any>) {
  const root = await temporaryDirectory("whale-compatibility-http-");
  const app = await startWeb({ web: { host: "127.0.0.1", port: 0, password: "synthetic" }, providers: [],
    channels: { web: { persona: "synthetic", permission: "off" } } }, {
    logger: new Logger(root), memory: { status: async () => ({ files: 0 }) }, sessions: {},
    modelConfig: { probeCompatibility: probe },
  }, { list: () => [] });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ password: "synthetic" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  return { app, base, endpoint: base + "/api/model-config/compatibility", cookie };
}

test("compatibility endpoint requires authentication and same origin before starting requests", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return {}; });
  assert.equal((await fetch(f.endpoint, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(f.endpoint, { method: "POST", headers: { Cookie: f.cookie, Origin: "https://foreign.invalid" }, body: "{}" })).status, 403);
  assert.equal(calls, 0);
});

test("compatibility endpoint forwards the draft and returns a verified proposal without saving", async t => {
  const draft = { provider: { id: "test" }, model: { model: "test-chat" }, assistantModelId: "helper" };
  const result = { verified: true, requests: 4, compatibility: { response_field: "reasoning", request_field: "reasoning_content" },
    message: "已验证", usage: { input_tokens: 10, output_tokens: 4, requests: [] } };
  let calls = 0;
  const f = await fixture(t, async (input, signal) => {
    calls++; assert.deepEqual(input, draft); assert.equal(signal.aborted, false); return result;
  });
  const response = await fetch(f.endpoint, { method: "POST", headers: { Cookie: f.cookie, Origin: f.base }, body: JSON.stringify(draft) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), result); assert.equal(calls, 1);
});

test("disconnect cancels the compatibility probe instead of allowing further paid requests", async t => {
  let entered!: () => void, cancelled!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stopped = new Promise<void>(resolve => { cancelled = resolve; });
  const f = await fixture(t, async (_input, signal) => {
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      cancelled(); reject(signal.reason);
    }, { once: true }));
  });
  const abort = new AbortController();
  const pending = fetch(f.endpoint, { method: "POST", headers: { Cookie: f.cookie }, body: "{}", signal: abort.signal });
  const rejected = assert.rejects(pending);
  await started; abort.abort(); await rejected;
  await stopped;
});

test("host shutdown cancels an in-flight compatibility probe", { timeout: 5000 }, async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signalSeen: AbortSignal | undefined;
  const f = await fixture(t, async (_input, signal) => {
    signalSeen = signal; entered();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const pending = fetch(f.endpoint, { method: "POST", headers: { Cookie: f.cookie }, body: "{}" });
  await started;
  const closing = f.app.close();
  await pending.then(async r => { await r.text(); }, () => {});
  await closing; assert.equal(signalSeen?.aborted, true);
});
