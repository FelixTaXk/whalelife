import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Diagnostics } from "../core/diagnostics.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

async function fixture(t: TestContext, options: any = {}, registered: string[] = []) {
  const base = await temporaryDirectory("whale-diagnostics-");
  const root = join(base, "application"), directory = join(base, "capture"), warnings: any[] = [];
  const logger = { warn: (...args: any[]) => warnings.push(args) };
  const diagnostic = new Diagnostics(root, { enabled: true, directory, ...options }, logger, () => registered);
  t.after(() => diagnostic.close());
  await diagnostic.initialize();
  return { base, root, directory, diagnostic, warnings, logger };
}
async function rows(directory: string) {
  const names = (await readdir(directory)).filter(name => /\.(?:jsonl|ndjson)$/.test(name)).sort();
  const result: any[] = [];
  for (const name of names) for (const line of (await readFile(join(directory, name), "utf8")).split("\n"))
    if (line.trim()) result.push(JSON.parse(line));
  return result;
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test("diagnostics is disabled by default and touches no configured filesystem paths", async t => {
  const base = await temporaryDirectory("whale-diagnostics-off-");
  const root = join(base, "missing-app"), directory = join(base, "missing-capture");
  for (const options of [{ directory }, { enabled: false, directory }]) {
    const diagnostic = new Diagnostics(root, options, { warn() { throw Error("not expected"); } }, () => { throw Error("must not read credentials"); });
    t.after(() => diagnostic.close());
    await diagnostic.initialize();
    assert.equal(diagnostic.enabled, false);
    const cyclic: any = {}; cyclic.self = cyclic;
    assert.doesNotThrow(() => diagnostic.event("request.start", cyclic));
    await diagnostic.flush(); await diagnostic.close();
    assert.equal(diagnostic.status().last_sequence, 0);
  }
  await assert.rejects(access(root), { code: "ENOENT" });
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("enabled output requires a separate absolute local directory and excludes business roots", async t => {
  const base = await temporaryDirectory("whale-diagnostics-path-");
  const root = join(base, "app"), memory = join(base, "outside-memory");
  for (const directory of [undefined, "capture", root, join(root, "private"), base, memory, join(memory, "child"), "\\\\server\\share\\capture"]) {
    const diagnostic = new Diagnostics(root, { enabled: true, directory, excluded_directories: [memory] }, { warn() {} });
    t.after(() => diagnostic.close());
    await diagnostic.initialize();
    assert.equal(diagnostic.enabled, false, String(directory));
    assert.equal(diagnostic.status().last_error, "initialization_failed");
  }
  assert.deepEqual(await readdir(base), [], "rejected paths must not create directories");
});

test("raw prompt, reasoning, nested usage and synchronous snapshots survive credential redaction", async t => {
  const f = await fixture(t, {}, ["registered-key-123456"]);
  f.diagnostic.registerSecret("dynamic-key-234567");
  const longText = "普通完整原文".repeat(5000), data: any = {
    echo: "same-event-secret-345678 and registered-key-123456 and dynamic-key-234567",
    body: { messages: [{ role: "user", content: longText }], prompt: ["token", "ordinary word"], max_tokens: 123 },
    reasoning: "保留实际观察到的思考正文", response: "完整回答", raw: { choices: [{ delta: { reasoning_content: longText } }] },
    usage: { prompt_tokens: 101, completion_tokens: 19, total_tokens: 120, token: 9,
      prompt_tokens_details: { cached_tokens: 73 }, output_tokens_details: { reasoning_tokens: 11 }, future_vendor_count: 17 },
    headers: [["Authorization", "Bearer same-event-secret-345678"], ["Cookie", "session=cookie-value-456789"]],
    credentials: { nested: "nested-secret-567890" }, nestedEcho: "nested-secret-567890",
    url: "https://user:password-678901@example.invalid/a?query=ordinary&X-Amz-Signature=url-secret-789012",
    invalidURLExample: "示例 https://host:port/path?ordinary=value 仍是完整提示词",
    invalidSignedURL: "https://user:malformed-password-890123@host:port/a?X-Amz-Signature=malformed-signature-901234&q=keep#fragment",
    malformedEcho: "malformed-password-890123 and malformed-signature-901234",
    normalURL: "https://example.invalid", shortText: "1 is a numeral", api_key: "1",
  };
  const usage = structuredClone(data.usage);
  f.diagnostic.event("request.start", data, { session_id: "session-a", request_id: "request-a" });
  data.body.messages[0].content = "MUTATED_AFTER_ENQUEUE"; data.usage.prompt_tokens = 9999;
  await f.diagnostic.flush();
  const [event] = await rows(f.directory), encoded = JSON.stringify(event);
  assert.equal(event.producer_id, "whalelife"); assert.equal(event.schema_version, 1);
  assert.equal(event.session_id, "session-a"); assert.equal(event.request_id, "request-a");
  assert.equal(event.data.body.messages[0].content, longText);
  assert.equal(event.data.raw.choices[0].delta.reasoning_content, longText);
  assert.equal(event.data.reasoning, "保留实际观察到的思考正文");
  assert.deepEqual(event.data.usage, usage);
  assert.deepEqual(event.data.body.prompt, ["token", "ordinary word"]);
  assert.equal(event.data.normalURL, "https://example.invalid");
  assert.equal(event.data.invalidURLExample, data.invalidURLExample);
  assert.equal(event.data.invalidSignedURL, "https://host:port/a?X-Amz-Signature=%5BREDACTED%5D&q=keep#fragment");
  assert.equal(event.data.shortText, "1 is a numeral");
  for (const secret of ["registered-key-123456", "dynamic-key-234567", "same-event-secret-345678", "cookie-value-456789", "nested-secret-567890", "password-678901", "url-secret-789012", "malformed-password-890123", "malformed-signature-901234"])
    assert.ok(!encoded.includes(secret), secret);
  assert.equal(event.data.headers[0][1], "[REDACTED]");
  assert.equal(event.data.api_key, "[REDACTED]");
  assert.equal(data.headers[0][1], "Bearer same-event-secret-345678", "capture must not modify the actual request");
  assert.equal(f.warnings.length, 0);
});

test("media is snapshotted into content addressed attachments before an event references it", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 1, 2, 3, 255]), original = Buffer.from(bytes);
  const hash = createHash("sha256").update(original).digest("hex");
  f.diagnostic.event("request.start", { image: "data:image/png;base64," + bytes.toString("base64"),
    audio: { mime: "audio/wav", bytes }, binary: new Uint8Array(bytes), text: "data:text/plain,hello%20world",
    percentBinary: "data:application/octet-stream,%00%FFa%C3%A9", unicode: "data:text/plain,你好%20世界",
    dense: "data:application/octet-stream," + "%AB".repeat(20000) });
  bytes.fill(17);
  await f.diagnostic.flush();
  const [event] = await rows(f.directory);
  for (const value of [event.data.image, event.data.audio.bytes, event.data.binary]) {
    assert.equal(value.$attachment.sha256, hash);
    assert.equal(value.$attachment.path, "attachments/" + hash);
    assert.deepEqual(await readFile(join(f.directory, value.$attachment.path)), original);
  }
  assert.equal(event.data.image.$attachment.mime, "image/png");
  assert.equal(event.data.audio.bytes.$attachment.mime, "audio/wav");
  assert.equal((await readdir(join(f.directory, "attachments"))).length, 5);
  assert.equal((await readFile(join(f.directory, event.data.text.$attachment.path))).toString(), "hello world");
  assert.deepEqual(await readFile(join(f.directory, event.data.percentBinary.$attachment.path)), Buffer.from([0, 255, 97, 195, 169]));
  assert.equal((await readFile(join(f.directory, event.data.unicode.$attachment.path))).toString(), "你好 世界");
  assert.deepEqual(await readFile(join(f.directory, event.data.dense.$attachment.path)), Buffer.alloc(20000, 0xab));
  if (process.platform !== "win32") {
    assert.equal((await stat(join(f.directory, "attachments", hash))).mode & 0o777, 0o600);
    const name = (await readdir(f.directory)).find(x => x.endsWith(".jsonl"))!;
    assert.equal((await stat(join(f.directory, name))).mode & 0o777, 0o600);
  }
});

