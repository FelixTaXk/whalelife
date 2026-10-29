import { Worker, MessageChannel } from "node:worker_threads";

// The plugin's worker shares memory only with this disposable relay process, never the host.
const channel = new MessageChannel(), wake = new Int32Array(new SharedArrayBuffer(4));
const send = (packet: any) => { if (process.connected) process.send?.(packet); };
const worker = new Worker(new URL("./plugin-worker.ts", import.meta.url), {
  workerData: { port: channel.port2, wake }, transferList: [channel.port2],
  resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WHALE_PLUGIN_HEAP_MB) || 256 },
});
channel.port1.on("message", (message) => send(message));
process.on("message", (message) => { channel.port1.postMessage(message); Atomics.add(wake, 0, 1); Atomics.notify(wake, 0); });
worker.on("error", (error) => send({ type: "fatal", error: error.message }));
worker.on("exit", (code) => { send({ type: "fatal", error: `插件执行线程退出（${code}）` }); process.exitCode = code; channel.port1.close(); process.disconnect?.(); });
process.on("disconnect", () => { void worker.terminate().finally(() => process.exit()); });
