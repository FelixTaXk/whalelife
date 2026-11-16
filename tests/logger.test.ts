import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { mkdir, writeFile, readdir, stat, utimes, readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Logger } from "../core/logger.ts";
import { installLogOutputGuards } from "../core/log-output.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const loggerUrl = new URL("../core/logger.ts", import.meta.url).href;
const outputUrl = new URL("../core/log-output.ts", import.meta.url).href;
const today = () => `whalelife-${new Date().toLocaleDateString("en-CA")}.log`;
const ownFiles = async (dir: string) => (await readdir(dir)).filter((file) => /^whalelife-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(file));

function childFixture(t: TestContext, script: string, ipc = false) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return { child, exited };
}

test("logger keeps levels, redaction, append, ring and persisted-before-line event ordering", async () => {
  const dir = await temporaryDirectory("whale-logger-");
  const logger = new Logger(dir, { max_web_lines: 2 }, ["private-secret"]);
  const observed: string[] = [];
  logger.on("line", (line) => {
    assert.ok(readFileSync(join(dir, today()), "utf8").includes(line));
    observed.push(line);
  });
  logger.debug("filtered");
  logger.info("first private-secret", { error: new Error("private-secret"), count: 12n });
  logger.warn("second");
  logger.error("third");
  assert.equal(observed.length, 3);
  assert.equal(logger.lines.length, 2);
  assert.match(logger.lines[0], /second/);
  new Logger(dir).info("after restart");
  const content = await readFile(join(dir, today()), "utf8");
  assert.match(content, /first \[REDACTED\]/);
  assert.match(content, /"count":"12n"/);
  assert.match(content, /after restart/);
  assert.ok(!content.includes("private-secret"));
  assert.ok(!content.includes("filtered"));
  assert.equal(logger.fileStatus.state, "ready");
});

test("bad JSON and sync/async line subscribers cannot break logging or later subscribers", async () => {
  const dir = await temporaryDirectory("whale-logger-");
  const logger = new Logger(dir);
  const circular: any = {};
  circular.self = circular;
  let observed = 0, once = 0;
  logger.on("line", () => { throw Error("bad subscriber"); });
  logger.on("line", async () => { throw Error("async subscriber"); });
  logger.once("line", () => { once++; });
  logger.on("line", () => { observed++; });
  assert.doesNotThrow(() => logger.info("circular", circular));
  assert.doesNotThrow(() => logger.info("toJSON", { toJSON() { throw Error("bad JSON"); } }));
  logger.info("after failures");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed, 3);
  assert.equal(once, 1);
  assert.equal(logger.lines.filter((line) => line.includes("日志订阅回调失败")).length, 1);
  const content = await readFile(join(dir, today()), "utf8");
  assert.match(content, /circular \[Unserializable log data\]/);
  assert.match(content, /toJSON \[Unserializable log data\]/);
  assert.match(content, /after failures/);
});

test("recursive line subscriber does not create an output loop", async () => {
  const logger = new Logger(await temporaryDirectory("whale-logger-"));
  let observed = 0;
  logger.on("line", () => { observed++; logger.info("subscriber diagnostic"); });
  logger.info("business");
  assert.equal(observed, 1);
  assert.equal(logger.lines.length, 2);
});

test("rotation bounds each file and total bytes while preserving newest lines", async () => {
  const dir = await temporaryDirectory("whale-logger-");
  const logger = new Logger(dir, { max_file_bytes: 256, max_total_bytes: 600 });
  for (let i = 0; i < 12; i++) logger.info(`row-${i} ${"x".repeat(120)}`);
  const names = await ownFiles(dir);
  const sizes = await Promise.all(names.map(async (name) => (await stat(join(dir, name))).size));
  assert.ok(names.some((name) => /\.\d+\.log$/.test(name)));
  assert.ok(sizes.every((size) => size <= 256));
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= 600);
  assert.match(await readFile(join(dir, today()), "utf8"), /row-11 /);
  const all = (await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))).join("");
  assert.ok(!all.includes("row-0 "));
});

