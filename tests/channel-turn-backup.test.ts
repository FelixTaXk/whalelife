/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Channels } from "../core/channels.ts";
import { Sessions } from "../core/session.ts";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { MemoryAdmin } from "../core/memory-admin.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const input = (messageId: string) => ({ peer: "friend", sender: "human", messageId, text: messageId });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-channel-turn-backup-");
  const entered = deferred(), release = deferred();
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  let channels: Channels | undefined, sessions: Sessions | undefined;
  t.after(async () => {
    release.resolve();
    await channels?.close();
    await sessions?.close();
  });
  await memory.init();
  await writeFile(join(root, "a.md"), "测试人格");
  const config: any = {
    providers: [{ id: "fake", model: "test", base_url: "https://unused.invalid/v1", context_window: 300000 }],
    personas: { a: { name: "A", file: "a.md", provider: "fake", permission: "off" } },
    channels: { mock: { persona: "a" }, web: { persona: "a" } },
    memory: { recent_lines: 200, budget_tokens: 200000, include_summary: false },
  };
  let modelCount = 0, sendCount = 0, holdNext = false;
  const engine = new MemoryEngine(memory);
  const llm = { chat: async () => {
    modelCount++;
    if (holdNext) { holdNext = false; entered.resolve(); await release.promise; }
    return { text: "final reply", toolCalls: [] };
  } };
  const services: any = { memory, memoryEngine: engine, logger, llm, tools: { list: () => [] } };
  sessions = new Sessions(root, config, services);
  engine.maintenance = id => !!sessions!.memoryMaintenance || !!(id && sessions!.blockedSessions.has(id));
  channels = new Channels(memory, sessions, config);
  const handle = channels.register({ id: "mock", account: "one", send: async () => { sendCount++; } }, "backup-test");
  const admin = new MemoryAdmin(memory, sessions, logger);
  const legacy = await handle.receive(input("legacy"));
  const outgoing = await handle.send({ peer: "friend", messageId: "outgoing", text: "direct send" });
  const before = await admin.backup();
  holdNext = true;
  const turn = await handle.openTurn!(input("leader"));
  await entered.promise;
  assert.equal((await turn.append(input("member"))).status, "accepted");
  const pending = await admin.backup();
  await turn.closeInput();
  release.resolve();
  const result = await turn.result();
  assert.equal(result.status, "sent");
  const completed = await admin.backup();
  return { memory, sessions, handle, admin, legacy, outgoing, result, before, pending, completed,
    counts: () => ({ models: modelCount, sends: sendCount }) };
}

