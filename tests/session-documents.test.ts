import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { boot } from "../core/index.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const logger: any = { info() {}, warn() {}, error() {} };
const documentPath = (root: string, session = "one", owner = "probe") =>
  join(root, "memory", "sessions", session, "extensions",
    createHash("sha256").update(owner).digest("hex").slice(0, 20), "documents", "intents.json");
async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-session-documents-");
  const memory = new Memory(join(root, "memory"), logger);
  t.after(async () => { await memory.queue; });
  await memory.init();
  await memory.saveSessionMeta("one", {});
  await memory.saveSessionMeta("two", {});
  const engine = new MemoryEngine(memory), disposers: (() => void)[] = [];
  const api = engine.plugin("probe", fn => disposers.push(fn));
  return { root, memory, engine, api, stop: () => disposers.forEach(fn => fn()) };
}

test("opaque intent documents persist without becoming facts, recall, history or usage", async t => {
  const f = await fixture(t), before = await f.engine.state("one");
  assert.deepEqual(await f.api.readDocument("one", "intents"), { revision: null, data: null });
  await assert.rejects(access(dirname(documentPath(f.root))));
  const data = { schema: 17, items: [{ text: "私有计划标记海盐", custom: [1, false, null] }] };
  const saved = await f.api.saveDocument("one", { key: "intents", data, revision: null });
  assert.ok(saved.revision);
  assert.deepEqual(saved.data, data);
  assert.deepEqual((JSON.parse(await readFile(documentPath(f.root), "utf8"))).data, data);
  assert.deepEqual(await f.api.readDocument("two", "intents"), { revision: null, data: null });
  assert.deepEqual(await f.engine.plugin("other", () => {}).readDocument("one", "intents"), { revision: null, data: null });
  assert.deepEqual(await f.engine.state("one"), before);
  assert.deepEqual(await f.memory.readSession("one"), []);
  assert.deepEqual((await f.engine.search("one", "私有计划标记海盐", { manual: true })).items, []);
  const restarted = new Memory(join(f.root, "memory"), logger);
  await restarted.init();
  assert.deepEqual(await new MemoryEngine(restarted).plugin("probe", () => {}).readDocument("one", "intents"), saved);
});

