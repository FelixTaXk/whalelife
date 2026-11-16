import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

interface ChildResult { code: number | null; signal: string | null; stderr: string; timedOut: boolean }
async function childScenario(t: TestContext, body: string) {
  const root = await temporaryDirectory("whale-process-lifecycle-");
  let child: ChildProcess | undefined, completed: Promise<ChildResult> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await completed?.catch(() => {});
  });
  const eventsFile = join(root, "events.jsonl");
  const script = join(root, "scenario.mjs");
  await writeFile(script, `
    import { appendFileSync } from "node:fs";
    import { installProcessLifecycle, runMain } from ${JSON.stringify(new URL("../core/process-lifecycle.ts", import.meta.url).href)};
    const mark = (name, data = {}) => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ name, ...data, at: Date.now() }) + "\\n");
    const logger = { error(message, extra) { mark("log", { message, error: extra?.error?.message }); } };
    process.on("exit", code => mark("exit", { code }));
    ${body}
  `);
  child = spawn(process.execPath, [script], { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const running = child;
  completed = new Promise<ChildResult>((resolve, reject) => {
    let stderr = "", timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; running.kill(); }, 8_000);
    running.stderr!.setEncoding("utf8").on("data", value => { stderr += value; });
    running.once("error", error => { clearTimeout(deadline); reject(error); });
    running.once("close", (code, signal) => { clearTimeout(deadline); resolve({ code, signal, stderr, timedOut }); });
  });
  const result = await completed;
  assert.equal(result.timedOut, false, "child must exit without the test watchdog");
  assert.equal(result.signal, null);
  const events: Array<{ name: string; at: number; message?: string; code?: number }> =
    (await readFile(eventsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { ...result, events, named: (name: string) => events.filter(event => event.name === name) };
}

test("a real uncaught exception records once, finishes cleanup and exits nonzero", async t => {
  const result = await childScenario(t, `
    installProcessLifecycle({ logger, async close() { mark("close"); await new Promise(r => setTimeout(r, 20)); mark("closed"); } });
    setImmediate(() => { throw Error("synthetic real exception"); });
  `);
  assert.equal(result.code, 1);
  assert.equal(result.named("close").length, 1);
  assert.equal(result.named("closed").length, 1);
  assert.deepEqual(result.named("log").map(event => event.message), ["未捕获异常"]);
});

test("unrelated EPIPE exceptions are still fatal", async t => {
  const result = await childScenario(t, `
    installProcessLifecycle({ logger, close() { mark("close"); } });
    setImmediate(() => { throw Object.assign(Error("application EPIPE"), { code: "EPIPE" }); });
  `);
  assert.equal(result.code, 1);
  assert.equal(result.named("close").length, 1);
  assert.equal(result.named("log").length, 1);
});

test("repeated exceptions and signals cannot restart a hung shutdown or its deadline", async t => {
  const result = await childScenario(t, `
    installProcessLifecycle({ logger, close() { mark("close"); return new Promise(() => {}); } }, { shutdownTimeoutMs: 120 });
    setInterval(() => { process.emit("SIGINT"); process.emit("SIGTERM"); }, 10);
    setInterval(() => { throw Error("repeated real exception"); }, 10);
    setImmediate(() => { throw Error("first real exception"); });
  `);
  assert.equal(result.code, 1);
  assert.equal(result.named("close").length, 1);
  assert.equal(result.named("log").length, 1);
  assert.match(result.stderr, /关闭超时/);
  assert.ok(result.named("exit")[0].at - result.named("close")[0].at < 2_000);
});

test("a logger throwing and synchronously reentering the fatal handler cannot recurse", async t => {
  const result = await childScenario(t, `
    installProcessLifecycle({
      logger: { error() { mark("log"); process.emit("uncaughtException", Error("nested logger error")); throw Error("logger failed"); } },
      close() { mark("close"); }
    });
    setImmediate(() => { throw Error("real exception"); });
  `);
  assert.equal(result.code, 1);
  assert.equal(result.named("close").length, 1);
  assert.equal(result.named("log").length, 1);
  assert.match(result.stderr, /日志记录失败/);
});

test("normal repeated SIGINT and SIGTERM finish one cleanup and exit successfully", async t => {
  const result = await childScenario(t, `
    installProcessLifecycle({ logger, async close() { mark("close"); await new Promise(r => setTimeout(r, 25)); mark("closed"); } });
    process.emit("SIGINT"); process.emit("SIGTERM"); process.emit("SIGINT");
  `);
  assert.equal(result.code, 0);
  assert.equal(result.named("close").length, 1);
  assert.equal(result.named("closed").length, 1);
  assert.equal(result.named("log").length, 0);
});

test("a real exception during signal shutdown upgrades the eventual exit status", async t => {
  const result = await childScenario(t, `
    installProcessLifecycle({ logger, async close() { mark("close"); await new Promise(r => setTimeout(r, 40)); } });
    process.emit("SIGTERM");
    setTimeout(() => { throw Error("exception during close"); }, 5);
  `);
  assert.equal(result.code, 1);
  assert.equal(result.named("close").length, 1);
  assert.equal(result.named("log").length, 1);
});

for (const [name, failure] of [
  ["synchronous throw", 'throw Error("synchronous close failure");'],
  ["rejected promise", 'return Promise.reject(Error("rejected close failure"));'],
] as const) {
  test(`shutdown ${name} is handled and exits nonzero without an unhandled rejection`, async t => {
    const result = await childScenario(t, `
      process.on("unhandledRejection", () => mark("unhandled"));
      installProcessLifecycle({ logger, close() { mark("close"); ${failure} } });
      process.emit("SIGINT");
    `);
    assert.equal(result.code, 1);
    assert.equal(result.named("close").length, 1);
    assert.equal(result.named("unhandled").length, 0);
    assert.match(result.stderr, /关闭失败/);
  });
}

test("a hung normal shutdown also has a total deadline and exits nonzero", async t => {
  const result = await childScenario(t, `
    installProcessLifecycle({ logger, close() { mark("close"); return new Promise(() => {}); } }, { shutdownTimeoutMs: 80 });
    process.emit("SIGTERM");
  `);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /关闭超时/);
});

