import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.ts";

const collect = `async function collect() {
  for (let i = 0; i < 12; i++) { await new Promise(setImmediate); global.gc(); await new Promise(setImmediate); }
}`;
async function child(script: string) {
  const result = await promisify(execFile)(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { timeout: 20000, windowsHide: true });
  assert.match(result.stdout, /verified/);
}

test("RPC-derived signals survive GC while used; completed composites and export listeners are collectable", { timeout: 25000 }, async () => {
  await child(`
    import assert from 'node:assert/strict';
    import { PluginRPC } from ${JSON.stringify(new URL("../core/plugin-rpc.ts", import.meta.url).href)};
    ${collect}
    let host, plugin, held, release;
    const options = { timeout: 10000, onFault(error) { throw error; } };
    host = new PluginRPC({ ...options, side: 'host', transport: { send: p => queueMicrotask(() => plugin.receive(p)) } });
    plugin = new PluginRPC({ ...options, side: 'plugin', transport: { send: p => queueMicrotask(() => host.receive(p)) } });
    try {
      // Both directions matter: plugin tooling also receives composed host signals.
      for (const [sender, receiver] of [[plugin, host], [host, plugin]]) {
        const gate = new Promise(r => release = r);
        receiver.bind('service', {
          async hold(signal) { held = AbortSignal.any([AbortSignal.any([signal])]); await gate; },
          async completed(signal) { return AbortSignal.any([signal]).aborted; },
        });
        let controller = new AbortController();
        const work = sender.call('service', 'hold', [controller.signal]);
        await new Promise(setImmediate);
        await collect();
        controller.abort(Error('after-GC')); await new Promise(setImmediate);
        assert.equal(held.aborted, true); assert.equal(held.reason.message, 'after-GC');
        release(); await work;
        held = undefined; controller = undefined;
        await collect();
        assert.equal(receiver.callInputs.size, 0);
        assert.equal(sender.signalCleanup.size, 0);
        assert.equal(receiver.signals.size, 0);
        // Uncancelled completed operations must not keep every controller forever.
        for (let i = 0; i < 1000; i++) {
          assert.equal(await sender.call('service', 'completed', [new AbortController().signal]), false);
        }
        await collect();
        assert.equal(receiver.callInputs.size, 0);
        assert.equal(sender.signalCleanup.size, 0);
        assert.equal(receiver.signals.size, 0);
      }
    } finally { host.close(); plugin.close(); }
    console.log('GC ownership verified');
  `);
});

test("closing a peer releases retained inputs even when plugin work never settles", async () => {
  const { PluginRPC } = await import('../core/plugin-rpc.ts');
  let host!: InstanceType<typeof PluginRPC>, plugin!: InstanceType<typeof PluginRPC>;
  const options = { timeout: 10000, onFault(error: Error) { throw error; } };
  host = new PluginRPC({ ...options, side: 'host', transport: { send: p => queueMicrotask(() => plugin.receive(p)) } });
  plugin = new PluginRPC({ ...options, side: 'plugin', transport: { send: p => queueMicrotask(() => host.receive(p)) } });
  plugin.bind('service', { hang(_signal: AbortSignal) { return new Promise(() => {}); } });
  try {
    const rejected = assert.rejects(host.call('service', 'hang', [new AbortController().signal]), /stopped/);
    await new Promise(setImmediate);
    assert.equal((plugin as any).callInputs.size, 1);
    host.close(Error('stopped')); plugin.close(Error('stopped'));
    await rejected; assert.equal((plugin as any).callInputs.size, 0);
  } finally { host.close(); plugin.close(); }
});