test("oversized and unsupported values produce explicit gaps without truncated or fabricated records", async t => {
  const f = await fixture(t, { max_event_bytes: 2000 });
  f.diagnostic.event("request.start", { body: "TOO_LARGE_PRIVATE_TEXT".repeat(300) });
  const cyclic: any = { text: "CYCLIC_PRIVATE_TEXT" }; cyclic.self = cyclic;
  f.diagnostic.event("response.chunk", cyclic);
  f.diagnostic.event("response.chunk", { exotic: new Map([["private", "value"]]) });
  f.diagnostic.event("response.chunk", { get unsafe() { throw Error("getter must not run"); } });
  f.diagnostic.event("request.start", { media: "data:application/octet-stream," + "%AB".repeat(2100) });
  f.diagnostic.event("request.usage", { usage: { prompt_tokens: 3, completion_tokens: 1 } });
  await f.diagnostic.flush();
  const saved = await rows(f.directory), gaps = saved.filter(row => row.kind === "capture.gap");
  assert.equal(saved.filter(row => row.kind !== "capture.gap").length, 1);
  assert.equal(gaps.reduce((count, row) => count + row.data.dropped_events, 0), 5);
  assert.equal(f.diagnostic.status().dropped_events, 5);
  const encoded = JSON.stringify([saved, f.warnings, f.diagnostic.status()]);
  assert.ok(!encoded.includes("TOO_LARGE_PRIVATE_TEXT") && !encoded.includes("CYCLIC_PRIVATE_TEXT"));
  assert.ok(saved.every((row, index) => !index || row.sequence > saved[index - 1].sequence));
  assert.equal(new Set(saved.map(row => row.event_id)).size, saved.length);
});

