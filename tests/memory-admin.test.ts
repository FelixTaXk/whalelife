import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Memory } from "../core/memory.ts";
import { MemoryAdmin, MemoryAdminError } from "../core/memory-admin.ts";
import type { Logger } from "../core/logger.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-memory-admin-"));
  t.after(async () => {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("whale-memory-admin-"));
    await rm(target, { recursive: true, force: true });
  });
  const messages: unknown[] = [];
  const log = (...args: unknown[]) => messages.push(args);
  const logger = { info: log, warn: log, error: log } as unknown as Logger;
  await mkdir(join(root, "config"));
  const configFile = join(root, "config", "config.json");
  await writeFile(configFile, '{"api_key":"fixture-key-must-not-change"}\n');
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  const sessions = { root, locks: new Set<string>(), memoryMaintenance: false };
  const admin = new MemoryAdmin(memory, sessions, logger);
  return { root, memory, sessions, admin, configFile, messages, logger };
}
const status = (expected: number) => (error: unknown) => {
  assert.ok(error instanceof MemoryAdminError);
  assert.equal(error.status, expected);
  return true;
};
const fs = createRequire(import.meta.url)("node:fs/promises");

test("catalog and record views count, search, paginate, and tolerate a truncated session tail", async (t) => {
  const f = await fixture(t);
  await f.memory.addFact("第一条事实");
  await f.memory.addFact("第二条事实");
  await f.memory.appendEvent({
    session: "alpha",
    role: "user",
    text: "search needle",
  });
  await f.memory.appendEvent({
    session: "alpha",
    role: "assistant",
    text: "answer",
  });
  await f.memory.appendEvent({ session: "beta", role: "user", text: "other" });
  await appendFile(join(f.memory.root, "sessions/alpha.jsonl"), '{"partial":');
  await f.memory.writeSummary("alpha", "# 摘要\n会话内容\n");
  await f.memory.writeSummary("reset-placeholder", "");

  const catalog = await f.admin.catalog({ offset: 0, limit: 1 });
  assert.equal(catalog.facts.count, 2);
  assert.equal(catalog.sessions.count, 2);
  assert.equal(catalog.sessions.total, 2);
  assert.equal(catalog.sessions.items.length, 1);
  assert.equal(catalog.summaries.count, 1);
  assert.equal(catalog.files, 6);
  assert.ok(catalog.bytes > catalog.facts.bytes + catalog.sessions.bytes);
  assert.ok(Number.isFinite(Date.parse(catalog.updated_at!)));
  assert.equal(catalog.busy, false);
  assert.equal(catalog.restoring, false);
  assert.deepEqual(
    (await f.admin.catalog({ search: "NEEDLE" })).sessions.items.map(
      (x) => x.id,
    ),
    ["alpha"],
  );
  assert.deepEqual(
    (await f.admin.catalog({ search: "beta" })).sessions.items.map((x) => x.id),
    ["beta"],
  );
  const page = await f.admin.session("alpha", 1, 1);
  assert.equal(page.total, 2);
  assert.equal(page.items[0].text, "answer");
  assert.match(page.warnings[0], /最后一行/);
  assert.equal((await f.admin.session("alpha", 0, 100, "needle")).total, 1);
  assert.deepEqual(
    (await f.admin.summaries()).items.map((x) => x.id),
    ["alpha"],
  );
  assert.equal((await f.admin.summary("alpha")).text, "# 摘要\n会话内容\n");
  await assert.rejects(f.admin.session("../config"), status(400));
  await assert.rejects(f.admin.summary("../config"), status(400));
  await assert.rejects(f.admin.session("missing"), status(404));
  await assert.rejects(f.admin.summary("missing"), status(404));
  await assert.rejects(f.admin.catalog({ limit: 201 }), status(400));
  await assert.rejects(f.admin.session("alpha", -1), status(400));
  await assert.rejects(
    f.admin.catalog({ search: "x".repeat(201) }),
    status(400),
  );
});

