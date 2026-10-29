import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, IncomingMessage, ServerResponse, type IncomingHttpHeaders } from "node:http";
import { createPluginHttpServer, forwardPluginHttp } from "../core/plugin-http-bridge.ts";

const TOKEN = "x-whalelife-plugin-token", ROUTE = "x-whalelife-plugin-route";
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t: TestContext, routeId = "页面/stream") {
  const pluginController = new AbortController(), forwardController = new AbortController();
  const faults: Error[] = [], failures: unknown[] = [];
  const plugin = await createPluginHttpServer(pluginController.signal, (error) => { faults.push(error); });
  const front = createServer((req, res) => {
    void forwardPluginHttp(plugin.endpoint, routeId, req, res, forwardController.signal).catch((error) => {
      failures.push(error);
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) res.writeHead(502);
        res.end("Gateway failed");
      }
    });
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  const address = front.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    const stopped = new Promise<void>((resolve) => front.close(() => resolve()));
    front.closeAllConnections();
    await Promise.all([stopped, plugin.close()]);
  });
  return { plugin, pluginController, forwardController, faults, failures, routeId, port: address.port };
}
function get(port: number, headers: Record<string, string> = {}, path = "/test") {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; trailers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const client = request({ hostname: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers,
        trailers: res.trailers, body: Buffer.concat(chunks).toString() }));
    });
    client.on("error", reject); client.end();
  });
}

test("HTTP bridge preserves real Node objects, streaming uploads/responses and public metadata", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const metadata = deferred<{ method?: string; url?: string; headers: IncomingHttpHeaders; raw: string[]; distinct: NodeJS.Dict<string[]> }>();
  f.plugin.register(f.routeId, async (req, res) => {
    assert.ok(req instanceof IncomingMessage); assert.ok(res instanceof ServerResponse);
    metadata.resolve({ method: req.method, url: req.url, headers: req.headers, raw: req.rawHeaders, distinct: req.headersDistinct });
    res.writeHead(207, "Custom status", { "X-Plugin-Header": "preserved", "Set-Cookie": ["one=1", "two=2"],
      [TOKEN]: "must-not-escape", [ROUTE]: "must-not-escape" });
    for await (const chunk of req) res.write(`echo:${chunk.toString()};`);
    res.end("done");
  });
  const first = deferred<string>(), completed = deferred<{ body: string; status: number; message: string; headers: IncomingHttpHeaders }>();
  const client = request({ hostname: "127.0.0.1", port: f.port, path: "/plugins/example/data?q=one%20two", method: "POST", agent: false,
    headers: { Host: "public.example", "X-Caller": "present", [TOKEN]: "browser-spoof", [ROUTE]: "browser-spoof" } }, (res) => {
    let body = "";
    res.on("data", (chunk) => { body += chunk.toString(); first.resolve(body); });
    res.on("error", completed.reject);
    res.on("end", () => completed.resolve({ body, status: res.statusCode!, message: res.statusMessage!, headers: res.headers }));
  });
  client.on("error", completed.reject);
  t.after(() => client.destroy());
  client.write("first");
  assert.equal(await first.promise, "echo:first;", f.faults.map((error) => error.stack).join("\n"));
  assert.equal(client.writableEnded, false, "response starts before upload ends");
  client.end("second");
  const response = await completed.promise, seen = await metadata.promise;
  assert.equal(response.body, "echo:first;echo:second;done");
  assert.equal(response.status, 207); assert.equal(response.message, "Custom status");
  assert.equal(response.headers["x-plugin-header"], "preserved");
  assert.deepEqual(response.headers["set-cookie"], ["one=1", "two=2"]);
  assert.equal(response.headers[TOKEN], undefined); assert.equal(response.headers[ROUTE], undefined);
  assert.equal(seen.method, "POST"); assert.equal(seen.url, "/plugins/example/data?q=one%20two");
  assert.equal(seen.headers.host, "public.example"); assert.equal(seen.headers["x-caller"], "present");
  for (const name of [TOKEN, ROUTE]) {
    assert.equal(seen.headers[name], undefined); assert.equal(seen.distinct[name], undefined);
    assert.equal(seen.raw.some((value, index) => index % 2 === 0 && value.toLowerCase() === name), false);
  }
  assert.deepEqual(f.faults, []); assert.deepEqual(f.failures, []);
});

test("private HTTP listener refuses absent/incorrect credentials and unknown routes", { timeout: 6000 }, async (t) => {
  const f = await fixture(t); let calls = 0;
  f.plugin.register(f.routeId, (_req, res) => { calls++; res.end("private"); });
  for (const token of [undefined, "wrong", `${f.plugin.endpoint.token}extra`]) {
    const headers: Record<string, string> = { [ROUTE]: encodeURIComponent(f.routeId) };
    if (token) headers[TOKEN] = token;
    const response = await get(f.plugin.endpoint.port, headers);
    assert.equal(response.status, 403); assert.equal(response.body, "Forbidden");
  }
  const missing = await get(f.plugin.endpoint.port, { [TOKEN]: f.plugin.endpoint.token, [ROUTE]: "missing" });
  assert.equal(missing.status, 404); assert.equal(calls, 0); assert.deepEqual(f.faults, []);
});

