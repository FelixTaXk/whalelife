import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, IncomingMessage, ServerResponse, type IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../core/runtime.ts";
import { startWeb } from "../core/web.ts";
import { createPluginHttpServer, forwardPluginHttp } from "../core/plugin-http-bridge.ts";
import { WebClientDisconnectedError } from "../core/web-errors.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

type Log = { level: string; message: string; extra?: any };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "expected state did not arrive");
    await delay(10);
  }
}
function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function http(port: number, path: string, cookie = "", method = "GET", onChunk?: () => void) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string; aborted: boolean }>((resolve, reject) => {
    const client = request({ hostname: "127.0.0.1", port, path, method, agent: false,
      headers: { Cookie: cookie } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; onChunk?.(); });
      res.on("error", () => {});
      const done = (aborted: boolean) => resolve({ status: res.statusCode!, headers: res.headers, body, aborted });
      res.on("end", () => done(false)); res.on("aborted", () => done(true));
    });
    client.setTimeout(5000, () => client.destroy(Error("test HTTP timeout")));
    client.on("error", reject); client.end();
  });
}
async function fixture(t: TestContext, callTimeoutMs = 5000) {
  const root = await temporaryDirectory("whale-web-disconnect-");
  const logs: Log[] = [];
  const logger: any = { lines: [], secrets: [], log() {} };
  for (const level of ["debug", "info", "warn", "error"])
    logger[level] = (message: string, extra?: unknown) => logs.push({ level, message, extra });
  const runtime = new Runtime(root, logger, { startupTimeoutMs: 5000, callTimeoutMs, heartbeatTimeoutMs: 5000, stopTimeoutMs: 250 });
  let web: Awaited<ReturnType<typeof startWeb>> | undefined;
  t.after(async () => {
    runtime.beginClose(); await runtime.bus.stop();
    web?.server.closeAllConnections(); await web?.close();
  });
  web = await startWeb({ web: { port: 0 }, models: [], channels: { web: {} } },
    { logger, channels: {}, sessions: {}, memory: { status: async () => ({}) } }, runtime);
  const running = web;
  await runtime.builtin("web", running); await runtime.bus.start();
  const address = running.server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const login = await http(port, "/api/login", "", "POST");
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]![0].split(";")[0];
  const plugin = async (id: string, source: string) => {
    const directory = join(root, "plugins", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plugin.yaml"), JSON.stringify({ id, name: id, description: "disconnect regression fixture", version: "1.0.0", apiVersion: "1" }));
    await writeFile(join(directory, "index.ts"), source);
    await runtime.loadPath(id);
    assert.equal(runtime.records.get(id)?.status, "active", runtime.records.get(id)?.error);
  };
  return { web: running, runtime, logs, port, cookie, plugin,
    get: (path: string) => http(port, path, cookie),
    failures: () => logs.filter((entry) => entry.message === "Web 请求失败"),
    disconnects: () => logs.filter((entry) => entry.message === "Web 客户端已断开") };
}
async function bridge(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const faults: Error[] = [], owner = new AbortController();
  let plugin: Awaited<ReturnType<typeof createPluginHttpServer>> | undefined;
  t.after(async () => { owner.abort(); await plugin?.close(); });
  plugin = await createPluginHttpServer(owner.signal, (error) => { faults.push(error); });
  const active = plugin;
  const register = (id: string, handler: Parameters<typeof active.register>[1], extraSignal?: AbortSignal) => {
    active.register(id, handler);
    f.web.registerPlugin("bridge", owner.signal, "GET", "/plugins/bridge/" + id,
      (req, res, { signal }) => forwardPluginHttp(active.endpoint, id, req, res,
        extraSignal ? AbortSignal.any([signal, extraSignal]) : signal));
  };
  return { plugin: active, faults, register };
}

test("real browser disconnects during upload and response stay info and leave the isolated plugin and concurrent routes active", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await f.plugin("live", `export function apply(ctx) {
    let entered = 0, cancelled = 0;
    const wait = async (req, res, { signal }) => {
      entered++;
      req.on("data", () => {});
      if (req.method === "GET") res.write("started");
      try { await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
      finally { cancelled++; }
    };
    ctx.web.page("/plugins/live/stream", wait);
    ctx.web.api("/plugins/live/upload", wait);
    ctx.web.page("/plugins/live/state", (_req, res) => res.end(JSON.stringify({ entered, cancelled })));
    ctx.web.page("/plugins/live/ping", (_req, res) => res.end("alive"));
  }`);
  for (const method of ["GET", "POST"]) {
    const expected = method === "GET" ? 1 : 2;
    const firstChunk = deferred();
    const client = request({ hostname: "127.0.0.1", port: f.port, agent: false, method,
      path: method === "GET" ? "/plugins/live/stream" : "/plugins/live/upload",
      headers: { Cookie: f.cookie } }, (res) => {
      res.on("data", () => firstChunk.resolve()); res.on("error", () => {});
    });
    client.on("error", () => {}); t.after(() => client.destroy());
    if (method === "GET") { client.end(); await firstChunk.promise; }
    else {
      client.write("incomplete upload");
      await until(async () => JSON.parse((await f.get("/plugins/live/state")).body).entered === expected);
    }
    const concurrent = Promise.all(Array.from({ length: 5 }, () => f.get("/plugins/live/ping")));
    client.destroy();
    assert.ok((await concurrent).every((response) => response.status === 200 && response.body === "alive"));
    await until(async () => JSON.parse((await f.get("/plugins/live/state")).body).cancelled === expected);
    await until(() => f.disconnects().length === expected);
    assert.equal(f.runtime.records.get("live")?.status, "active");
  }
  assert.deepEqual(f.failures(), []);
  assert.ok(f.disconnects().every((entry) => entry.level === "info"));
  assert.equal(f.logs.some((entry) => entry.level === "error"), false);
  assert.equal((await f.get("/api/status")).status, 200);
});