test("facts saves normalize lines, validate format and size, and reject stale revisions", async (t) => {
  const f = await fixture(t);
  const initial = await f.admin.facts();
  await f.memory.addFact("tool-added-private-fact");
  await assert.rejects(
    f.admin.saveFacts({ text: "overwrite", revision: initial.revision }),
    status(409),
  );
  const current = await f.admin.facts();
  const saved = await f.admin.saveFacts({
    text: "\uFEFF# facts\r\n  用户偏好  \r\n\r\n另一条\r\n",
    revision: current.revision,
  });
  assert.equal(saved.text, "# facts\n用户偏好\n\n另一条\n");
  assert.equal(saved.count, 2);
  assert.equal(saved.bytes, Buffer.byteLength(saved.text));
  assert.notEqual(saved.revision, current.revision);
  for (const text of [
    "bad\u0000line",
    "bad\tline",
    "bad\u2028line",
    "bad\rline",
    "x".repeat(2001),
  ]) {
    await assert.rejects(
      f.admin.saveFacts({ text, revision: saved.revision }),
      status(400),
    );
  }
  await assert.rejects(
    f.admin.saveFacts({ text: "x\n".repeat(16385), revision: saved.revision }),
    status(413),
  );
  await writeFile(join(f.memory.root, "facts.md"), "external-private-edit\n");
  await assert.rejects(
    f.admin.saveFacts({ text: "stale", revision: saved.revision }),
    status(409),
  );
  assert.equal((await f.admin.facts()).text, "external-private-edit\n");
  assert.doesNotMatch(
    JSON.stringify(f.messages),
    /external-private-edit|tool-added-private-fact|用户偏好/,
  );
});

test("an external edit during the atomic facts save is retained", async (t) => {
  const f = await fixture(t),
    current = await f.admin.facts();
  const original = fs.writeFile;
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (reached = r)),
    gate = new Promise<void>((r) => (release = r));
  fs.writeFile = async (path: any, ...args: any[]) => {
    await original(path, ...args);
    if (
      dirname(String(path)) === f.memory.root &&
      basename(String(path)).startsWith(".facts-")
    ) {
      reached();
      await gate;
    }
  };
  syncBuiltinESMExports();
  try {
    const pending = f.admin.saveFacts({
      text: "pending-admin-change",
      revision: current.revision,
    });
    const rejected = assert.rejects(pending, status(409));
    await ready;
    await original(
      join(f.memory.root, "facts.md"),
      "concurrent-external-change\n",
    );
    release();
    await rejected;
    assert.equal((await f.admin.facts()).text, "concurrent-external-change\n");
    assert.equal(
      (await readdir(f.memory.root)).some((name) => name.startsWith(".facts-")),
      false,
    );
  } finally {
    release();
    fs.writeFile = original;
    syncBuiltinESMExports();
  }
});

test("full memory backup and restore preserve files, personas and empty directories without touching config", async (t) => {
  const f = await fixture(t);
  await f.memory.addFact("original-private-fact");
  await f.memory.appendEvent({
    session: "chat",
    role: "user",
    text: "original-conversation",
  });
  await f.memory.writeSummary("chat", "original-summary");
  await writeFile(join(f.memory.root, "personas/whale.md"), "original-persona");
  await mkdir(join(f.memory.root, "longterm/empty"), { recursive: true });
  const binary = Buffer.alloc(300000);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
  await writeFile(join(f.memory.root, "longterm/vector.bin"), binary);
  const configBefore = await readFile(f.configFile);
  const originalFacts = await readFile(join(f.memory.root, "facts.md"));
  const originalIndex = await readFile(join(f.memory.root, "index.json"));
  const backup = await f.admin.backup();
  assert.equal(backup.kind, "manual");
  assert.equal(backup.includes_personas, true);
  assert.equal(backup.files, 6);
  assert.ok(backup.bytes > binary.length);
  assert.equal(backup.valid, true);
  await f.memory.addFact("new-private-fact");
  await writeFile(join(f.memory.root, "personas/whale.md"), "changed-persona");
  await writeFile(join(f.memory.root, "new-file.txt"), "new-file");
  const latestFacts = await readFile(join(f.memory.root, "facts.md"));
  const restored = await f.admin.restore({ id: backup.id });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored_from, backup.id);
  assert.equal(restored.personas_restored, true);
  assert.equal(restored.safety_backup.kind, "before-restore");
  assert.equal(f.sessions.memoryMaintenance, false);
  assert.deepEqual(await readFile(f.configFile), configBefore);
  assert.deepEqual(
    await readFile(join(f.memory.root, "facts.md")),
    originalFacts,
  );
  assert.deepEqual(
    await readFile(join(f.memory.root, "index.json")),
    originalIndex,
  );
  assert.deepEqual(
    await readFile(join(f.memory.root, "longterm/vector.bin")),
    binary,
  );
  assert.equal(
    await readFile(join(f.memory.root, "personas/whale.md"), "utf8"),
    "original-persona",
  );
  assert.deepEqual(await readdir(join(f.memory.root, "longterm/empty")), []);
  await assert.rejects(readFile(join(f.memory.root, "new-file.txt")), {
    code: "ENOENT",
  });
  const safetyRoot = join(
    f.admin.backupRoot,
    restored.safety_backup.id,
    "data",
  );
  assert.deepEqual(await readFile(join(safetyRoot, "facts.md")), latestFacts);
  assert.equal(
    await readFile(join(safetyRoot, "personas/whale.md"), "utf8"),
    "changed-persona",
  );
  assert.equal(
    await readFile(join(safetyRoot, "new-file.txt"), "utf8"),
    "new-file",
  );
  assert.equal((await f.admin.backups()).items.length, 2);
  assert.equal(
    (await readdir(f.root)).some((name) =>
      name.startsWith(".whalelife-memory-"),
    ),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(f.messages),
    /original-private-fact|new-private-fact|original-persona|fixture-key-must-not-change/,
  );
  await f.memory.addFact("after-restore");
  assert.match((await f.admin.facts()).text, /after-restore/);
});

