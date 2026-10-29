import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PluginRPC } from "../core/plugin-rpc.ts";
import { Runtime } from "../core/runtime.ts";
import { Tools } from "../core/tools.ts";

function pair(t: TestContext) {
  let host!: PluginRPC, plugin!: PluginRPC;
  const faults: Error[] = [];
  const options = { timeout: 3000, onFault: (error: Error) => { faults.push(error); } };
  host = new PluginRPC({ ...options, side: "host", transport: { send: (packet) => queueMicrotask(() => plugin.receive(packet)) } });
  plugin = new PluginRPC({ ...options, side: "plugin", transport: { send: (packet) => queueMicrotask(() => host.receive(packet)) } });
  t.after(() => { host.close(); plugin.close(); });
  return { host, plugin, faults };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("completed RPC promises release exports and can be encoded again", async (t) => {
  const { host, plugin, faults } = pair(t);
  const cached = Promise.resolve(7);
  plugin.bind("service", { async echo(value: number) { return value; }, cached() { return cached; } });
  for (let index = 0; index < 1000; index++) assert.equal(await host.call("service", "echo", [index]), index);
  for (let index = 0; index < 5; index++) assert.equal(await host.call("service", "cached"), 7);
  await tick();
  for (const peer of [host, plugin] as any[]) {
    assert.equal(peer.pending.size, 0); assert.equal(peer.promises.size, 0); assert.equal(peer.remotes.size, 0);
  }
  assert.equal((plugin as any).objects.size, 1, "only the explicitly bound service remains");
  assert.deepEqual(faults, []);
});

test("published object methods retain their receiver and updates reach held snapshots", async (t) => {
  const { host, plugin } = pair(t);
  const counter = { value: 0, increment() { return ++this.value; } };
  plugin.publish(counter); plugin.bind("service", { get() { return counter; } });
  const remote = await host.call("service", "get");
  assert.equal(await remote.increment(), 1); assert.equal(remote.value, 1);
  assert.equal(await remote.increment(), 2); assert.equal(remote.value, 2);
});

test("stale GC release packets cannot remove references renewed by later wire values", (t) => {
  const { host } = pair(t), callback = () => 1;
  const first = host.encode(callback), second = host.encode(callback);
  host.receive({ type: "release", id: first.id, generation: first.generation });
  assert.equal(host.decode(second), callback);
  host.receive({ type: "release", id: second.id, generation: second.generation });
  assert.throws(() => host.decode(second), /Expired/);
});

test("ignored callback promises and transport send failures stay handled and release pending calls", async (t) => {
  const { host, plugin } = pair(t);
  plugin.bind("service", { fail() { throw Error("expected callback failure"); } });
  void host.call("service", "fail");
  await tick(); await tick();
  const disconnected = new PluginRPC({ side: "host", timeout: 1000, onFault() {}, transport: { send() { throw Error("disconnected"); } } });
  t.after(() => disconnected.close());
  await assert.rejects(disconnected.call("service", "anything"), /disconnected/);
  assert.equal((disconnected as any).pending.size, 0);
});

test("peer shutdown rejects in-flight work and clears signal listeners immediately", async (t) => {
  const { host, plugin } = pair(t);
  plugin.bind("service", { wait() { return new Promise(() => {}); } });
  const controller = new AbortController(), remote = plugin.decode(host.encode(controller.signal));
  const waiting = host.call("service", "wait");
  await tick(); host.close(Error("stopped")); plugin.close(Error("stopped"));
  await assert.rejects(waiting, /stopped/);
  assert.equal(remote.aborted, true);
  for (const peer of [host, plugin] as any[]) {
    assert.equal(peer.pending.size, 0); assert.equal(peer.objects.size, 0);
    assert.equal(peer.signalCleanup.size, 0); assert.equal(peer.signals.size, 0);
  }
});

test("GC releases completed call callbacks/signals while registered callbacks and context signals stay live", { timeout: 15000 }, async () => {
  const script = `
    import assert from "node:assert/strict";
    import { PluginRPC } from ${JSON.stringify(new URL("../core/plugin-rpc.ts", import.meta.url).href)};
    let host, plugin, stored; let calls = 0;
    const options = { timeout: 5000, onFault(error) { throw error; } };
    host = new PluginRPC({ ...options, side: "host", transport: { send(packet) { queueMicrotask(() => plugin.receive(packet)); } } });
    plugin = new PluginRPC({ ...options, side: "plugin", transport: { send(packet) { queueMicrotask(() => host.receive(packet)); } } });
    const controller = new AbortController();
    host.bind("service", {
      async use(signal, callback) { assert.equal(signal.aborted, false); return await callback(); },
      register(callback) { stored = callback; },
      signal() { return controller.signal; }
    });
    await plugin.call("service", "register", [() => ++calls]);
    let contextSignal = await plugin.call("service", "signal");
    for (let index = 0; index < 1000; index++)
      assert.equal(await plugin.call("service", "use", [new AbortController().signal, () => 5]), 5);
    const collect = async () => { for (let index = 0; index < 15; index++) {
      await new Promise(setImmediate); global.gc(); await new Promise(setImmediate);
    } };
    await collect();
    assert.equal(plugin.objects.size, 1, "only registered callback is retained");
    assert.equal(host.objects.size, 2, "only service and context signal are retained");
    assert.equal(plugin.signalCleanup.size, 0); assert.equal(host.signals.size, 0);
    assert.equal(await stored(), 1, "registered callback survives GC");
    controller.abort(Error("context stopped")); await new Promise(setImmediate);
    assert.equal(contextSignal.aborted, true);
    stored = undefined; contextSignal = undefined;
    await collect();
    assert.equal(plugin.objects.size, 0); assert.equal(host.objects.size, 1);
    assert.equal(host.signalCleanup.size, 0); assert.equal(plugin.signals.size, 0);
    host.close(); plugin.close();
    console.log("RPC lifecycle verified");
  `;
  const result = await promisify(execFile)(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { timeout: 12000, windowsHide: true });
  assert.match(result.stdout, /RPC lifecycle verified/);
});

test("isolated plugins share class services with synchronous methods, current fields and nested writes", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whale-rpc-contract-"));
  const logger: any = { secrets: [], log() {}, debug() {}, info() {}, warn() {}, error() {} };
  const runtime = new Runtime(root, logger), tools = new Tools(logger);
  t.after(async () => {
    await runtime.bus.stop(); assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const writePlugin = async (id: string, source: string) => {
    const dir = join(root, "plugins", id); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), JSON.stringify({ id, name: id, description: "RPC fixture", version: "1.0.0" }));
    await writeFile(join(dir, "index.ts"), source);
  };
  await writePlugin("a-provider", `
    class Counter {
      #private = 7; count = 0; _public = "retained"; nested = { value: 1 };
      increment() { return ++this.count; }
      inspect() { return { count: this.count, nested: this.nested.value, privateResult: this.#private }; }
      async later() { return this.increment(); }
      get doubled() { return this.count * 2; }
    }
    export function apply(ctx) { ctx.provide("counter", new Counter()); }
  `);
  await writePlugin("b-consumer", `
    export function apply(ctx) {
      const service = ctx.get("counter");
      ctx.tools.register({ name: "rpc_check", description: "test", schema: {}, danger: "safe", async run() {
        const first = service.increment();
        if (first instanceof Promise) throw Error("sync method became async");
        service.count = 8; service.nested.value = 11;
        const seen = service.inspect(), doubled = service.doubled;
        const later = await service.later();
        return { first, seen, doubled, later, current: service.count,
          publicField: service._public, privateVisible: Object.keys(service).some(key => key.includes("private")) };
      } });
    }
  `);
  await runtime.builtin("tools", tools); await runtime.bus.start(); await runtime.scan();
  assert.equal(runtime.records.get("a-provider")?.status, "active");
  assert.equal(runtime.records.get("b-consumer")?.status, "active");
  const result = await tools.call("rpc_check", {}, { permission: "full" });
  assert.equal(result.ok, true, String(result.result));
  assert.deepEqual(result.result, { first: 1, seen: { count: 8, nested: 11, privateResult: 7 },
    doubled: 16, later: 9, current: 9, publicField: "retained", privateVisible: false });
});