test("document writes detect concurrent/stale revisions, preserve caller snapshots and allow clearing", async t => {
  const f = await fixture(t), input = { key: "intents", revision: null, data: { items: ["original"] } };
  const first = f.api.saveDocument("one", input);
  input.data.items[0] = "mutated";
  const saved = await first;
  assert.deepEqual(saved.data, { items: ["original"] });
  const results = await Promise.allSettled(["a", "b"].map(text =>
    f.api.saveDocument("one", { key: "intents", revision: saved.revision, data: { text } })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  const live = await f.api.readDocument("one", "intents");
  const empty = await f.api.saveDocument("one", { key: "intents", revision: live.revision, data: null });
  assert.equal(empty.data, null);
  assert.ok(empty.revision);
  await assert.rejects(f.api.saveDocument("one", { key: "intents", revision: null, data: [] }), /变更/);
  assert.deepEqual(await f.api.readDocument("one", "intents"), empty);
});

test("document API rejects invalid JSON, oversized UTF8, path escape, absent/deleted sessions and corrupt files", async t => {
  const f = await fixture(t);
  for (const key of ["../intents", "a/b", "a\\b", "A", "", "a".repeat(65)])
    await assert.rejects(f.api.saveDocument("one", { key, revision: null, data: [] }), /key/);
  for (const data of [undefined, { n: Infinity }, { x: undefined }, 1n, { f() {} }])
    await assert.rejects(f.api.saveDocument("one", { key: "intents", revision: null, data }), /JSON|BigInt/);
  await assert.rejects(f.api.saveDocument("one", { key: "intents", revision: null, data: "鲸".repeat(90000) }), /256/);
  await assert.rejects(f.api.saveDocument("one", { key: "intents", data: [] } as any), /revision/);
  await assert.rejects(f.api.readDocument("absent", "intents"), /不存在/);
  await assert.rejects(f.api.readDocument("../one", "intents"), /ID/);
  await f.memory.saveSessionMeta("two", { deleted: true });
  await assert.rejects(f.api.saveDocument("two", { key: "intents", revision: null, data: [] }), /删除/);
  const saved = await f.api.saveDocument("one", { key: "intents", revision: null, data: [] });
  const file = documentPath(f.root), raw = await readFile(file, "utf8");
  await writeFile(file, raw.replace('"owner":"probe"', '"owner":"other"'));
  await assert.rejects(f.api.readDocument("one", "intents"), /归属/);
  await writeFile(file, "{broken");
  await assert.rejects(f.api.saveDocument("one", { key: "intents", revision: saved.revision, data: [] }));
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("queued writes respect plugin stop and session maintenance without changing the file", async t => {
  const f = await fixture(t);
  const saved = await f.api.saveDocument("one", { key: "intents", revision: null, data: [] });
  let release!: () => void;
  const gate = f.memory.serial(() => new Promise<void>(r => { release = r; }));
  await new Promise<void>(r => setImmediate(r));
  const pending = assert.rejects(f.api.saveDocument("one", { key: "intents", revision: saved.revision, data: [1] }), /停用/);
  f.stop(); release();
  await Promise.all([gate, pending]);
  const api = f.engine.plugin("probe", () => {});
  assert.deepEqual(await api.readDocument("one", "intents"), saved);
  const gate2 = f.memory.serial(() => new Promise<void>(r => { release = r; }));
  await new Promise<void>(r => setImmediate(r));
  const pending2 = assert.rejects(api.saveDocument("one", { key: "intents", revision: saved.revision, data: [2] }), /维护/);
  f.engine.maintenance = () => true; release();
  await Promise.all([gate2, pending2]);
  f.engine.maintenance = () => false;
  assert.deepEqual(await api.readDocument("one", "intents"), saved);
});

test("failed atomic replacement keeps the prior document and cleans temporary files", async t => {
  const f = await fixture(t), file = documentPath(f.root);
  const saved = await f.api.saveDocument("one", { key: "intents", revision: null, data: ["keep"] });
  const fs = createRequire(import.meta.url)("node:fs/promises"), original = fs.rename;
  fs.rename = async (from: string, to: string) => {
    if (to === file) throw Object.assign(Error("document disk failure"), { code: "EIO" });
    return original(from, to);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.api.saveDocument("one", { key: "intents", revision: saved.revision, data: [] }), /disk failure/); }
  finally { fs.rename = original; syncBuiltinESMExports(); }
  assert.deepEqual(await f.api.readDocument("one", "intents"), saved);
  assert.deepEqual(await readdir(dirname(file)), ["intents.json"]);
});

test("document directories cannot follow links outside the session", async t => {
  const f = await fixture(t), folder = dirname(documentPath(f.root));
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await mkdir(dirname(folder), { recursive: true });
  await symlink(outside, folder, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.api.saveDocument("one", { key: "intents", revision: null, data: [] }), /链接/);
  assert.deepEqual(await readdir(outside), []);
});

test("real child plugin can roundtrip documents, restore backups and reload without injecting model context", async t => {
  const root = await temporaryDirectory("whale-document-child-");
  let app: any;
  t.after(async () => { await app?.close(); });
  await mkdir(join(root, "config"));
  await mkdir(join(root, "plugins/doc-probe"), { recursive: true });
  await writeFile(join(root, "plugins/doc-probe/plugin.yaml"), 'id: doc-probe\nname: Documents\nversion: 1.0.0\ndescription: Isolated document contract test\napiVersion: "1"\n');
  await writeFile(join(root, "plugins/doc-probe/index.ts"), `export function apply(ctx) {
    ctx.provide('doc-probe', {
      read: (id, key) => ctx.memory.readDocument(id, key),
      save: (id, input) => ctx.memory.saveDocument(id, input),
      chat: (text) => ctx.sessions.run({ text }),
    });
  }`);
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "test", base_url: "https://unused.invalid/v1", api_key: "synthetic" }],
    models: [{ id: "chat", name: "Test", provider: "test", model: "test", type: "chat", enabled: true }],
    model_bindings: { chat: "chat" }, personas: { a: { name: "A", file: "a.md", permission: "off" } },
    channels: { web: { persona: "a", permission: "off" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  const id = await app.sessions.current();
  const api = () => app.runtime.services.get("doc-probe").value;
  const saved = await api().save(id, { key: "intents", revision: null, data: { items: ["私有计划标记海盐"] } });
  assert.deepEqual(await api().read(id, "intents"), saved);
  const requests: any[] = [];
  app.llm.chat = async (input: any) => {
    requests.push(JSON.stringify(input));
    return { text: "模拟回复", toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 3 } };
  };
  await api().chat("你好");
  assert.equal(requests.some(x => x.includes("私有计划标记海盐")), false);
  assert.equal(app.tools.list().some((x: any) => /intent/i.test(x.function.name)), false);
  const backup = await app.memoryAdmin.backup();
  await api().save(id, { key: "intents", revision: saved.revision, data: [] });
  await app.memoryAdmin.restore({ id: backup.id });
  assert.deepEqual(await api().read(id, "intents"), saved);
  const old = api();
  await app.runtime.action("doc-probe", "stop");
  await assert.rejects(async () => old.read(id, "intents"), /停用|停止|关闭|失效/);
  assert.deepEqual((await app.memoryEngine.search(id, "私有计划标记海盐", { manual: true })).items, []);
  await app.runtime.action("doc-probe", "start");
  assert.deepEqual(await api().read(id, "intents"), saved);
  await app.close();
  app = await boot(root);
  assert.deepEqual(await api().read(id, "intents"), saved);
  await app.memoryAdmin.deleteSession({ id });
  await assert.rejects(api().read(id, "intents"), /删除/);
});
