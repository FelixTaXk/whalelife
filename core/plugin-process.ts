import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PluginRPC } from "./plugin-rpc.ts";
import { forwardPluginHttp, type PluginHttpEndpoint } from "./plugin-http-bridge.ts";

export type PluginRuntimeOptions = { startupTimeoutMs?: number; callTimeoutMs?: number; heartbeatTimeoutMs?: number; stopTimeoutMs?: number; maxOldGenerationSizeMb?: number };
const defaults = { startupTimeoutMs: 15000, callTimeoutMs: 600000, heartbeatTimeoutMs: 5000, stopTimeoutMs: 1000, maxOldGenerationSizeMb: 256 };
export function pluginRuntimeOptions(input: PluginRuntimeOptions = {}) {
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) if (input[key] !== undefined) {
    const value = input[key]!;
    if (!Number.isSafeInteger(value) || value < (key === "maxOldGenerationSizeMb" ? 16 : 50) || value > (key === "maxOldGenerationSizeMb" ? 4096 : 3600000)) throw Error("插件运行配置无效：" + key);
    result[key] = value;
  }
  return result;
}

export class PluginProcess {
  private child: ChildProcess;
  private peer: PluginRPC;
  private lastPulse = Date.now();
  private closing?: Promise<void>;
  private dead = false;
  private faulted = false;
  private ready: Promise<void>;
  private watchdog: NodeJS.Timeout;
  private endpoint?: PluginHttpEndpoint;
  private options: ReturnType<typeof pluginRuntimeOptions>;
  private onFault: (error: Error) => void;
  private id: string;
  constructor(id: string, ctx: any, options: PluginRuntimeOptions, onFault: (error: Error) => void) {
    this.id = id; this.options = pluginRuntimeOptions(options); this.onFault = onFault;
    this.child = fork(fileURLToPath(new URL("./plugin-process-relay.ts", import.meta.url)), [], {
      execPath: process.execPath, execArgv: [], windowsHide: true, serialization: "advanced", stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, WHALE_PLUGIN_HEAP_MB: String(this.options.maxOldGenerationSizeMb), WHALE_PLUGIN_CALL_TIMEOUT_MS: String(this.options.callTimeoutMs) },
    });
    this.peer = new PluginRPC({ side: "host", timeout: this.options.callTimeoutMs, onFault: (error) => this.fault(error),
      transport: { send: (message) => { if (this.child.connected) this.child.send(message, (error) => { if (error && !this.closing) this.fault(error); }); else throw Error("插件执行进程已断开"); } } });
    let prepared!: () => void, failed!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { prepared = resolve; failed = reject; }); void this.ready.catch(() => {});
    this.child.on("message", (message: any) => {
      if (message.type === "ready") { this.lastPulse = Date.now(); prepared(); }
      else if (message.type === "pulse") this.lastPulse = Date.now();
      else if (message.type === "fatal") this.fault(Error(message.error));
      else { try { this.peer.receive(message); } catch (error: any) { this.fault(error); } }
    });
    this.child.on("error", (error) => { if (!this.child.pid) this.dead = true; failed(error); this.fault(error); });
    this.child.on("exit", (code, signal) => { this.dead = true; const error = Error(`插件 ${id} 进程退出（${signal ?? code}）`); failed(error); this.peer.close(error); if (!this.closing) this.fault(error); });
    const log = (level: "info" | "warn", chunk: Buffer) => { for (const line of chunk.toString().split(/\r?\n/)) if (line) ctx.logger[level]("插件输出", { plugin: id, text: line.slice(0, 4000) }); };
    this.child.stdout?.on("data", (chunk) => log("info", chunk)); this.child.stderr?.on("data", (chunk) => log("warn", chunk));
    this.watchdog = setInterval(() => { if (!this.closing && Date.now() - this.lastPulse > this.options.heartbeatTimeoutMs) this.fault(Error("插件执行无响应，已切割")); }, Math.min(250, this.options.heartbeatTimeoutMs / 2));
    this.watchdog.unref();
    const kernel = Object.freeze({
      ctx,
      get: (name: string, strict?: boolean) => this.peer.expose(ctx.get(name, strict)),
      optional: (name: string, listener: any) => ctx.optional(name, (binding: any) => listener(binding ? {
        service: this.peer.expose(binding.service), signal: binding.signal,
        registerCleanup: (cleanup: any) => binding.effect(() => cleanup),
      } : undefined)),
      openWeb: (endpoint: PluginHttpEndpoint) => { this.endpoint = endpoint; },
      registerWeb: (kind: string, path: string, route: string, entry: any) => {
        if (!this.endpoint || !["page", "api"].includes(kind)) throw Error("插件页面服务未就绪");
        return ctx.web[kind](path, (req: any, res: any, { signal }: any) => forwardPluginHttp(this.endpoint!, route, req, res, signal), entry);
      },
    });
    this.peer.bind("kernel", kernel);
  }
  get pid() { return this.child.pid; }
  private fault(error: Error) {
    if (this.faulted || this.closing) return;
    this.faulted = true;
    this.onFault(error);
    void this.close(true);
  }
  async start(directory: string) {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = Error("插件初始化超时，已切割"); this.fault(error); reject(error); }, this.options.startupTimeoutMs); });
    try { await Promise.race([(async () => { await this.ready; await this.peer.call("entry", "start", [this.peer.expose(this.peerObject()), directory]); })(), deadline]); }
    finally { clearTimeout(timer); }
  }
  private peerObject() {
    // Decoded back-references resolve to the original kernel in this peer.
    return this.peer.decode({ kind: "reference", side: "host", id: "kernel" });
  }
  close(immediate = false): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      clearInterval(this.watchdog);
      if (!this.dead && !immediate) {
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([this.peer.call("entry", "stop"), new Promise<void>((r) => { timer = setTimeout(r, this.options.stopTimeoutMs); })]); }
        catch {} finally { clearTimeout(timer); }
      }
      this.peer.close(Error("插件已停用；未完成的外部动作结果需核对"));
      if (!this.dead) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error(`无法终止插件 ${this.id} 的进程`)), 3000);
          this.child.once("exit", () => { clearTimeout(timer); resolve(); });
          this.child.kill("SIGKILL");
        });
      }
    })();
    void this.closing.catch((error) => this.onFault(error));
    return this.closing;
  }
}
