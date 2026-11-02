import type { Disposable, OptionalService } from "./plugin-api.ts";

type Source = { owner: object; value: any };
const unavailable = () => Error("可选服务连接已失效；请等待新连接，不自动重放操作");

// Do not forward an unguarded RPC method: even a method saved before reload must
// check this particular binding, rather than silently target the new provider.
function guard(value: any, signal: AbortSignal) {
  const cache = new WeakMap<object, any>();
  const methods = new WeakMap<Function, WeakMap<object, Function>>();
  const wrap = (source: any, owner?: any): any => {
    if (!source || !["object", "function"].includes(typeof source)) return source;
    if (typeof source === "function") {
      owner ??= source;
      let owners = methods.get(source);
      if (!owners) { owners = new WeakMap(); methods.set(source, owners); }
      if (owners.has(owner)) return owners.get(owner);
      const method = (...args: any[]) => {
        signal.throwIfAborted();
        const result: any = Reflect.apply(source, owner, args);
        if (!result || typeof result.then !== "function") return result;
        return new Promise((resolve, reject) => {
          const cancel = () => reject(signal.reason);
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
          void Promise.resolve(result).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
        });
      };
      owners.set(owner, method);
      return method;
    }
    if (cache.has(source)) return cache.get(source);
    const proxy = new Proxy(Object.create({}), {
      get(_target, key) {
        signal.throwIfAborted();
        if (key === "then" || ["__proto__", "constructor", "prototype"].includes(String(key))) return undefined;
        return wrap(Reflect.get(source, key), source);
      },
      set() { throw Error("可选服务连接只读"); },
    });
    cache.set(source, proxy);
    return proxy;
  };
  return wrap(value);
}

class DeadlineError extends Error {}
function bounded<T>(work: Promise<T>, ms: number, signal?: AbortSignal, grace = ms): Promise<T> {
  return new Promise((resolve, reject) => {
    const expire = () => reject(new DeadlineError("可选服务回调或清理超时，已切割消费者"));
    let timer = setTimeout(expire, ms);
    const cancelled = () => { clearTimeout(timer); timer = setTimeout(expire, grace); };
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    void work.then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); });
  });
}

class Binding {
  controller = new AbortController();
  resources = new Set<() => Promise<void>>();
  public: OptionalService<any>;
  private closed?: Promise<void>;
  constructor(value: any) {
    this.public = Object.freeze({ service: guard(value, this.controller.signal), signal: this.controller.signal,
      effect: <T extends Disposable>(fn: () => T): T => {
        this.controller.signal.throwIfAborted();
        const resource = fn();
        const original = typeof resource === "function" ? resource : resource?.dispose?.bind(resource);
        if (typeof original !== "function") throw Error("可选服务 effect 必须返回清理函数或可释放资源");
        let task: Promise<void> | undefined;
        const dispose = () => {
          if (task) return task;
          let done!: (value: void | PromiseLike<void>) => void, failed!: (reason: unknown) => void;
          task = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
          // Host-owned tool/page removals run immediately, before any new callback.
          try { done((original as () => void | Promise<void>)()); } catch (error) { failed(error); }
          // Keep pending manual cleanup in the scope until it has actually finished.
          void task.then(() => this.resources.delete(dispose), () => this.resources.delete(dispose));
          return task;
        };
        this.resources.add(dispose);
        if (this.controller.signal.aborted) { void dispose().catch(() => {}); this.controller.signal.throwIfAborted(); }
        if (typeof resource === "function") return dispose as T;
        resource.dispose = dispose;
        return resource;
      },
    });
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.controller.abort(unavailable());
    this.closed = Promise.all([...this.resources].map(dispose => dispose())).then(() => {});
    return this.closed;
  }
}

/** Host-owned optional relationships. No dependency edges, platform names or new plugin records. */
export class OptionalServices {
  private watchers = new Set<() => void>();
  private resolve: (record: any, name: string) => Source | undefined;
  private timeout: number;
  private cleanupTimeout: number;
  constructor(resolve: OptionalServices["resolve"], timeout: number, cleanupTimeout: number) {
    this.resolve = resolve; this.timeout = timeout; this.cleanupTimeout = cleanupTimeout;
  }
  refresh() { for (const update of [...this.watchers]) update(); }
  watch(record: any, name: string, listener: (binding: OptionalService<any> | undefined) => unknown, fault: (error: unknown) => void) {
    record.controller.signal.throwIfAborted();
    if (typeof name !== "string" || !record.manifest.optionalDepends?.includes(name)) throw Error("请在 optionalDepends 声明可选服务：" + name);
    if (record.manifest.depends?.includes(name)) throw Error("同一服务不能同时声明为必需与可选依赖：" + name);
    if (typeof listener !== "function") throw Error("可选服务需要状态回调");
    let source: Source | undefined, binding: Binding | undefined, started = false, disposed = false;
    let chain = Promise.resolve();
    const fail = (error: unknown) => { if (!record.controller.signal.aborted) fault(error); };
    const close = (old?: Binding) => {
      const task = old ? bounded(old.close(), this.cleanupTimeout) : Promise.resolve();
      void task.catch(fail);
      return task;
    };
    const update = () => {
      if (disposed) return;
      const next = this.resolve(record, name);
      if (started && next?.owner === source?.owner && next?.value === source?.value) return;
      started = true; source = next;
      const cleanup = close(binding);
      const current = binding = next ? new Binding(next.value) : undefined;
      chain = chain.then(async () => {
        await cleanup;
        await new Promise<void>(resolve => setImmediate(resolve));
        if (disposed || binding !== current) return;
        try {
          await bounded(Promise.resolve().then(() => listener(current?.public)), this.timeout,
            current?.controller.signal ?? record.controller.signal, this.cleanupTimeout);
        } catch (error) {
          // Cancellation is an expected business failure; an uncooperative callback is not.
          if (!current?.controller.signal.aborted || error instanceof DeadlineError) throw error;
        }
      }).catch(fail);
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true; this.watchers.delete(update);
      record.controller.signal.removeEventListener("abort", dispose);
      void close(binding); binding = undefined; source = undefined;
    };
    this.watchers.add(update);
    record.controller.signal.addEventListener("abort", dispose, { once: true });
    update();
    return dispose;
  }
}
