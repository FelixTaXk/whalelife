/** In-memory scheduling only. Executed work is never retried or replayed. */
export type QueuePolicy = {
  wait?: boolean;
  priority?: number;
  key?: string;
  scope?: object;
  beforeRun?: () => boolean | Promise<boolean>;
  onWaiting?: () => void;
};
type Job = {
  signal: AbortSignal; priority: number; key?: string; scope?: object;
  run(): Promise<unknown>; resolve(value: any): void; reject(reason: unknown): void;
  promise: Promise<any>; cancel(): void;
};
type Lane = { running: boolean; jobs: Job[] };

export class SessionQueue {
  private lanes = new Map<string, Lane>();
  private pending = 0;
  private locks: Set<string>;
  constructor(locks: Set<string>) { this.locks = locks; }

  submit<T>(id: string, signal: AbortSignal, run: () => Promise<T>, policy: QueuePolicy = {}): Promise<T> {
    signal.throwIfAborted();
    const priority = policy.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw Error("队列优先级须为 -100 到 100 的整数");
    if (policy.key !== undefined && (typeof policy.key !== "string" || !policy.key.trim() || policy.key.length > 128))
      throw Error("队列去重键须为 1–128 字符");
    if (policy.beforeRun !== undefined && typeof policy.beforeRun !== "function") throw Error("beforeRun 必须为函数");
    let lane = this.lanes.get(id);
    if (this.locks.has(id) && (!policy.wait || !lane)) throw Error("该会话正在回复或维护，请稍候");
    const duplicate = policy.key && lane?.jobs.find(job => job.scope === policy.scope && job.key === policy.key);
    if (duplicate) return this.follow(duplicate.promise, signal);
    if ((lane?.jobs.length ?? 0) >= 128 || this.pending >= 1024) throw Error("会话等待队列已满，请稍后重试");
    if (!lane) {
      lane = { running: false, jobs: [] };
      this.lanes.set(id, lane);
      // Reserve queued sessions too: deletion, restore and rebinding must not race accepted work.
      this.locks.add(id);
    }
    const current = lane;
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { signal, priority, key: policy.key, scope: policy.scope, promise, resolve, reject,
      run: async () => {
        signal.throwIfAborted();
        if (policy.beforeRun && await this.follow(Promise.resolve().then(policy.beforeRun), signal) !== true)
          throw Error("排队请求已失效，未执行");
        signal.throwIfAborted();
        return run();
      },
      cancel: () => {
        const index = current.jobs.indexOf(job);
        if (index < 0) return;
        current.jobs.splice(index, 1); this.pending--;
        signal.removeEventListener("abort", job.cancel);
        reject(signal.reason);
        this.drain(id, current);
      },
    };
    // Stable priority order; running jobs are never preempted.
    const index = current.jobs.findIndex(item => item.priority < priority);
    current.jobs.splice(index < 0 ? current.jobs.length : index, 0, job);
    this.pending++;
    signal.addEventListener("abort", job.cancel, { once: true });
    if (current.running) {
      try { policy.onWaiting?.(); } catch { /* UI notifications cannot drop accepted work. */ }
    }
    this.drain(id, current);
    return promise;
  }

  private drain(id: string, lane: Lane) {
    if (lane.running) return;
    const job = lane.jobs.shift();
    if (!job) {
      this.lanes.delete(id); this.locks.delete(id);
      return;
    }
    this.pending--;
    lane.running = true;
    job.signal.removeEventListener("abort", job.cancel);
    // Running cancellation is handled by the operation. Do not release its slot
    // until it settles: an external action may still finish and confirm success.
    const finish = () => {
      lane.running = false;
      this.drain(id, lane);
    };
    void Promise.resolve().then(job.run).then(
      value => { finish(); job.resolve(value); },
      error => { finish(); job.reject(error); },
    );
  }

  private follow<T>(original: Promise<T>, signal: AbortSignal): Promise<T> {
    // Coalescing never replaces the first input. A follower may cancel only its own wait.
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      original.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }
}