test("bounded queue rejects overflow immediately, preserves accepted events, and reports missing sequences", async t => {
  const f = await fixture(t, { max_event_bytes: 4096, max_queue_bytes: 4096 });
  for (let i = 0; i < 20; i++) f.diagnostic.event("response.chunk", { index: i, text: "x".repeat(1500) });
  assert.ok(f.diagnostic.status().queued_bytes <= 4096);
  assert.ok(f.diagnostic.status().dropped_events > 0);
  await f.diagnostic.flush();
  const saved = await rows(f.directory), accepted = saved.filter(row => row.kind === "response.chunk"), gaps = saved.filter(row => row.kind === "capture.gap");
  assert.ok(accepted.length > 0 && accepted.length < 20);
  assert.equal(accepted.length + gaps.reduce((count, row) => count + row.data.dropped_events, 0), 20);
  assert.ok(gaps.some(row => row.data.reasons.queue_overflow > 0));
  assert.equal(f.diagnostic.status().queued_bytes, 0);
});

test("async scopes merge nested context and remain isolated across concurrent executions and instances", async t => {
  const f = await fixture(t), other = new Diagnostics(f.root, {}, f.logger);
  await other.initialize(); t.after(() => other.close());
  await Promise.all(["a", "b"].map(async execution => f.diagnostic.run({ execution_id: execution, session_id: "shared" }, async () => {
    await Promise.resolve();
    await f.diagnostic.run({ request_id: "request-" + execution }, async () => {
      await Promise.resolve();
      assert.deepEqual(other.current(), {});
      const copy = f.diagnostic.current(); copy.execution_id = "mutation";
      f.diagnostic.event("request.start", { execution });
    });
    assert.equal(f.diagnostic.current().request_id, undefined);
    f.diagnostic.event("execution.end", { execution });
  })));
  assert.deepEqual(f.diagnostic.current(), {});
  await f.diagnostic.flush();
  for (const row of await rows(f.directory)) {
    assert.equal(row.execution_id, row.data.execution); assert.equal(row.session_id, "shared");
    assert.equal(row.request_id, row.kind === "request.start" ? "request-" + row.execution_id : undefined);
  }
});