test("isolated plugin cancellation survives GC in queued, running, raw-model and tool-finish paths", { timeout: 25000 }, async () => {
  const root = await temporaryDirectory("whale-abort-gc-");
  await mkdir(join(root, "plugins/probe"), { recursive: true });
  await mkdir(join(root, "config"));
  await writeFile(join(root, "plugins/probe/plugin.yaml"), 'id: probe\nname: Cancellation probe\ndescription: Isolated GC regression\nversion: 1.0.0\napiVersion: "1"\n');
  await writeFile(join(root, "plugins/probe/index.ts"), `export function apply(ctx) {
    let controller, result;
    ctx.tools.register({ name: 'gc_finish', description: 'Record then cancel', schema: {}, danger: 'safe',
      async run(args, session) {
        await ctx.memory.recordExperience(session.id, { event_id: 'finished', outcome: 'succeeded', text: '已完成检查' });
        controller.abort(Error('finished')); return { completed: true, recorded: true };
      } });
    ctx.provide('probe', {
      start(sessionId, method) {
        controller = new AbortController();
        const input = { sessionId, text: 'transient-GC-marker', signal: controller.signal };
        const work = method === 'raw'
          ? ctx.llm.chat({ model: 'chat', messages: [{ role: 'user', content: 'raw' }], signal: controller.signal })
          : ctx.sessions[method](input);
        result = work.then(() => 'unexpected success', error => error.message);
      },
      cancel() { controller.abort(Error('cancelled-after-GC')); return controller.signal.aborted; },
      result() { return result; },
    });
    ctx.effect(() => () => controller?.abort(Error('disposed')));
  }`);
  await writeFile(join(root, "persona.md"), "测试人格");
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "test", base_url: "https://unused.invalid/v1", api_key: "synthetic" }],
    models: [{ id: "chat", provider: "test", model: "test", type: "chat", context_window: 32000 }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "A", file: "persona.md", permission: "full" } },
    channels: { web: { persona: "a", permission: "full" } }, memory: { root: "memory" },
  }));
  await child(`
    import assert from 'node:assert/strict';
    import { boot } from ${JSON.stringify(new URL("../core/index.ts", import.meta.url).href)};
    ${collect}
    const app = await boot(${JSON.stringify(root)});
    let release;
    try {
      const api = app.runtime.services.get('probe').value;
      const id = await app.sessions.current();
      for (const method of ['run', 'runTransient', 'enqueue', 'enqueueTransient', 'raw']) {
        let entered, modelSignal;
        const started = new Promise(r => entered = r), gate = new Promise(r => release = r);
        app.llm.chat = async input => {
          modelSignal = input.signal; entered(); await gate;
          input.signal.throwIfAborted(); return { text: 'cleanup', toolCalls: [] };
        };
        await api.start(id, method); await started; await collect();
        assert.equal(await api.cancel(), true);
        await new Promise(r => setTimeout(r, 30));
        assert.equal(modelSignal.aborted, true, method + ' lost cancellation');
        release(); assert.equal(await api.result(), 'cancelled-after-GC');
        assert.equal(app.sessions.locks.size, 0);
      }
      // Hold a different request; the queued input must still cancel after GC.
      let entered, count = 0;
      const started = new Promise(r => entered = r), gate = new Promise(r => release = r);
      app.llm.chat = async () => { count++; entered(); await gate; return { text: 'done', toolCalls: [] }; };
      const active = app.channels.web(id, 'real-user', () => {}); await started;
      await api.start(id, 'enqueueTransient'); await collect(); await api.cancel();
      assert.equal(await api.result(), 'cancelled-after-GC'); assert.equal(count, 1);
      release(); await active;
      // A real recorded tool outcome followed by cancel must not start round two.
      const quietId = await app.sessions.create('GC tool test'); count = 0;
      app.llm.chat = async () => {
        count++; await collect();
        return { text: '', toolCalls: [{ id: 'finish', name: 'gc_finish', arguments: '{}' }], usage: { prompt_tokens: 4, completion_tokens: 1 } };
      };
      await api.start(quietId, 'enqueueTransient'); assert.equal(await api.result(), 'finished');
      assert.equal(count, 1); assert.equal(app.sessions.locks.size, 0);
      const rows = await app.memory.readSession(quietId), state = await app.memoryEngine.state(quietId);
      assert.equal(JSON.stringify(rows).includes('transient-GC-marker'), false);
      assert.ok(state.records.some(r => r.text === '已完成检查'));
      assert.equal(state.usage.chat.requests, 1);
    } finally { release?.(); await app.close(); }
    console.log('isolated cancellation verified');
  `);
});
