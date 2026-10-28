import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Memory } from "../core/memory.ts";
import { MemoryAdmin } from "../core/memory-admin.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import type { Logger } from "../core/logger.ts";

const logger = { info() {}, warn() {}, error() {} } as unknown as Logger;
const fs = createRequire(import.meta.url)("node:fs/promises");
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-memory-v2-")),
    path = join(root, "memory");
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("whale-memory-v2-"));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(path, "sessions"), { recursive: true });
  await mkdir(join(path, "summaries"));
  const summary =
    "p_" + createHash("sha256").update("chat:r1").digest("hex").slice(0, 40);
  const rows = [
    {
      type: "message",
      session: "chat",
      role: "user",
      text: "旧问题",
      persona_revision: "r1",
    },
    {
      type: "message",
      session: "chat",
      role: "assistant",
      text: "旧回复",
      persona_revision: "r1",
      summary_id: summary,
      request_usage: { used_tokens: 321 },
    },
  ];
  const raw = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(join(path, "sessions/chat.jsonl"), raw);
  await writeFile(join(path, "summaries", summary + ".md"), "旧摘要");
  await writeFile(join(path, "facts.md"), "# facts\n原有共享事实\n");
  await writeFile(
    join(path, "index.json"),
    JSON.stringify({
      version: 1,
      custom: "keep",
      sessions: {
        chat: { name: "旧名称", context: { history_scope: "session" } },
      },
    }),
  );
  const memory = new Memory(path, logger);
  const admin = new MemoryAdmin(memory, { root, locks: new Set() }, logger);
  return { root, path, summary, raw, memory, admin };
}

test("v1 migration keeps metadata, measured usage and shared facts; makes a verified backup and does not duplicate on restart", async (t) => {
  const f = await fixture(t);
  await f.memory.init();
  assert.deepEqual(await f.memory.readFacts(), ["原有共享事实"]);
  const records = await f.memory.readSession("chat");
  assert.equal(records.length, 2);
  assert.equal(records[1].request_usage.used_tokens, 321);
  assert.ok(records.every((row) => typeof row.id === "string"));
  assert.equal(await f.memory.readSummary(f.summary), "旧摘要");
  await assert.rejects(readFile(join(f.path, "summaries", f.summary + ".md")), {
    code: "ENOENT",
  });
  assert.equal((await f.admin.summaries()).items.length, 1);
  assert.equal((await f.admin.catalog()).sessions.count, 1);
  const meta = JSON.parse(
    await readFile(join(f.memory.sessionDir("chat"), "session.json"), "utf8"),
  );
  assert.equal(meta.name, "旧名称");
  assert.equal(meta.context.history_scope, "session");
  const backupRoot = join(f.root, "backups/memory-migration"),
    backupId = (await readdir(backupRoot))[0];
  const backup = join(backupRoot, backupId);
  assert.equal(
    await readFile(join(backup, "data/sessions/chat.jsonl"), "utf8"),
    f.raw,
  );
  const manifest = JSON.parse(
    await readFile(join(backup, "manifest.json"), "utf8"),
  );
  for (const entry of manifest.files)
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(backup, "data", entry.path)))
        .digest("hex"),
      entry.sha256,
    );
  await assert.rejects(readFile(join(f.path, "sessions/chat.jsonl")), {
    code: "ENOENT",
  });
  await f.memory.appendEvent({
    session: "chat",
    type: "message",
    text: "新消息",
  });
  const restarted = new Memory(f.path, logger);
  await restarted.init();
  const after = await restarted.readSession("chat");
  assert.equal(after.length, 3);
  assert.equal(after[0].id, records[0].id);
  assert.equal((await restarted.status()).files, 1);
  assert.equal((await readdir(backupRoot)).length, 1);
});

test("migration interrupted after destination write resumes without duplicated events", async (t) => {
  const f = await fixture(t),
    original = fs.unlink;
  fs.unlink = async (path: string) => {
    if (resolve(String(path)) === join(f.path, "sessions/chat.jsonl"))
      throw Error("interrupted migration");
    return original(path);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.memory.init(), /interrupted migration/);
  } finally {
    fs.unlink = original;
    syncBuiltinESMExports();
  }
  const restarted = new Memory(f.path, logger);
  await restarted.init();
  assert.equal((await restarted.readSession("chat")).length, 2);
  assert.equal(await restarted.readSummary(f.summary), "旧摘要");
});

test("legacy backup restores through staged migration and session deletion includes knowledge and plugin state", async (t) => {
  const f = await fixture(t);
  const backup = await f.admin.backup();
  await f.memory.init();
  await f.memory.appendEvent({ session: "chat", text: "after-backup" });
  await f.admin.restore({ id: backup.id });
  assert.equal((await f.memory.readSession("chat")).length, 2);
  assert.equal((await f.memory.sessionMeta("chat")).name, "旧名称");
  const folder = f.memory.sessionDir("chat");
  await mkdir(join(folder, "knowledge"));
  await mkdir(join(folder, "extensions/test-plugin"), { recursive: true });
  await writeFile(join(folder, "knowledge/local.json"), '{"text":"独立事实"}');
  await writeFile(
    join(folder, "extensions/test-plugin/state.json"),
    '{"state":"done"}',
  );
  const deleted = await f.admin.deleteSession({ id: "chat" });
  for (const suffix of [
    "knowledge/local.json",
    "extensions/test-plugin/state.json",
  ]) {
    await assert.rejects(readFile(join(folder, suffix)), { code: "ENOENT" });
    assert.ok(
      await readFile(
        join(f.path, "trash", deleted.trash_id, "sessions/chat", suffix),
      ),
    );
  }
  assert.deepEqual(await f.memory.readFacts(), ["原有共享事实"]);
});

test("invalid middle rows stop migration without erasing the original", async (t) => {
  const f = await fixture(t),
    raw = "{}\nBAD\n{}\n";
  await writeFile(join(f.path, "sessions/chat.jsonl"), raw);
  await assert.rejects(f.memory.init(), /中间行损坏/);
  assert.equal(
    await readFile(join(f.path, "sessions/chat.jsonl"), "utf8"),
    raw,
  );
});

test("restoring memory enforces the 100-character fact cap before installing a backup", async (t) => {
  const f = await fixture(t);
  await f.memory.init();
  const engine = new MemoryEngine(f.memory);
  await engine.saveLocalFacts("chat", "鲸".repeat(100));
  const valid = await f.admin.backup();
  const file = join(f.memory.sessionDir("chat"), "knowledge/state.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  state.facts.text = "鲸".repeat(101);
  await writeFile(file, JSON.stringify(state));
  const invalid = await f.admin.backup();
  state.facts.text = "当前事实";
  await writeFile(file, JSON.stringify(state));
  const before = await readFile(file, "utf8");
  await assert.rejects(f.admin.restore({ id: invalid.id }), /100|事实|记忆/);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(f.admin.sessions.memoryMaintenance, false);
  await f.admin.restore({ id: valid.id });
  assert.equal((await engine.localFacts("chat")).chars, 100);
});

test("summary ownership cannot be reassigned to another session", async (t) => {
  const f = await fixture(t);
  await f.memory.init();
  await f.memory.writeSummary("owned", "属于chat", "chat");
  await assert.rejects(
    f.memory.writeSummary("owned", "覆盖", "other"),
    /其他会话/,
  );
  assert.equal(await f.memory.readSummary("owned"), "属于chat");
});
