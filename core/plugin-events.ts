import type { Logger } from "./logger.ts";

export type EventHandler = (payload: any) => unknown | Promise<unknown>;
/** Notifications run after their source operation, never inside its write lock. */
export class PluginEvents {
  private listeners = new Map<string, Set<EventHandler>>();
  private pending = new Set<Promise<unknown>>();
  private ready: any;
  private logger: Logger;
  constructor(logger: Logger) { this.logger = logger; }
  on(name: string, handler: EventHandler) {
    if (typeof name !== "string" || !name || typeof handler !== "function") throw Error("事件订阅无效");
    const group = this.listeners.get(name) ?? new Set<EventHandler>();
    group.add(handler); this.listeners.set(name, group);
    if (name === "whalelife/ready" && this.ready) this.dispatch(name, handler, this.ready);
    return () => { group.delete(handler); if (!group.size && this.listeners.get(name) === group) this.listeners.delete(name); };
  }
  emit(name: string, payload: any) {
    if (name === "whalelife/ready") this.ready = structuredClone(payload);
    for (const fn of this.listeners.get(name) ?? []) this.dispatch(name, fn, payload);
  }
  private dispatch(name: string, fn: EventHandler, payload: any) {
    const copy = structuredClone(payload);
    const task = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      if (this.listeners.get(name)?.has(fn)) await fn(copy);
    }).catch((error) => this.logger.error("插件事件处理失败", { event: name, error }));
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }
  async drain() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
}