test("startup clears legacy oversized own logs without touching other data", async () => {
  const dir = await temporaryDirectory("whale-logger-");
  await writeFile(join(dir, today()), "x".repeat(4096));
  await writeFile(join(dir, "whalelife-2026-11-01.2.log"), "x".repeat(2048));
  await writeFile(join(dir, "diagnostics.log"), "keep".repeat(1024));
  await mkdir(join(dir, "executions"));
  await writeFile(join(dir, "executions", today()), "execution data");
  const logger = new Logger(dir, { max_file_bytes: 256, max_total_bytes: 600 });
  assert.deepEqual(await ownFiles(dir), []);
  logger.info("recovered startup");
  assert.equal(await readFile(join(dir, "executions", today()), "utf8"), "execution data");
  assert.equal((await stat(join(dir, "diagnostics.log"))).size, 4096);
  assert.match(await readFile(join(dir, today()), "utf8"), /recovered startup/);
});

test("retention runs after startup and only deletes exact owned regular log names", async () => {
  const dir = await temporaryDirectory("whale-logger-");
  const logger = new Logger(dir);
  const old = new Date(Date.now() - 15 * 86400000);
  const removable = ["whalelife-2026-01-01.log", "whalelife-2026-01-01.3.log"];
  const preserved = ["whalelife-2026-01-01.log.bak", "whalelife-2026-99-99.log", "whalelife-2026-02-30.log", "other.log"];
  for (const name of [...removable, ...preserved]) {
    await writeFile(join(dir, name), "evidence");
    await utimes(join(dir, name), old, old);
  }
  await mkdir(join(dir, "whalelife-2026-01-01.9.log"));
  await writeFile(join(dir, "whalelife-2026-01-01.9.log", "keep.txt"), "nested");
  logger.info("runtime retention");
  const remaining = await readdir(dir);
  for (const name of removable) assert.ok(!remaining.includes(name));
  for (const name of preserved) assert.equal(await readFile(join(dir, name), "utf8"), "evidence");
  assert.equal(await readFile(join(dir, "whalelife-2026-01-01.9.log", "keep.txt"), "utf8"), "nested");
});

test("UTF-8 lines are redacted then truncated with a marker inside the byte quota", async () => {
  const dir = await temporaryDirectory("whale-logger-");
  const logger = new Logger(dir, { max_file_bytes: 160, max_total_bytes: 160 }, ["secret-value"]);
  logger.info("secret-value " + "鲸".repeat(1000));
  const content = await readFile(join(dir, today()), "utf8");
  assert.ok(Buffer.byteLength(content) <= 160);
  assert.match(content, /\[REDACTED\]/);
  assert.match(content, / \[TRUNCATED\]\n$/);
  assert.ok(!content.includes("\uFFFD"));
  assert.equal(logger.lines[0] + "\n", content);
});

test("invalid ring and byte options retain bounded defaults", async () => {
  const dir = await temporaryDirectory("whale-logger-");
  for (const invalid of [NaN, Infinity, -1]) {
    const logger = new Logger(dir, { max_web_lines: invalid, max_file_bytes: invalid, max_total_bytes: invalid });
    logger.lines.push(...Array(1001).fill("old"));
    logger.info("bounded");
    assert.equal(logger.lines.length, 1000);
    assert.equal(logger.fileStatus.state, "ready");
  }
  const zero = new Logger(dir, { max_web_lines: 0 });
  zero.info("no web history");
  assert.equal(zero.lines.length, 0);
});

test("ENOSPC has bounded backoff, visible degradation, independent memory and no replay", async (t) => {
  const dir = await temporaryDirectory("whale-logger-");
  let now = Date.now(), attempts = 0;
  t.mock.method(Date, "now", () => now);
  const original = fs.appendFileSync;
  t.after(() => { fs.appendFileSync = original; syncBuiltinESMExports(); });
  fs.appendFileSync = (() => {
    attempts++;
    throw Object.assign(new Error("secret filesystem detail"), { code: "ENOSPC" });
  }) as typeof fs.appendFileSync;
  syncBuiltinESMExports();
  const logger = new Logger(dir);
  let events = 0;
  logger.on("line", () => { events++; });
  logger.info("initial failure");
  for (let i = 0; i < 4; i++) {
    logger.info("cooldown line");
    assert.equal(attempts, i + 1);
    now = logger.fileStatus.retryAt;
    logger.info("retry line");
  }
  for (let i = 0; i < 5; i++) logger.info("after disabled");
  assert.equal(attempts, 5);
  assert.equal(events, 14);
  assert.equal(logger.fileStatus.state, "disabled");
  assert.equal(logger.fileStatus.dropped, 14);
  assert.equal(logger.lines.filter((line) => /文件日志.*（ENOSPC）/.test(line)).length, 2);
  assert.ok(!logger.lines.join("\n").includes("secret filesystem detail"));
  fs.appendFileSync = original;
  syncBuiltinESMExports();
  now += 3600000;
  logger.info("still disabled without restart");
  assert.deepEqual(await ownFiles(dir), []);
});