test("registry cancellation and Web catch do not write to a disconnected response", { timeout: 8000 }, async (t) => {
  const f = await fixture(t), entered = deferred(), completed = deferred();
  let writesAfterDisconnect = 0;
  f.web.page("/plugins/wait", async (req: IncomingMessage, res: ServerResponse, { signal }: { signal: AbortSignal }) => {
    for (const method of ["writeHead", "end"] as const) {
      const original = res[method];
      (res as any)[method] = function (...args: any[]) {
        if (res.destroyed || req.aborted) writesAfterDisconnect++;
        return Reflect.apply(original, this, args);
      };
    }
    entered.resolve();
    try { await waitForAbort(signal); }
    finally { completed.resolve(); }
  });
  const client = request({ hostname: "127.0.0.1", port: f.port, path: "/plugins/wait", agent: false,
    headers: { Cookie: f.cookie } });
  client.on("error", () => {}); t.after(() => client.destroy()); client.end();
  await entered.promise; client.destroy(); await completed.promise;
  await until(() => f.disconnects().length === 1);
  assert.equal(writesAfterDisconnect, 0); assert.deepEqual(f.failures(), []);
});

test("error message, name and code cannot impersonate a verified client disconnect", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const forged = Object.assign(Error("页面请求已断开"), { name: "WebClientDisconnectedError", code: "ERR_CLIENT_DISCONNECTED" });
  f.web.page("/plugins/forged", () => { throw forged; });
  const response = await f.get("/plugins/forged");
  assert.equal(response.status, 400); assert.equal(JSON.parse(response.body).error, forged.message);
  assert.equal(f.failures().length, 1); assert.equal(f.failures()[0].level, "error");
  assert.strictEqual(f.failures()[0].extra.error, forged); assert.deepEqual(f.disconnects(), []);
});

test("unknown cancellation reasons retain error classification and the existing 503 response", { timeout: 8000 }, async (t) => {
  const f = await fixture(t), b = await bridge(t, f);
  const reasons = [Object.assign(Error("页面请求已断开"), { name: "WebClientDisconnectedError" }), "页面请求已断开"];
  for (const [index, reason] of reasons.entries()) {
    const controller = new AbortController(), entered = deferred(), cancelled = deferred();
    b.register("cancel-" + index, async (_req, _res, { signal }) => {
      entered.resolve();
      try { await waitForAbort(signal); } finally { cancelled.resolve(); }
    }, controller.signal);
    const response = f.get("/plugins/bridge/cancel-" + index);
    await entered.promise; controller.abort(reason);
    const result = await response; await cancelled.promise;
    assert.equal(result.status, 503); assert.equal(result.body, "插件已停用或请求已取消");
  }
  assert.equal(f.failures().length, 2); assert.ok(f.failures().every((entry) => entry.level === "error"));
  assert.deepEqual(f.disconnects(), []); assert.deepEqual(b.faults, []);
});

test("a request error without aborted evidence stays error and does not leak its raw text", { timeout: 8000 }, async (t) => {
  const f = await fixture(t), b = await bridge(t, f), owner = new AbortController();
  b.plugin.register("request-error", (_req, res) => res.end("not needed"));
  f.web.registerPlugin("bridge", owner.signal, "GET", "/plugins/bridge/request-error", (req, res, { signal }) => {
    const work = forwardPluginHttp(b.plugin.endpoint, "request-error", req, res, signal);
    assert.equal(req.aborted, false);
    req.emit("error", Error("private incoming error"));
    return work;
  });
  const response = await f.get("/plugins/bridge/request-error");
  assert.equal(response.status, 400); assert.doesNotMatch(response.body, /private incoming error/);
  assert.equal(f.failures().length, 1); assert.equal(f.failures()[0].level, "error");
  assert.equal(f.failures()[0].extra.error instanceof WebClientDisconnectedError, false);
  assert.deepEqual(f.disconnects(), []);
});

