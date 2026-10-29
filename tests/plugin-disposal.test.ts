import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MemoryEngine } from "../core/memory-engine.ts";

test("an old memory type disposer cannot unregister a replacement", () => {
  const engine = new MemoryEngine({} as any), api = engine.plugin("fixture", () => {});
  const old = api.registerType("entry"); old.dispose();
  const replacement = api.registerType("entry", 2); old.dispose();
  assert.equal(engine.types.get(replacement.kind)?.version, 2);
  replacement.dispose(); assert.equal(engine.types.size, 0);
});

test("100 manual tool/page/event/channel/type removals release callbacks and lifecycle registrations", { timeout: 12000 }, async () => {
  const module = (name: string) => JSON.stringify(new URL(`../core/${name}.ts`, import.meta.url).href);
  const script = `
    import assert from "node:assert/strict";
    import { mkdtemp, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join, dirname, resolve } from "node:path";
    import { Runtime } from ${module("runtime")};
    import { Tools } from ${module("tools")};
    import { Channels } from ${module("channels")};
    import { MemoryEngine } from ${module("memory-engine")};
    import { PluginWebRegistry } from ${module("plugin-web")};
    const root = await mkdtemp(join(tmpdir(), "whale-disposal-"));
    const logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
    const runtime = new Runtime(root, logger), tools = new Tools(logger);
    const routes = new PluginWebRegistry(), engine = new MemoryEngine({});
    const channels = new Channels({}, {}, { personas: { test: { permission: "full" } } });
    try {
      await runtime.builtin("tools", tools);
      await runtime.builtin("memory", { engine });
      await runtime.builtin("channels", channels);
      await runtime.builtin("web", { registerPlugin: routes.register.bind(routes) });
      await runtime.bus.start();
      let ctx;
      await runtime.load("dynamic", { name: "dynamic" }, value => { ctx = value; });
      const memory = ctx.memory, channel = ctx.channels;
      const scope = runtime.records.get("dynamic").cordis.scope;
      const baseline = scope.disposables.length;
      const weak = [];
      function churn() {
        for (let index = 0; index < 100; index++) {
          const callback = () => index;
          weak.push(new WeakRef(callback));
          const tool = ctx.tools.register({ name: "dynamic_tool", description: "fixture", schema: {}, run: callback });
          const page = ctx.web.page("/plugins/dynamic/page", callback);
          const api = ctx.web.api("/plugins/dynamic/api", callback);
          const event = ctx.on("plugin:dynamic:event", callback);
          const handle = channel.register({ id: "dynamic-channel", account: "test", persona: "test", send: callback });
          const type = memory.registerType("entry");
          tool(); page(); api(); event(); handle.dispose(); type.dispose();
          tool(); page(); api(); event(); handle.dispose(); type.dispose();
        }
      }
      churn();
      assert.equal(scope.disposables.length, baseline, "manual removal must remove its Cordis lifecycle wrapper");
      assert.equal(tools.entries.size, 0); assert.equal(engine.types.size, 0);
      assert.equal(channels.registrations.size, 0);
      for (let index = 0; index < 15; index++) {
        await new Promise(setImmediate); global.gc(); await new Promise(setImmediate);
      }
      assert.equal(weak.filter(item => item.deref()).length, 0, "removed callback closures must be collectible");
      console.log("manual disposal verified");
    } finally {
      await runtime.bus.stop();
      assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true });
    }
  `;
  const result = await promisify(execFile)(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { timeout: 10000, windowsHide: true });
  assert.match(result.stdout, /manual disposal verified/);
});
