import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, relative } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryAdmin, MemoryAdminError } from "../core/memory-admin.ts";
import type { Logger } from "../core/logger.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-session-management-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("whale-session-management-"));
    await rm(root, { recursive: true, force: true });
  });
  const logs: unknown[] = [],
    log = (...args: unknown[]) => logs.push(args);
  const logger = { info: log, warn: log, error: log } as unknown as Logger;
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  const sessions = {
    root,
    locks: new Set<string>(),
    blockedSessions: new Set<string>(),
    memoryMaintenance: false,
  };
  const admin = new MemoryAdmin(memory, sessions, logger);
  return { root, memory, sessions, admin, logger, logs };
}
const status = (expected: number) => (error: unknown) => {
  assert.ok(error instanceof MemoryAdminError);
  assert.equal(error.status, expected);
  return true;
};
const summaryId = (id: string, revision: string) =>
  "p_" +
  createHash("sha256")
    .update(id + ":" + revision)
    .digest("hex")
    .slice(0, 40);
const fs = createRequire(import.meta.url)("node:fs/promises");

test("renaming and later chat writes preserve names, context, and unrelated index metadata", async (t) => {
  const f = await fixture(t);
  const context = {
    recent_lines: 12,
    budget_tokens: 4096,
    include_facts: false,
    include_summary: true,
    history_scope: "persona",
  };
  await f.memory.saveSessionMeta("chat", { context, custom: { keep: true } });
  assert.equal((await f.admin.catalog()).sessions.count, 1);
  await assert.rejects(readFile(join(f.memory.root, "sessions/chat.jsonl")), {
    code: "ENOENT",
  });
  await f.memory.appendEvent({ session: "chat", text: "first" });
  assert.deepEqual(
    await f.admin.renameSession({ id: "chat", name: "  本周计划  " }),
    { id: "chat", name: "本周计划" },
  );
  await Promise.all([
    f.memory.appendEvent({ session: "chat", text: "second" }),
    f.memory.saveSessionMeta("chat", {
      context: { ...context, recent_lines: 30 },
    }),
  ]);
  const meta = await f.memory.sessionMeta("chat");
  assert.equal(meta.name, "本周计划");
  assert.equal(meta.context.recent_lines, 30);
  assert.deepEqual(meta.custom, { keep: true });
  assert.match(meta.file, /^sessions\/chat\/episodes\/\d{4}-\d{2}\.jsonl$/);
  assert.equal(JSON.parse(await readFile(join(f.memory.sessionDir("chat"), "session.json"), "utf8")).name, "本周计划");
  assert.equal((await f.admin.session("chat")).name, "本周计划");
  assert.equal(
    (await f.admin.catalog({ search: "周计划" })).sessions.items[0].name,
    "本周计划",
  );
  assert.equal(
    (await f.admin.catalog({ search: "does-not-exist" })).sessions.total,
    0,
  );
  assert.equal(await f.memory.sessionMeta("missing"), null);
});

