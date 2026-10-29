import type { IncomingMessage, ServerResponse } from "node:http";

export type PluginHandler = (req: IncomingMessage, res: ServerResponse, context: { signal: AbortSignal }) => unknown | Promise<unknown>;
export type PageOptions = { title: string; settings?: boolean; navigation?: boolean };
export type PluginPage = PageOptions & { owner: string; path: string };
export interface PluginWeb {
  page(path: string, handler: PluginHandler, entry?: PageOptions): () => void;
  api(path: string, handler: PluginHandler): () => void;
}
export class PluginWebRegistry {
  private routes = new Map<string, { handler: PluginHandler; signal: AbortSignal; entry?: PluginPage }>();
  private controller = new AbortController();
  private pending = new Set<Promise<unknown>>();
  async close() {
    this.controller.abort(Error("插件页面服务已关闭"));
    await Promise.allSettled([...this.pending]);
  }
  pages() { return [...this.routes.values()].flatMap((r) => r.entry && !r.signal.aborted ? [{ ...r.entry }] : []); }
  register(owner: string, signal: AbortSignal, method: string, path: string, handler: PluginHandler, entry?: PageOptions) {
    signal = AbortSignal.any([this.controller.signal, signal]);
    signal.throwIfAborted();
    const prefix = owner ? `/plugins/${owner}/` : "/plugins/";
    if (typeof path !== "string" || !path.startsWith(prefix) || /[?#%\\\s]/.test(path) || new URL(path, "http://local").pathname !== path)
      throw Error("插件路由必须位于本插件的 /plugins/<id>/ 目录，不能包含查询串或路径跳转");
    const key = method + " " + path;
    if (this.routes.has(key)) throw Error("插件路由重复");
    if (typeof handler !== "function") throw Error("缺少页面处理函数");
    if (entry && (method !== "GET" || !owner || typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > 80))
      throw Error("页面入口需要有效标题和插件归属");
    if (entry?.settings && this.pages().some((p) => p.owner === owner && p.settings)) throw Error("插件只能注册一个设置入口");
    const row = { handler, signal, ...(entry ? { entry: { owner, path, title: entry.title.trim(), settings: !!entry.settings, navigation: !!entry.navigation } } : {}) };
    this.routes.set(key, row);
    const dispose = () => { if (this.routes.get(key) === row) this.routes.delete(key); signal.removeEventListener("abort", dispose); };
    signal.addEventListener("abort", dispose, { once: true });
    return dispose;
  }
  async serve(method: string, path: string, req: IncomingMessage, res: ServerResponse) {
    this.controller.signal.throwIfAborted();
    const row = this.routes.get(method + " " + path);
    if (!row) return false;
    const request = new AbortController();
    const signal = AbortSignal.any([row.signal, request.signal]);
    const close = () => { if (!res.writableEnded) request.abort(Error("页面请求已断开")); };
    const abort = () => { if (!res.writableEnded) { if (!res.headersSent) res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }); res.end("插件已停用或请求已取消"); } };
    res.on("close", close); signal.addEventListener("abort", abort, { once: true });
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return row.handler(req, res, { signal }); });
    this.pending.add(work);
    try { await work; }
    finally { this.pending.delete(work); res.off("close", close); signal.removeEventListener("abort", abort); }
    return true;
  }
}
