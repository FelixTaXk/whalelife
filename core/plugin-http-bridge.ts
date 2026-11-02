/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import type { PluginHandler } from "./plugin-api.ts";

export type PluginHttpEndpoint = { port: number; token: string };
export interface PluginHttpServer {
  endpoint: PluginHttpEndpoint;
  register(routeId: string, handler: PluginHandler): () => void;
  close(): Promise<void>;
}
const TOKEN = "x-whalelife-plugin-token";
const ROUTE = "x-whalelife-plugin-route";
const INTERNAL = new Set([TOKEN, ROUTE]);
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "transfer-encoding", "upgrade"]);
const SHUTDOWN_GRACE_MS = 1000;
function routeName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function publicHeaders(raw: string[], connection?: string): string[] {
  const omitted = new Set([...HOP_HEADERS, ...INTERNAL,
    ...(connection ?? "").split(",").map((name) => name.trim().toLowerCase())]);
  const result: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2)
    if (!omitted.has(raw[index].toLowerCase())) result.push(raw[index], raw[index + 1]);
  return result;
}
function stripInternalHeaders(req: IncomingMessage) {
  // Node lazily builds headersDistinct using its original raw-header count.
  // Materialize it before removing raw entries, then sanitize both public maps.
  const distinct = req.headersDistinct;
  for (const name of INTERNAL) { delete req.headers[name]; delete distinct[name]; }
  const raw: string[] = [];
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2)
    if (!INTERNAL.has(req.rawHeaders[index].toLowerCase())) raw.push(req.rawHeaders[index], req.rawHeaders[index + 1]);
  req.rawHeaders = raw;
}
function publicTrailers(trailers: NodeJS.Dict<string>): NodeJS.Dict<string> {
  return Object.fromEntries(Object.entries(trailers).filter(([name]) => !INTERNAL.has(name.toLowerCase())));
}
function cancelled(reason?: unknown) {
  return reason instanceof Error ? reason : new Error("插件页面请求已取消");
}
function finishCancelled(res: ServerResponse) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("插件已停用或请求已取消");
}

/** Forward only an already authenticated public route; never accept an endpoint from a browser. */
export function forwardPluginHttp(
  endpoint: PluginHttpEndpoint, routeId: string, req: IncomingMessage, res: ServerResponse, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
      typeof endpoint.token !== "string" || !endpoint.token || !routeName(routeId))
    throw Error("插件页面连接配置无效");
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let incoming: IncomingMessage | undefined;
    const headers = publicHeaders(req.rawHeaders, req.headers.connection);
    headers.push(TOKEN, endpoint.token, ROUTE, encodeURIComponent(routeId));
    const outgoing = request({ hostname: "127.0.0.1", port: endpoint.port,
      path: req.url || "/", method: req.method, headers, setHost: false, agent: false });
    const cleanup = () => {
      req.off("aborted", disconnected); req.off("error", disconnected); req.off("end", requestEnded);
      res.off("finish", responseFinished); res.off("close", responseClosed);
      signal.removeEventListener("abort", aborted);
      req.unpipe(outgoing);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve();
    };
    const terminate = (error: Error, sendCancellation = false) => {
      if (settled) return;
      settle(error);
      if (sendCancellation) finishCancelled(res);
      outgoing.destroy(); incoming?.destroy();
      if (!sendCancellation && res.headersSent && !res.writableEnded) res.destroy();
    };
    const aborted = () => terminate(cancelled(signal.reason), true);
    const disconnected = () => terminate(Error("页面请求已断开"));
    const responseClosed = () => { if (!res.writableFinished) disconnected(); };
    const responseFinished = () => {
      settle();
      // A handler may reject a request before its upload completes.
      if (!outgoing.writableFinished) outgoing.destroy();
      if (!req.readableEnded && !req.destroyed) req.resume();
    };
    const requestEnded = () => {
      if (Object.keys(req.trailers).length) outgoing.addTrailers(publicTrailers(req.trailers));
      outgoing.end();
    };
    req.on("aborted", disconnected); req.on("error", disconnected); req.on("end", requestEnded);
    res.on("finish", responseFinished); res.on("close", responseClosed);
    signal.addEventListener("abort", aborted, { once: true });
    // Do not relay socket error strings: they may include the private endpoint port.
    outgoing.on("error", () => terminate(Error("插件页面连接已中断")));
    outgoing.on("response", (response) => {
      incoming = response;
      if (settled || res.destroyed || res.writableEnded) { response.destroy(); return; }
      response.on("error", () => terminate(Error("插件页面响应已中断")));
      response.on("aborted", () => terminate(Error("插件页面响应已中断")));
      try {
        res.writeHead(response.statusCode || 502, response.statusMessage,
          publicHeaders(response.rawHeaders, response.headers.connection));
      } catch { terminate(Error("插件页面响应无法转发")); return; }
      response.on("end", () => {
        if (settled || res.destroyed || res.writableEnded) return;
        if (Object.keys(response.trailers).length) res.addTrailers(publicTrailers(response.trailers));
        res.end();
      });
      response.pipe(res, { end: false });
    });
    if (signal.aborted) aborted();
    else if (req.aborted || res.destroyed) disconnected();
    else if (req.readableEnded) requestEnded();
    else req.pipe(outgoing, { end: false });
  });
}