test("tampered backup content and manifest traversal cannot change current memory", async (t) => {
  const f = await fixture(t),
    saved = await f.admin.backup();
  const backupPath = join(f.admin.backupRoot, saved.id),
    manifestPath = join(backupPath, "manifest.json");
  const original = await readFile(join(f.memory.root, "facts.md"));
  await writeFile(join(backupPath, "data/facts.md"), "tampered-backup\n");
  await assert.rejects(f.admin.restore({ id: saved.id }), /备份内容校验失败/);
  assert.deepEqual(await readFile(join(f.memory.root, "facts.md")), original);
  assert.equal((await f.admin.backups()).items.length, 1);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files[0].path = "../config/config.json";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.admin.restore({ id: saved.id }), /路径无效/);
  const listed = await f.admin.backups();
  assert.equal(listed.items[0].valid, false);
  assert.equal(f.sessions.memoryMaintenance, false);
  assert.deepEqual(await readFile(join(f.memory.root, "facts.md")), original);
  await assert.rejects(f.admin.restore({ id: "../config" }), /备份 ID 无效/);
  assert.equal(f.sessions.memoryMaintenance, false);
});

test("memory links, backup links, and hard links are rejected without traversing them", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside"),
    linked = join(f.memory.root, "linked");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "outside-is-unchanged");
  await symlink(outside, linked, "junction");
  await assert.rejects(f.admin.backup(), /符号链接|目录联接/);
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "outside-is-unchanged",
  );
  await unlink(linked);
  const hard = join(f.memory.root, "hard.txt");
  await link(join(outside, "sentinel"), hard);
  await assert.rejects(f.admin.backup(), /硬链接/);
  await unlink(hard);
  const saved = await f.admin.backup();
  await symlink(
    outside,
    join(f.admin.backupRoot, saved.id, "data/link"),
    "junction",
  );
  await assert.rejects(f.admin.restore({ id: saved.id }), /符号链接|目录联接/);
  assert.equal(f.sessions.memoryMaintenance, false);
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "outside-is-unchanged",
  );
});

test("root boundaries and a linked backup parent cannot target config or unrelated directories", async (t) => {
  const f = await fixture(t);
  for (const unsafe of [
    f.root,
    dirname(f.root),
    join(f.root, "config"),
    join(f.root, "config/nested"),
    join(f.root, "backups/memory/nested"),
  ]) {
    assert.throws(
      () => new MemoryAdmin(new Memory(unsafe, f.logger), f.sessions, f.logger),
      /根目录/,
    );
  }
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, join(f.root, "backups"), "junction");
  await assert.rejects(f.admin.backup(), /符号链接|目录联接/);
  assert.deepEqual(await readdir(outside), []);
});