test("unhandled rejections retain log-only behavior even when the logger throws", async t => {
  const result = await childScenario(t, `
    process.on("uncaughtExceptionMonitor", () => mark("uncaught"));
    installProcessLifecycle({ logger: { error(message) { mark("log", { message }); throw Error("logger failure"); } }, close() { mark("close"); } });
    Promise.reject(Error("synthetic rejection"));
    setTimeout(() => process.emit("SIGINT"), 30);
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.named("log").map(event => event.message), ["未处理 Promise 拒绝"]);
  assert.equal(result.named("uncaught").length, 0);
});

test("startup failure reports through guarded stderr and returns a nonzero status", async t => {
  const result = await childScenario(t, `
    await runMain(async () => { throw Error("synthetic startup failure"); });
  `);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "WhaleLife 启动失败：synthetic startup failure\n");
});

test("startup failure cannot leave partially initialized active handles running forever", async t => {
  const result = await childScenario(t, `
    await runMain(async () => {
      mark("startup");
      setInterval(() => {}, 1_000);
      throw Error("startup failed after opening resources");
    }, { shutdownTimeoutMs: 80 });
  `);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /启动失败/);
  assert.ok(result.named("exit")[0].at - result.named("startup")[0].at < 2_000);
});

for (const [name, write] of [
  ["synchronous", 'throw Object.assign(Error("broken stderr"), { code: "EPIPE" });'],
  ["asynchronous", 'queueMicrotask(() => process.stderr.emit("error", Object.assign(Error("broken stderr"), { code: "EPIPE" }))); return true;'],
] as const) {
  test(`startup failure survives ${name} stderr failure without recursive exceptions`, async t => {
    const result = await childScenario(t, `
      process.on("uncaughtExceptionMonitor", () => mark("uncaught"));
      process.stderr.write = () => { ${write} };
      await runMain(async () => { throw Error("synthetic startup failure"); });
    `);
    assert.equal(result.code, 1);
    assert.equal(result.named("uncaught").length, 0);
  });
}

test("boot close publishes its shared promise before synchronous logger callbacks", async t => {
  const root = await temporaryDirectory("whale-close-reentry-");
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  t.after(async () => { await app?.close(); });
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "info" }, web: { port: 0 }, providers: [], models: [],
    personas: { a: { name: "A", file: "a.md", permission: "off" } },
    channels: { web: { persona: "a", permission: "off" } }, memory: { root: "memory" },
  }));
  app = await boot(root);
  let nested: Promise<void> | undefined, shutdownLines = 0;
  app.logger.on("line", (line: string) => {
    if (!line.includes("WhaleLife 关闭")) return;
    shutdownLines++;
    nested = app!.close();
  });
  const closing = app.close();
  assert.equal(nested, closing);
  assert.equal(app.close(), closing);
  await closing;
  assert.equal(shutdownLines, 1);
});