async function rewriteBackupIndex(admin: MemoryAdmin, id: string, index: any) {
  const folder = join(admin.backupRoot, id), raw = JSON.stringify(index, null, 2);
  await writeFile(join(folder, "data", "index.json"), raw);
  const path = join(folder, "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  const file = manifest.files.find((entry: any) => entry.path === "index.json");
  file.bytes = Buffer.byteLength(raw);
  file.sha256 = digest(raw);
  manifest.bytes = manifest.files.reduce((total: number, entry: any) => total + entry.bytes, 0);
  await writeFile(path, JSON.stringify(manifest));
}

test("grouped and legacy receipts restore from before, pending and completed snapshots without replay", { timeout: 20000 }, async t => {
  const f = await fixture(t), counts = f.counts();
  for (const backup of [f.before, f.pending, f.completed]) {
    assert.equal((await f.admin.restore({ id: backup.id })).ok, true);
    assert.deepEqual(await f.handle.receive(input("legacy")), { ...f.legacy, duplicate: true });
    assert.deepEqual(await f.handle.send({ peer: "friend", messageId: "outgoing", text: "direct send" }), { ...f.outgoing, duplicate: true });
    assert.deepEqual(await f.handle.receive(input("leader")), { ...f.result, duplicate: true });
    const member = await f.handle.receive(input("member"));
    assert.deepEqual(member, { ...f.result, messageId: "member", duplicate: true });
    assert.deepEqual(await f.handle.retry("friend", "member"), member);
    assert.equal((await (await f.handle.openTurn!(input("leader"))).result()).status, "sent");
    assert.equal((await (await f.handle.openTurn!(input("member"))).result()).deliveryId, f.result.deliveryId);
    assert.deepEqual(f.counts(), counts);
    assert.equal(f.sessions.memoryMaintenance, false);
  }
});

test("restore rejects corrupt group links even with matching backup manifest hashes", { timeout: 20000 }, async t => {
  const f = await fixture(t), counts = f.counts();
  const original = JSON.parse(await readFile(join(f.admin.backupRoot, f.completed.id, "data", "index.json"), "utf8"));
  const liveBefore = await readFile(join(f.memory.root, "index.json"), "utf8");
  const cases: [string, (route: any, leader: any, member: any) => void][] = [
    ["missing leader", route => { delete route.receipts[digest(JSON.stringify(["leader", "in"]))]; }],
    ["changed member group", (_route, _leader, member) => { member.receipt.group_id = "turn_" + "0".repeat(64); }],
    ["changed leader group", (_route, leader) => { leader.receipt.group_id = "turn_" + "0".repeat(64); }],
    ["member uses its own delivery", (route, _leader, member) => {
      member.receipt.delivery_id = "delivery_" + digest(JSON.stringify([member.receipt.channel_key, "member", "in"]));
    }],
    ["self linked member", (_route, _leader, member) => { member.receipt.group_message_id = "member"; }],
    ["member in another session", (_route, _leader, member) => { member.sessionId = "another_session"; }],
    ["member from another sender", (_route, _leader, member) => {
      member.receipt.input_sender = "another_sender";
      member.receipt.fingerprint = digest(JSON.stringify([member.receipt.input_sender, member.receipt.input_text]));
    }],
    ["changed durable input", (_route, _leader, member) => { member.receipt.input_text = "altered input"; }],
  ];
  for (const [name, corrupt] of cases) await t.test(name, async () => {
    const index = structuredClone(original), route: any = Object.values(index.channel_routes)[0];
    const leader = route.receipts[digest(JSON.stringify(["leader", "in"]))];
    const member = route.receipts[digest(JSON.stringify(["member", "in"]))];
    corrupt(route, leader, member);
    await rewriteBackupIndex(f.admin, f.completed.id, index);
    await assert.rejects(() => f.admin.restore({ id: f.completed.id }), /渠道.*回执/);
    assert.equal(await readFile(join(f.memory.root, "index.json"), "utf8"), liveBefore);
    assert.equal(f.sessions.memoryMaintenance, false);
    assert.deepEqual(f.counts(), counts);
  });
});

test("restoring a rebound route preserves old-session grouped receipts", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.memory.saveSessionMeta("new_session", {});
  await f.handle.rebind("friend", { expectedSessionId: f.result.sessionId, sessionId: "new_session" });
  const newer = await f.handle.receive(input("after-rebind"));
  assert.equal(newer.sessionId, "new_session");
  const counts = f.counts(), backup = await f.admin.backup();
  await f.admin.restore({ id: backup.id });
  const member = await f.handle.receive(input("member"));
  assert.equal(member.sessionId, f.result.sessionId);
  assert.equal(member.deliveryId, f.result.deliveryId);
  assert.equal(member.duplicate, true);
  assert.deepEqual(await f.handle.retry("friend", "member"), member);
  assert.deepEqual(await f.handle.receive(input("after-rebind")), { ...newer, duplicate: true });
  assert.deepEqual(f.counts(), counts);
});

test("restore refuses a valid snapshot that assigns the same input to another group", { timeout: 20000 }, async t => {
  const f = await fixture(t), counts = f.counts();
  const index = JSON.parse(await readFile(join(f.admin.backupRoot, f.completed.id, "data", "index.json"), "utf8"));
  const route: any = Object.values(index.channel_routes)[0];
  const member = route.receipts[digest(JSON.stringify(["member", "in"]))].receipt;
  // Both snapshots are internally valid, but the backup treats this member as its own leader.
  delete member.group_message_id;
  member.group_id = "turn_" + digest(JSON.stringify([member.channel_key, "member"]));
  member.delivery_id = "delivery_" + digest(JSON.stringify([member.channel_key, "member", "in"]));
  await rewriteBackupIndex(f.admin, f.completed.id, index);
  const liveBefore = await readFile(join(f.memory.root, "index.json"), "utf8");
  await assert.rejects(() => f.admin.restore({ id: f.completed.id }), /备份渠道消息 ID 与当前回执冲突/);
  assert.equal(await readFile(join(f.memory.root, "index.json"), "utf8"), liveBefore);
  assert.equal(f.sessions.memoryMaintenance, false);
  assert.deepEqual(f.counts(), counts);
});