test("HTTP bridge forwards request and response trailers without internal credentials", { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  f.plugin.register(f.routeId, async (req, res) => {
    for await (const _chunk of req) { /* Consume the streamed upload before inspecting trailers. */ }
    assert.equal(req.trailers["x-upload-end"], "ok");
    assert.equal(req.trailers[TOKEN], undefined);
    res.writeHead(200, { Trailer: "X-Response-End" }); res.write("body");
    res.addTrailers({ "X-Response-End": "ok", [TOKEN]: "private" }); res.end();
  });
  const response = await new Promise<{ body: string; trailers: IncomingHttpHeaders }>((resolve, reject) => {
    const client = request({ hostname: "127.0.0.1", port: f.port, method: "POST", agent: false,
      headers: { Trailer: "X-Upload-End" } }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("error", reject);
      res.on("end", () => resolve({ body, trailers: res.trailers }));
    });
    client.on("error", reject); client.write("upload"); client.addTrailers({ "X-Upload-End": "ok", [TOKEN]: "spoof" }); client.end();
  });
  assert.equal(response.body, "body"); assert.equal(response.trailers["x-response-end"], "ok");
  assert.equal(response.trailers[TOKEN], undefined); assert.deepEqual(f.faults, []);
});

test("forward cancellation aborts the actual plugin handler without faulting it", { timeout: 6000 }, async (t) => {
  const f = await fixture(t), entered = deferred<void>(), cancelled = deferred<void>();
  f.plugin.register(f.routeId, async (_req, _res, { signal }) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
      cancelled.resolve(); reject(signal.reason);
    }, { once: true }));
  });
  const response = get(f.port);
  await entered.promise; f.forwardController.abort(Error("host cutoff"));
  await cancelled.promise;
  assert.equal((await response).status, 503);
  assert.equal(f.failures.length, 1); assert.match(String(f.failures[0]), /host cutoff/);
  assert.deepEqual(f.faults, []);
});

test("browser disconnect cancels a running response handler", { timeout: 6000 }, async (t) => {
  const f = await fixture(t), cancelled = deferred<void>();
  f.plugin.register(f.routeId, async (_req, res, { signal }) => {
    res.write("started");
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
      cancelled.resolve(); reject(signal.reason);
    }, { once: true }));
  });
  const client = request({ hostname: "127.0.0.1", port: f.port, agent: false }, (res) => {
    res.once("data", () => client.destroy()); res.on("error", () => {});
  });
  client.on("error", () => {}); t.after(() => client.destroy()); client.end();
  await cancelled.promise;
  assert.equal(f.failures.length, 1); assert.deepEqual(f.faults, []);
});

test("cancelling an already streaming response terminates it without appending error text", { timeout: 6000 }, async (t) => {
  const f = await fixture(t), cancelled = deferred<void>(), received = deferred<string>();
  f.plugin.register(f.routeId, async (_req, res, { signal }) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": 1000 });
    res.write("partial binary");
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
      cancelled.resolve(); reject(signal.reason);
    }, { once: true }));
  });
  const client = request({ hostname: "127.0.0.1", port: f.port, agent: false }, (res) => {
    let body = "";
    res.on("data", (chunk) => { body += chunk; f.forwardController.abort(); });
    res.on("aborted", () => received.resolve(body)); res.on("error", () => {});
  });
  client.on("error", received.reject); t.after(() => client.destroy()); client.end();
  assert.equal(await received.promise, "partial binary"); await cancelled.promise;
  assert.equal(f.failures.length, 1); assert.deepEqual(f.faults, []);
});

test("route disposal cancels active work and revokes routing without affecting replacement", { timeout: 6000 }, async (t) => {
  const f = await fixture(t), entered = deferred<void>(), cancelled = deferred<void>();
  const dispose = f.plugin.register(f.routeId, async (_req, _res, { signal }) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
      cancelled.resolve(); reject(signal.reason);
    }, { once: true }));
  });
  assert.throws(() => f.plugin.register(f.routeId, () => {}), /重复/);
  const active = get(f.port); await entered.promise; dispose(); await cancelled.promise;
  assert.equal((await active).status, 503); assert.equal((await get(f.port)).status, 404);
  f.plugin.register(f.routeId, (_req, res) => { res.end("replacement"); }); dispose();
  assert.equal((await get(f.port)).body, "replacement"); assert.deepEqual(f.faults, []);
});

test("handler errors are attributed once while HTTP responses hide internal details", { timeout: 6000 }, async (t) => {
  const f = await fixture(t), original = Error(`secret ${f.plugin.endpoint.token} ${f.plugin.endpoint.port}`);
  f.plugin.register(f.routeId, async () => { throw original; });
  const response = await get(f.port);
  assert.equal(response.status, 500); assert.equal(response.body, "插件页面处理失败");
  assert.deepEqual(f.faults, [original]);
  assert.equal(response.body.includes(f.plugin.endpoint.token), false);
  assert.equal(response.body.includes(String(f.plugin.endpoint.port)), false);
});

test("closing waits for cooperative cleanup and bounds uncooperative pending handlers", { timeout: 6000 }, async (t) => {
  const f = await fixture(t), entered = deferred<void>(); let cleaned = false;
  f.plugin.register(f.routeId, async (_req, _res, { signal }) => {
    entered.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      setTimeout(() => { cleaned = true; resolve(); }, 20);
    }, { once: true }));
  });
  const response = get(f.port).catch(() => undefined); await entered.promise;
  await f.plugin.close(); await response; assert.equal(cleaned, true);
  assert.throws(() => f.plugin.register("late", () => {}), /停止/);
  assert.deepEqual(f.faults, []);

  const stubborn = await fixture(t), stuck = deferred<void>();
  stubborn.plugin.register(stubborn.routeId, async () => { stuck.resolve(); await new Promise(() => {}); });
  const pendingResponse = get(stubborn.port).catch(() => undefined); await stuck.promise;
  const start = performance.now(); await stubborn.plugin.close();
  assert.ok(performance.now() - start < 2500, "close must not wait forever for a stuck handler");
  await pendingResponse; assert.deepEqual(stubborn.faults, []);
});