test("restore refuses active chat and reserves maintenance synchronously while queued", async (t) => {
  const f = await fixture(t),
    saved = await f.admin.backup();
  f.sessions.locks.add("chat");
  await assert.rejects(f.admin.restore({ id: saved.id }), status(409));
  assert.equal(f.sessions.memoryMaintenance, false);
  f.sessions.locks.clear();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const write = f.memory.serial(async () => {
    await gate;
    await writeFile(join(f.memory.root, "facts.md"), "queued-before-restore\n");
  });
  const restore = f.admin.restore({ id: saved.id });
  assert.equal(f.sessions.memoryMaintenance, true);
  await assert.rejects(f.admin.restore({ id: saved.id }), status(409));
  release();
  await write;
  const result = await restore;
  assert.equal(
    await readFile(
      join(f.admin.backupRoot, result.safety_backup.id, "data/facts.md"),
      "utf8",
    ),
    "queued-before-restore\n",
  );
  assert.equal(f.sessions.memoryMaintenance, false);
});

test("a failed directory installation rolls back the current memory and keeps its safety backup", async (t) => {
  const f = await fixture(t),
    saved = await f.admin.backup();
  await f.memory.addFact("current-must-survive");
  const current = await readFile(join(f.memory.root, "facts.md"));
  const original = fs.rename;
  let failed = false;
  fs.rename = async (from: any, to: any) => {
    if (
      relative(f.root, dirname(String(from))) === "" &&
      basename(String(from)).startsWith(".whalelife-memory-restore-") &&
      resolve(String(to)) === resolve(f.memory.root)
    ) {
      failed = true;
      throw Object.assign(new Error("simulated install failure"), {
        code: "EACCES",
      });
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.admin.restore({ id: saved.id }),
      /simulated install failure/,
    );
  } finally {
    fs.rename = original;
    syncBuiltinESMExports();
  }
  assert.equal(failed, true);
  assert.equal(f.sessions.memoryMaintenance, false);
  assert.deepEqual(await readFile(join(f.memory.root, "facts.md")), current);
  const safety = (await f.admin.backups()).items.find(
    (x) => x.kind === "before-restore",
  );
  assert.ok(safety);
  assert.deepEqual(
    await readFile(join(f.admin.backupRoot, safety.id, "data/facts.md")),
    current,
  );
  assert.equal(
    (await readdir(f.root)).some((name) =>
      name.startsWith(".whalelife-memory-"),
    ),
    false,
  );
});

test("restore requires every currently referenced persona file inside memory and ignores external paths", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.memory.root, "personas/old.md"), "old-persona");
  const saved = await f.admin.backup();
  await f.memory.addFact("current-fact");
  await writeFile(join(f.memory.root, "personas/new.md"), "new-persona");
  const currentFacts = await readFile(join(f.memory.root, "facts.md"));
  const currentConfig = await readFile(f.configFile);
  const config = {
    personas: {
      old: { file: "memory/personas/old.md" },
      added: { file: join(f.memory.root, "personas/new.md") },
      external: { file: "external/missing-persona.md" },
    } as Record<string, { file: string }>,
  };
  f.admin.sessions.config = config;
  await assert.rejects(f.admin.restore({ id: saved.id }), (error: unknown) => {
    assert.ok(error instanceof MemoryAdminError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "此备份缺少当前配置使用的人格文件，无法恢复");
    return true;
  });
  assert.deepEqual(
    await readFile(join(f.memory.root, "facts.md")),
    currentFacts,
  );
  assert.equal(
    await readFile(join(f.memory.root, "personas/new.md"), "utf8"),
    "new-persona",
  );
  assert.deepEqual(await readFile(f.configFile), currentConfig);
  assert.equal(f.sessions.memoryMaintenance, false);
  assert.equal((await f.admin.backups()).items.length, 1);
  delete config.personas.added;
  config.personas.directory = { file: "memory/personas" };
  await assert.rejects(f.admin.restore({ id: saved.id }), status(409));
  delete config.personas.directory;
  const result = await f.admin.restore({ id: saved.id });
  assert.equal(result.ok, true);
  assert.equal(
    await readFile(join(f.memory.root, "personas/old.md"), "utf8"),
    "old-persona",
  );
  assert.deepEqual(await readFile(f.configFile), currentConfig);
  assert.equal(config.personas.external.file, "external/missing-persona.md");
});