test("disk failure stays local and a later writable output records the gap without replaying business", async t => {
  const f = await fixture(t), displaced = join(f.base, "displaced-capture");
  await rename(f.directory, displaced); await writeFile(f.directory, "blocked");
  let actions = 0;
  assert.doesNotThrow(() => { actions++; f.diagnostic.event("request.end", { text: "PRIVATE_FAILED_WRITE" }); });
  await f.diagnostic.flush();
  assert.equal(actions, 1); assert.equal(f.diagnostic.status().gap_pending, true);
  assert.ok(f.diagnostic.status().dropped_events > 0);
  assert.ok(!JSON.stringify(f.warnings).includes("PRIVATE_FAILED_WRITE"));
  await unlink(f.directory); await rename(displaced, f.directory);
  f.diagnostic.event("request.end", { text: "subsequent" });
  await f.diagnostic.flush();
  const saved = await rows(f.directory);
  assert.equal(saved.filter(row => row.kind === "request.end").length, 1);
  assert.ok(saved.some(row => row.kind === "capture.gap" && row.data.reasons.write_failed > 0));
  assert.equal(f.diagnostic.status().gap_pending, false); assert.equal(actions, 1);
});

test("attachment failure never publishes a request with a nonexistent media reference", async t => {
  const f = await fixture(t), attachments = join(f.directory, "attachments"), displaced = join(f.directory, "attachments-held");
  await rename(attachments, displaced); await writeFile(attachments, "blocked");
  f.diagnostic.event("request.start", { image: "data:image/png;base64,AQID" });
  await f.diagnostic.flush();
  assert.equal((await rows(f.directory)).filter(row => row.kind === "request.start").length, 0);
  assert.ok(f.diagnostic.status().gap_pending);
  await unlink(attachments); await rename(displaced, attachments);
  await f.diagnostic.flush();
  assert.ok((await rows(f.directory)).some(row => row.kind === "capture.gap"));
});

test("restarts retain old records and use distinct instance identities without overwriting attachments", async t => {
  const f = await fixture(t);
  const sentinel = '{"older":"PRESERVE_EXACTLY"}\n';
  await writeFile(join(f.directory, "older.jsonl"), sentinel);
  f.diagnostic.event("request.start", { text: "first" }); await f.diagnostic.close();
  const second = new Diagnostics(f.root, { enabled: true, directory: f.directory }, f.logger);
  t.after(() => second.close()); await second.initialize();
  second.event("request.start", { text: "second" }); await second.close();
  assert.equal(await readFile(join(f.directory, "older.jsonl"), "utf8"), sentinel);
  const saved = (await rows(f.directory)).filter(row => row.kind === "request.start");
  assert.equal(saved.length, 2); assert.equal(new Set(saved.map(row => row.instance_id)).size, 2);
  assert.deepEqual(saved.map(row => row.sequence), [1, 1]);
});

test("links in an output path are rejected rather than followed into another directory", async t => {
  const base = await temporaryDirectory("whale-diagnostics-link-");
  const target = join(base, "target"), link = join(base, "linked");
  await mkdir(target);
  try { await symlink(target, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error: any) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("symlinks unavailable"); return; } throw error; }
  const diagnostic = new Diagnostics(join(base, "app"), { enabled: true, directory: resolve(link, "capture") }, { warn() {} });
  t.after(() => diagnostic.close()); await diagnostic.initialize();
  assert.equal(diagnostic.enabled, false); assert.deepEqual(await readdir(target), []);
});

test("close returns after its deadline even when a diagnostic write is delayed", async t => {
  const f = await fixture(t, { flush_timeout_ms: 20 });
  const gate = deferred(), entered = deferred();
  const actualWrite = (f.diagnostic as any).writeJob.bind(f.diagnostic);
  (f.diagnostic as any).writeJob = async (job: any) => { entered.resolve(); await gate.promise; return actualWrite(job); };
  f.diagnostic.event("request.start", { text: "in flight" });
  f.diagnostic.event("request.end", { text: "queued" });
  await entered.promise;
  const started = Date.now(); await f.diagnostic.close();
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.diagnostic.enabled, false); assert.equal(f.diagnostic.status().closed, true);
  assert.ok(f.diagnostic.status().dropped_events > 0);
  gate.resolve(); await f.diagnostic.flush(1000);
  const saved = await rows(f.directory);
  assert.equal(saved.filter(row => row.kind === "request.end").length, 0);
  assert.ok(saved.some(row => row.kind === "capture.gap" && row.data.reasons.close_timeout > 0));
});