test("an already destroyed response alone is not evidence of a client disconnect", { timeout: 8000 }, async (t) => {
  const f = await fixture(t), b = await bridge(t, f);
  const socket = new Socket(), req = new IncomingMessage(socket), res = new ServerResponse(req);
  t.after(() => socket.destroy());
  res.destroy();
  assert.equal(req.aborted, false); assert.equal(res.destroyed, true);
  await assert.rejects(forwardPluginHttp(b.plugin.endpoint, "missing", req, res, new AbortController().signal),
    (error: unknown) => error instanceof Error && !(error instanceof WebClientDisconnectedError));
});

test("upstream disconnects and truncated plugin responses remain error, with private endpoint details hidden", { timeout: 8000 }, async (t) => {
  const f = await fixture(t), owner = new AbortController();
  let truncated: ServerResponse | undefined;
  const upstream = createServer((req, res) => {
    if (req.url?.endsWith("connection")) { req.socket.destroy(); return; }
    truncated = res;
    res.writeHead(200, { "Content-Length": 1000 }); res.write("partial");
  });
  t.after(async () => {
    const closed = new Promise<void>((resolve) => upstream.close(() => resolve()));
    upstream.closeAllConnections(); await closed;
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address === "object");
  const endpoint = { port: address.port, token: "synthetic-private-token" };
  for (const kind of ["connection", "response"]) {
    f.web.registerPlugin("upstream", owner.signal, "GET", "/plugins/upstream/" + kind,
      (req, res, { signal }) => forwardPluginHttp(endpoint, kind, req, res, signal));
    const response = await http(f.port, "/plugins/upstream/" + kind, f.cookie, "GET",
      kind === "response" ? () => truncated!.destroy() : undefined);
    if (kind === "connection") { assert.equal(response.status, 400); assert.match(response.body, /插件页面连接已中断/); }
    else { assert.equal(response.aborted, true); assert.equal(response.body, "partial"); }
    assert.equal(response.body.includes(String(endpoint.port)), false);
    assert.equal(response.body.includes(endpoint.token), false);
  }
  await until(() => f.failures().length === 2);
  assert.ok(f.failures().every((entry) => entry.level === "error" && !(entry.extra.error instanceof WebClientDisconnectedError)));
  assert.deepEqual(f.disconnects(), []);
});

test("isolated handler errors, timeout and crash remain plugin faults while unrelated routes survive", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, 1000);
  const cases = [
    ["handler-error", 'throw Object.assign(Error("页面请求已断开"), { name: "WebClientDisconnectedError" });', /页面请求已断开/],
    ["timeout", "await new Promise(() => {});", /超时/],
    ["crash", "process.exit(29);", /退出/],
  ] as const;
  await f.plugin("healthy", 'export function apply(ctx) { ctx.web.page("/plugins/healthy/ping", (_req, res) => res.end("healthy")); }');
  for (const [id, source, message] of cases) {
    await f.plugin(id, `export function apply(ctx) { ctx.web.page("/plugins/${id}/fail", async () => { ${source} }); }`);
    const response = await f.get(`/plugins/${id}/fail`);
    assert.ok(response.status >= 400);
    assert.doesNotMatch(response.body, /WebClientDisconnectedError|\bat .*\.ts:/);
    await until(() => f.runtime.records.get(id)?.status === "failed");
    assert.match(f.runtime.records.get(id).error, message);
    assert.ok(f.logs.some((entry) => entry.level === "error" && entry.message === "插件失败" && entry.extra.id === id));
    assert.equal((await f.get("/plugins/healthy/ping")).body, "healthy");
    assert.equal(f.runtime.records.get("healthy")?.status, "active");
  }
  assert.deepEqual(f.disconnects(), []);
});

test("stopping an isolated plugin keeps lifecycle cancellation at error and preserves its 503 response", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  await f.plugin("stopping", `export function apply(ctx) {
    let entered = false;
    ctx.web.page("/plugins/stopping/wait", async (_req, _res, { signal }) => {
      entered = true;
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    ctx.web.page("/plugins/stopping/state", (_req, res) => res.end(String(entered)));
  }`);
  const pending = f.get("/plugins/stopping/wait");
  await until(async () => (await f.get("/plugins/stopping/state")).body === "true");
  await f.runtime.action("stopping", "stop");
  const response = await pending;
  assert.equal(response.status, 503); assert.equal(response.body, "插件已停用或请求已取消");
  assert.equal(f.runtime.records.get("stopping")?.status, "stopped");
  assert.equal(f.failures().length, 1); assert.equal(f.failures()[0].level, "error");
  assert.equal(f.failures()[0].extra.error instanceof WebClientDisconnectedError, false);
  assert.deepEqual(f.disconnects(), []);
  assert.equal((await f.get("/plugins/stopping/wait")).status, 404);
  assert.equal((await f.get("/api/status")).status, 200);
});