test("delete archives only this session and all known summary variants, persists a tombstone, and prevents reuse", async (t) => {
  const f = await fixture(t),
    explicit = "p_" + "c".repeat(40);
  await f.memory.appendEvent({
    session: "chat",
    text: "private-a",
    persona_revision: "r1",
  });
  await f.memory.appendEvent({
    session: "chat",
    text: "private-b",
    persona_revision: "r2",
    summary_id: explicit,
  });
  await f.memory.appendEvent({
    session: "chat",
    summary_id: "../facts",
    text: "unsafe summary id ignored",
  });
  const recordPath = (await f.memory.episodePaths("chat"))[0];
  await appendFile(recordPath, '{"partial":');
  await f.admin.renameSession({ id: "chat", name: "保存我的名字" });
  await f.memory.saveSessionMeta("chat", { context: { include_facts: false } });
  await f.memory.appendEvent({ session: "other", text: "unrelated" });
  const related = [
    "chat",
    summaryId("chat", "r1"),
    summaryId("chat", "r2"),
    explicit,
  ];
  for (const id of [...related, "unrelated"])
    await f.memory.writeSummary(id, "summary-" + id);
  await f.memory.addFact("keep-facts");
  const summaryPaths = new Map(await Promise.all(related.map(async (id) => [id, await f.memory.summaryPath(id)] as const)));
  const original = await readFile(recordPath);
  const metadata = await f.memory.sessionMeta("chat");
  const deleted = await f.admin.deleteSession({ id: "chat" });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.files, 6);
  assert.match(deleted.trash_id, /^session-\d{8}T\d{9}Z-[a-f0-9]{12}$/);
  const trash = join(f.memory.root, "trash", deleted.trash_id);
  assert.deepEqual(
    await readFile(join(trash, relative(f.memory.root, recordPath))),
    original,
  );
  const manifest = JSON.parse(
    await readFile(join(trash, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.metadata, metadata);
  assert.equal(manifest.session_id, "chat");
  assert.equal(manifest.files.length, 6);
  for (const id of related) {
    await assert.rejects(readFile(summaryPaths.get(id)!), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(join(trash, relative(f.memory.root, summaryPaths.get(id)!)), "utf8"),
      "summary-" + id,
    );
  }
  assert.equal(await f.memory.readSummary("unrelated"), "summary-unrelated");
  assert.match((await f.admin.facts()).text, /keep-facts/);
  assert.deepEqual(
    (await f.admin.catalog()).sessions.items.map((x) => x.id),
    ["other"],
  );
  const reopened = new Memory(f.memory.root, f.logger),
    tombstone = await reopened.sessionMeta("chat");
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.name, "保存我的名字");
  assert.equal(tombstone.context.include_facts, false);
  await assert.rejects(
    reopened.appendEvent({ session: "chat", text: "must-not-reappear" }),
    /会话已删除/,
  );
  await assert.rejects(
    reopened.saveSessionMeta("chat", { name: "resurrect" }),
    /会话已删除/,
  );
  await assert.rejects(f.admin.session("chat"), status(410));
  await assert.rejects(
    f.admin.renameSession({ id: "chat", name: "resurrect" }),
    status(409),
  );
  assert.deepEqual(await f.admin.deleteSession({ id: "chat" }), deleted);
  assert.equal(f.sessions.blockedSessions.size, 0);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /private-a|private-b|保存我的名字/,
  );
});

test("busy target deletion is rejected and a queued delete synchronously reserves the ID", async (t) => {
  const f = await fixture(t);
  await f.memory.appendEvent({ session: "chat", text: "one" });
  f.sessions.locks.add("chat");
  await assert.rejects(f.admin.deleteSession({ id: "chat" }), status(409));
  assert.equal(f.sessions.blockedSessions.size, 0);
  f.sessions.locks.delete("chat");
  f.sessions.locks.add("other");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    pendingWrite = f.memory.serial(() => gate);
  const deletion = f.admin.deleteSession({ id: "chat" });
  assert.equal(f.sessions.blockedSessions.has("chat"), true);
  await assert.rejects(f.admin.deleteSession({ id: "chat" }), status(409));
  const lateWrite = assert.rejects(
    f.memory.appendEvent({ session: "chat", text: "queued-after-delete" }),
    /会话已删除/,
  );
  release();
  await pendingWrite;
  await deletion;
  await lateWrite;
  assert.equal(f.sessions.blockedSessions.has("chat"), false);
  assert.equal(f.sessions.locks.has("other"), true);
  f.sessions.memoryMaintenance = true;
  await assert.rejects(f.admin.deleteSession({ id: "other" }), status(409));
});

test("session IDs, title limits, and text payloads cannot escape paths or mutate object prototypes", async (t) => {
  const f = await fixture(t);
  for (const id of ["../config", "a/b", "a\\b", "x".repeat(101)]) {
    await assert.rejects(f.admin.deleteSession({ id }), status(400));
    await assert.rejects(
      f.admin.renameSession({ id, name: "valid" }),
      status(400),
    );
  }
  await f.memory.appendEvent({ session: "__proto__", text: "one" });
  const markup = '<img src=x onerror="alert(1)">';
  await f.admin.renameSession({ id: "__proto__", name: markup });
  await f.memory.appendEvent({ session: "__proto__", text: "two" });
  assert.equal((await f.memory.sessionMeta("__proto__")).name, markup);
  assert.equal(
    (await f.admin.catalog({ search: "onerror" })).sessions.items[0].name,
    markup,
  );
  assert.equal(Object.hasOwn(Object.prototype, "name"), false);
  for (const name of [
    "",
    " ",
    "line\nline",
    "tab\tname",
    "bad\u0000name",
    "x".repeat(81),
    "😀".repeat(81),
  ])
    await assert.rejects(
      f.admin.renameSession({ id: "__proto__", name }),
      status(400),
    );
  await f.admin.renameSession({ id: "__proto__", name: "😀".repeat(80) });
  await f.admin.deleteSession({ id: "__proto__" });
  assert.equal((await f.memory.sessionMeta("__proto__")).deleted, true);
  await assert.rejects(f.admin.deleteSession({ id: "missing" }), status(404));
  await assert.rejects(
    f.admin.renameSession({ id: "missing", name: "ok" }),
    status(404),
  );
});