test("file logging recovers after backoff and reports missing lines without replaying them", async (t) => {
  const dir = await temporaryDirectory("whale-logger-");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const original = fs.appendFileSync;
  t.after(() => { fs.appendFileSync = original; syncBuiltinESMExports(); });
  fs.appendFileSync = (() => { throw Object.assign(Error("disk full"), { code: "ENOSPC" }); }) as typeof fs.appendFileSync;
  syncBuiltinESMExports();
  const logger = new Logger(dir);
  logger.info("unpersisted one");
  logger.info("unpersisted two");
  fs.appendFileSync = original;
  syncBuiltinESMExports();
  now = logger.fileStatus.retryAt;
  logger.info("persisted recovery");
  assert.equal(logger.fileStatus.state, "ready");
  assert.match(logger.lines.join("\n"), /此前 2 条日志未确认写入磁盘/);
  const content = await readFile(join(dir, today()), "utf8");
  assert.match(content, /persisted recovery/);
  assert.ok(!content.includes("unpersisted"));
});

test("unusable constructor directory degrades without throwing", async () => {
  const dir = await temporaryDirectory("whale-logger-");
  const file = join(dir, "not-a-directory");
  await writeFile(file, "original");
  let logger!: Logger;
  assert.doesNotThrow(() => { logger = new Logger(file); logger.error("business still runs"); });
  assert.equal(logger.fileStatus.state, "retrying");
  assert.match(logger.lines.at(-1)!, /business still runs/);
  assert.equal(await readFile(file, "utf8"), "original");
});

test("many Logger instances share a single set of process output guards", async () => {
  installLogOutputGuards();
  const before = [process.stdout, process.stderr].map((stream) => ["error", "close", "drain"].map((name) => stream.listenerCount(name)));
  const dir = await temporaryDirectory("whale-logger-");
  for (let i = 0; i < 40; i++) new Logger(dir);
  const after = [process.stdout, process.stderr].map((stream) => ["error", "close", "drain"].map((name) => stream.listenerCount(name)));
  assert.deepEqual(after, before);
});

test("real child stdout disconnect is contained and file logging/business continue", { timeout: 15000 }, async (t) => {
  const dir = await temporaryDirectory("whale-logger-");
  const script = `
    import { Logger } from ${JSON.stringify(loggerUrl)};
    import { writeFileSync } from 'node:fs';
    const logger = new Logger(${JSON.stringify(dir)});
    let errors = 0;
    process.stdout.on('error', () => { errors++; });
    process.send('ready');
    process.once('message', async () => {
      for (let i = 0; i < 20 && !errors; i++) {
        logger.info('probe disconnected pipe');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      for (let i = 0; i < 30; i++) logger.info('business-after-disconnect-' + i);
      writeFileSync(${JSON.stringify(join(dir, "business.json"))}, JSON.stringify({ errors, status: logger.fileStatus.state }));
      process.disconnect();
    });
  `;
  const { child, exited } = childFixture(t, script, true);
  child.once("message", () => {
    child.stdout!.destroy();
    child.send("disconnect");
  });
  const result = await exited;
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(await readFile(join(dir, "business.json"), "utf8"));
  assert.ok(state.errors >= 1, "the real OS pipe must produce a stream error");
  assert.equal(state.status, "ready");
  const content = await readFile(join(dir, today()), "utf8");
  assert.match(content, /business-after-disconnect-29/);
  assert.ok(Buffer.byteLength(content) < 10000);
});

test("output guards do not swallow genuine uncaught errors even when code is EPIPE", { timeout: 15000 }, async (t) => {
  const { child, exited } = childFixture(t, `
    import { installLogOutputGuards } from ${JSON.stringify(outputUrl)};
    installLogOutputGuards();
    setImmediate(() => { throw Object.assign(Error('actual application failure'), { code: 'EPIPE' }); });
  `);
  child.stdout!.resume();
  const result = await exited;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /actual application failure/);
});
