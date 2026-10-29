import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Logger } from "../core/logger.ts";
import { Memory } from "../core/memory.ts";
import { Runtime } from "../core/runtime.ts";
import { Tools } from "../core/tools.ts";
import { decision } from "../core/permission.ts";
test("JSONL truncation recovery preserves complete records and next append", async () => {
  const root = await mkdtemp(join(tmpdir(), "whale-memory-"));
  const logger = new Logger(join(root, "logs"));
  const mem = new Memory(join(root, "memory"), logger);
  await mem.init();
  await mem.appendEvent({
    session: "test",
    type: "message",
    role: "user",
    text: "one",
  });
  await writeFile(
    (await mem.episodePaths("test"))[0],
    '{"ts":1,"text":"good"}\n{"broken":',
    "utf8",
  );
  assert.equal((await mem.readSession("test")).length, 1);
  await mem.appendEvent({ session: "test", type: "message", text: "two" });
  assert.equal((await mem.readSession("test")).length, 2);
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      mem.appendEvent({ session: "test", text: String(i) }),
    ),
  );
  assert.equal((await mem.readSession("test")).length, 12);
  assert.ok(
    JSON.parse(await readFile(join(root, "memory/index.json"), "utf8")).sessions
      .test,
  );
  await assert.rejects(() => mem.readSession("../secret"));
});
test("permissions deny off, allow safe, require approval, respect override", () => {
  assert.equal(decision("off", "safe", "full"), "deny");
  assert.equal(decision("ask", "safe"), "allow");
  assert.equal(decision("ask", "ask"), "ask");
  assert.equal(decision("full", "full"), "allow");
  assert.equal(decision("full", "ask", "ask"), "ask");
});
test("cordis nested cleanup, independent child, reload, bad plugin isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "whale-runtime-"));
  await mkdir(join(root, "plugins"));
  await cp(resolve("examples/plugins/hello"), join(root, "plugins/hello"), {
    recursive: true,
    filter: (source) => basename(source) !== "data",
  });
  const logger = new Logger(join(root, "logs"));
  const runtime = new Runtime(root, logger);
  const tools = new Tools(logger);
  await runtime.builtin("tools", tools);
  await runtime.bus.start();
  await runtime.scan();
  assert.equal(runtime.records.get("hello/extra").status, "active");
  assert.ok(runtime.services.get("hello"));
  assert.ok(!runtime.services.has("hello-extra"));
  assert.equal(tools.list().length, 1);
  await runtime.stop("hello/extra");
  assert.equal(runtime.records.get("hello").status, "active");
  await runtime.action("hello/extra", "start");
  assert.equal(runtime.records.get("hello/extra").status, "active");
  await runtime.stop("hello");
  assert.equal(runtime.records.get("hello/extra").status, "blocked");
  assert.ok(!runtime.services.has("hello"));
  assert.equal(tools.list().length, 0);
  await runtime.action("hello", "reload");
  assert.equal(runtime.records.get("hello/extra").status, "active");
  await mkdir(join(root, "plugins/broken"));
  await writeFile(
    join(root, "plugins/broken/plugin.yaml"),
    "id: broken\nname: broken\ndescription: bad\nversion: 0.1.0\n",
  );
  await writeFile(
    join(root, "plugins/broken/index.ts"),
    'export function apply(ctx) { ctx.provide("leak", 1); throw Error("deliberate failure") }',
  );
  await runtime.loadPath("broken");
  assert.equal(runtime.records.get("broken").status, "failed");
  assert.ok(!runtime.services.has("leak"));
  assert.equal(runtime.records.get("hello").status, "active");
  await assert.rejects(() => runtime.stop("tools"));
  await runtime.bus.stop();
});
test("logger appends across restart, redacts secrets and bounds web ring", async () => {
  const root = await mkdtemp(join(tmpdir(), "whale-log-"));
  const one = new Logger(root, { max_web_lines: 2 }, ["secret"]);
  one.info("first secret");
  one.info("second");
  one.info("third");
  assert.equal(one.lines.length, 2);
  new Logger(root).info("restart");
  const content = await readFile(
    join(root, "whalelife-" + new Date().toLocaleDateString("en-CA") + ".log"),
    "utf8",
  );
  assert.match(content, /first \[REDACTED\]/);
  assert.match(content, /restart/);
  assert.ok(!content.includes("secret"));
});