test("a linked trash folder cannot write outside memory", async (t) => {
  const f = await fixture(t),
    outside = join(f.root, "outside");
  await f.memory.appendEvent({ session: "chat", text: "safe" });
  await mkdir(outside);
  await symlink(outside, join(f.memory.root, "trash"), "junction");
  await assert.rejects(
    f.admin.deleteSession({ id: "chat" }),
    /符号链接|目录联接/,
  );
  assert.deepEqual(await readdir(outside), []);
  assert.equal((await f.memory.readSession("chat"))[0].text, "safe");
  assert.equal((await f.memory.sessionMeta("chat")).deleted, undefined);
  assert.equal(f.sessions.blockedSessions.size, 0);
});

test("a removal failure rolls back original files and index while retaining recoverable trash copies", async (t) => {
  const f = await fixture(t);
  await f.memory.appendEvent({ session: "chat", text: "original" });
  await f.memory.writeSummary("chat", "original-summary");
  await f.admin.renameSession({ id: "chat", name: "original-name" });
  const before = await f.memory.sessionMeta("chat"),
    original = fs.unlink;
  fs.unlink = async (path: any) => {
    if (resolve(String(path)) === join(f.memory.sessionDir("chat"), "summaries/chat.md"))
      throw Object.assign(new Error("simulated unlink failure"), {
        code: "EACCES",
      });
    return original(path);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.admin.deleteSession({ id: "chat" }),
      /simulated unlink failure/,
    );
  } finally {
    fs.unlink = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await f.memory.sessionMeta("chat"), before);
  assert.equal((await f.memory.readSession("chat"))[0].text, "original");
  assert.equal(await f.memory.readSummary("chat"), "original-summary");
  const trashId = (await readdir(join(f.memory.root, "trash")))[0];
  assert.ok(
    await readFile(
      join(f.memory.root, "trash", trashId, relative(f.memory.root, (await f.memory.episodePaths("chat"))[0])),
    ),
  );
  assert.equal(f.sessions.blockedSessions.size, 0);
});

test("an external index edit during trash preparation is preserved without removing session files", async (t) => {
  const f = await fixture(t),
    original = fs.writeFile;
  await f.memory.appendEvent({ session: "chat", text: "original" });
  const indexPath = join(f.memory.root, "index.json");
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (reached = r)),
    gate = new Promise<void>((r) => (release = r));
  fs.writeFile = async (path: any, ...args: any[]) => {
    await original(path, ...args);
    if (
      String(path).startsWith(join(f.memory.root, "trash")) &&
      basename(String(path)) === "manifest.json"
    ) {
      reached();
      await gate;
    }
  };
  syncBuiltinESMExports();
  try {
    const deletion = assert.rejects(
      f.admin.deleteSession({ id: "chat" }),
      status(409),
    );
    await ready;
    const changed = JSON.parse(await readFile(indexPath, "utf8"));
    changed.external = "keep-me";
    await original(indexPath, JSON.stringify(changed));
    release();
    await deletion;
    assert.equal(
      JSON.parse(await readFile(indexPath, "utf8")).external,
      "keep-me",
    );
    assert.equal((await f.memory.readSession("chat"))[0].text, "original");
    assert.equal((await f.memory.sessionMeta("chat")).deleted, undefined);
  } finally {
    release();
    fs.writeFile = original;
    syncBuiltinESMExports();
  }
});

test("a corrupted index cannot erase tombstones through append fallback", async (t) => {
  const f = await fixture(t),
    index = join(f.memory.root, "index.json");
  await writeFile(index, '{"sessions":');
  await assert.rejects(
    f.memory.appendEvent({ session: "chat", text: "must-not-write" }),
  );
  assert.equal(await readFile(index, "utf8"), '{"sessions":');
  await assert.rejects(readFile(join(f.memory.root, "sessions/chat.jsonl")), {
    code: "ENOENT",
  });
});