/** Lives inside the isolated plugin execution process; handlers receive actual Node HTTP objects. */
export async function createPluginHttpServer(
  pluginSignal: AbortSignal,
  onFault: (error: Error) => unknown | Promise<unknown>,
  callTimeoutMs = 600000,
): Promise<PluginHttpServer> {
  pluginSignal.throwIfAborted();
  const token = randomBytes(32).toString("base64url");
  const expectedToken = Buffer.from(token);
  const controller = new AbortController();
  const routes = new Map<string, { handler: PluginHandler; controller: AbortController }>();
  const pending = new Set<Promise<unknown>>();
  const sockets = new Set<Socket>();
  let closing: Promise<void> | undefined;
  let stopped = false;
  const fault = (reason: unknown) => {
    const error = reason instanceof Error ? reason : Error(String(reason));
    void Promise.resolve().then(() => onFault(error)).catch(() => {});
  };
  const server = createServer((req, res) => {
    const supplied = req.headers[TOKEN];
    const authorized = typeof supplied === "string" && Buffer.byteLength(supplied) === expectedToken.length &&
      timingSafeEqual(Buffer.from(supplied), expectedToken);
    if (!authorized) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden"); req.resume(); return;
    }
    let routeId: unknown = req.headers[ROUTE];
    if (typeof routeId === "string") {
      try { routeId = decodeURIComponent(routeId); } catch { routeId = undefined; }
    }
    stripInternalHeaders(req);
    if (stopped || pluginSignal.aborted) { finishCancelled(res); req.resume(); return; }
    const route = routeName(routeId) ? routes.get(routeId) : undefined;
    if (!route) { res.writeHead(404); res.end("Not found"); req.resume(); return; }
    const requestController = new AbortController();
    const signal = AbortSignal.any([pluginSignal, controller.signal, route.controller.signal, requestController.signal]);
    let workDone = false, responseDone = false;
    const timer = setTimeout(() => {
      if (signal.aborted) return;
      const error = Error("插件页面处理超时，已切割");
      requestController.abort(error); fault(error);
    }, callTimeoutMs);
    timer.unref();
    const cleanup = () => {
      if (!workDone || !responseDone) return;
      clearTimeout(timer);
      req.off("aborted", disconnected); req.off("error", disconnected);
      res.off("finish", finish); res.off("close", closeResponse);
      signal.removeEventListener("abort", abort);
    };
    const disconnected = () => requestController.abort(Error("页面请求已断开"));
    const abort = () => { clearTimeout(timer); finishCancelled(res); };
    const finish = () => { responseDone = true; cleanup(); };
    const closeResponse = () => {
      if (!res.writableFinished) disconnected();
      responseDone = true; cleanup();
    };
    req.on("aborted", disconnected); req.on("error", disconnected);
    res.on("finish", finish); res.on("close", closeResponse);
    signal.addEventListener("abort", abort, { once: true });
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return route.handler(req, res, { signal });
    }).catch((error) => {
      if (signal.aborted) return;
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy();
        else { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); res.end("插件页面处理失败"); }
      }
      fault(error);
    }).finally(() => { pending.delete(work); workDone = true; cleanup(); });
    pending.add(work);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.on("error", () => fault(Error("插件页面服务错误")));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("插件页面服务启动失败");
  const close = () => closing ??= (async () => {
    stopped = true;
    pluginSignal.removeEventListener("abort", closeOnAbort);
    controller.abort(Error("插件页面服务已停止"));
    for (const route of routes.values()) route.controller.abort(Error("插件页面已撤销"));
    routes.clear();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([closed, ...pending]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_GRACE_MS); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    // A non-cooperating handler may remain pending; its owner terminates the isolated process.
  })();
  const closeOnAbort = () => { void close(); };
  pluginSignal.addEventListener("abort", closeOnAbort, { once: true });
  if (pluginSignal.aborted) { await close(); throw cancelled(pluginSignal.reason); }
  return {
    endpoint: { port: address.port, token },
    register(routeId, handler) {
      pluginSignal.throwIfAborted(); controller.signal.throwIfAborted();
      if (!routeName(routeId) || typeof handler !== "function") throw Error("插件页面路由无效");
      if (routes.has(routeId)) throw Error("插件页面路由重复");
      const row = { handler, controller: new AbortController() };
      routes.set(routeId, row);
      return () => {
        if (routes.get(routeId) === row) routes.delete(routeId);
        row.controller.abort(Error("插件页面已撤销"));
      };
    },
    close,
  };
}
