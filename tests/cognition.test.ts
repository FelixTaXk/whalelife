import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryEngine, estimateTokens, validateMemoryState } from "../core/memory-engine.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-cognition-"));
  const memory = new Memory(join(root, "memory"), { info() {}, warn() {}, error() {} } as any);
  await memory.init();
  const engine = new MemoryEngine(memory);
  t.after(async () => {
    await memory.queue;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const event = async (text: string, session = "one") => {
    await memory.appendEvent({ session, type: "message", role: "user", text });
    return (await memory.readSession(session)).at(-1).id as string;
  };
  const oldId = await event("我目前住在南京，周末喜欢散步。");
  const old = await engine.record("one", {
    kind: "cognition", text: "用户居住南京", evidence: [oldId], source: "consolidation",
  });
  const evidence = await event("我从南京搬到北京了，现在居住北京。");
  const checkpoint = { covered: 2, last_id: evidence, last_offset: 0, text: "用户已搬到北京" };
  const snapshots = () => engine.cognitionCandidates("one", "用户居住南京搬到北京");
  const revised = () => ({ text: "用户居住北京", evidence: [evidence], uncertain: false,
    replaces: [old.id], reason: "用户明确告知搬家" });
  return { root, memory, engine, event, old, oldId, evidence, checkpoint, snapshots, revised };
}

test("revision replaces only selected cognition, preserves sources, and can be undone after restart", async (t) => {
  const f = await fixture(t);
  await f.memory.writeFacts(["共享事实保持原样"]);
  await f.engine.saveLocalFacts("one", "独立事实保持原样");
  await f.engine.change("one", f.old.id, "pin");
  const before = await f.memory.readSession("one");
  const candidates = await f.snapshots();
  await f.engine.commitSummary("one", "summary", f.checkpoint, [f.revised()], {
    candidates, evidence: [f.evidence],
  });
  const state = await f.engine.state("one");
  const old = state.records.find((x) => x.id === f.old.id);
  const current = state.records.find((x) => x.id === old.superseded_by);
  assert.equal(old.status, "superseded");
  assert.equal(current.text, "用户居住北京");
  assert.equal(current.pinned, true);
  assert.deepEqual(current.supersedes, [old.id]);
  assert.deepEqual(current.evidence, [f.evidence]);
  assert.deepEqual(old.evidence, [f.oldId]);
  assert.deepEqual(await f.memory.readSession("one"), before);
  assert.deepEqual(await f.memory.readFacts(), ["共享事实保持原样"]);
  assert.equal((await f.engine.localFacts("one")).text, "独立事实保持原样");
  assert.ok(!(await f.engine.search("one", "用户居住南京")).items.some((x) => x.id === old.id));
  assert.ok((await f.engine.inspect("one", "", true)).items.some((x) => x.id === old.id));
  await assert.rejects(f.engine.change("one", old.id, "restore"), /已被替代/);
  // Replaying the exact successful commit must not create a new revision.
  await f.engine.commitSummary("one", "summary", f.checkpoint, [f.revised()], { candidates, evidence: [f.evidence] });
  assert.equal((await f.engine.state("one")).records.length, 2);
  const restarted = new MemoryEngine(f.memory);
  await restarted.change("one", current.id, "undo");
  const restored = await restarted.state("one");
  assert.equal(restored.records.find((x) => x.id === old.id).status, "active");
  assert.equal(restored.records.find((x) => x.id === current.id).status, "archived");
  await assert.rejects(restarted.change("one", current.id, "restore"), /已撤回/);
});

test("equivalent cognitions merge into one with both predecessors traceable", async (t) => {
  const f = await fixture(t);
  const second = await f.engine.record("one", {
    kind: "cognition", text: "用户当前生活在南京", evidence: [f.oldId],
  });
  await f.engine.commitSummary("one", "summary", f.checkpoint, [{ ...f.revised(), replaces: [f.old.id, second.id] }], {
    candidates: await f.snapshots(), evidence: [f.evidence],
  });
  const state = await f.engine.state("one");
  assert.equal(state.records.filter((x) => x.status === "active").length, 1);
  const current = state.records.find((x) => x.status === "active");
  await f.engine.change("one", current.id, "undo");
  assert.equal((await f.engine.state("one")).records.filter((x) => x.status === "active").length, 2);
});

test("uncertain corrections are quarantined for review without inventing a replacement", async (t) => {
  const f = await fixture(t);
  await f.engine.commitSummary("one", "summary", f.checkpoint, [], {
    candidates: await f.snapshots(), evidence: [f.evidence],
    reviews: [{ id: f.old.id, reason: "地点说法需要确认", evidence: [f.evidence] }],
  });
  assert.equal((await f.engine.state("one")).records[0].status, "review");
  assert.ok(!(await f.engine.search("one", "居住南京", { manual: true })).items.some((x) => x.id === f.old.id));
  assert.ok((await f.engine.inspect("one", "", true)).items.some((x) => x.status === "review"));
  await f.engine.change("one", f.old.id, "restore");
  const record = (await f.engine.state("one")).records[0];
  assert.equal(record.status, "active");
  assert.equal(record.review_resolved.by, "user");
});

test("foreign targets, fabricated evidence and stale candidates fail atomically without advancing cursor", async (t) => {
  const f = await fixture(t);
  const foreignEvidence = await f.event("另一会话居住上海", "two");
  const foreign = await f.engine.record("two", { kind: "cognition", text: "居住上海", evidence: [foreignEvidence] });
  const candidates = await f.snapshots();
  const baseline = await f.engine.state("one");
  for (const input of [
    { ...f.revised(), replaces: [foreign.id] },
    { ...f.revised(), evidence: [foreignEvidence] },
    { ...f.revised(), evidence: [f.oldId] },
    { ...f.revised(), replaces: [f.old.id, f.old.id] },
    { ...f.revised(), reason: "" },
  ]) {
    await assert.rejects(f.engine.commitSummary("one", "summary", f.checkpoint, [input], {
      candidates, evidence: [f.evidence],
    }));
    assert.deepEqual(await f.engine.state("one"), baseline);
  }
  await f.engine.change("one", f.old.id, "archive");
  await assert.rejects(f.engine.commitSummary("one", "summary", f.checkpoint, [f.revised()], {
    candidates, evidence: [f.evidence],
  }), /变更/);
  assert.deepEqual(await f.engine.summaryState("one", "summary"), { covered: 0 });
});

test("maintenance candidates are local, relevant, bounded and honor explicit persona isolation", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) await f.engine.record("one", {
    kind: "cognition", text: "用户居住南京，记录" + i + "详情".repeat(60), evidence: [f.oldId],
    persona_revision: "persona-b",
  });
  const candidates = await f.snapshots();
  assert.ok(candidates.length <= 4);
  assert.ok(candidates.reduce((n, x) => n + estimateTokens(JSON.stringify(x)), 0) <= 800);
  assert.equal((await f.engine.cognitionCandidates("one", "银河飞船")).length, 0);
  const isolated = await f.engine.cognitionCandidates("one", "用户居住南京", "persona-a");
  assert.deepEqual(isolated.map((x) => x.id), [f.old.id]);
});

test("duplicate consolidation preserves evidence without accumulating identical cognitions", async (t) => {
  const f = await fixture(t);
  await f.engine.commitSummary("one", "summary", f.checkpoint, [{ text: f.old.text, evidence: [f.evidence] }]);
  const state = await f.engine.state("one");
  assert.equal(state.records.length, 1);
  assert.deepEqual(state.records[0].evidence, [f.oldId, f.evidence]);
  const invalid = structuredClone(state);
  invalid.records[0].status = "superseded";
  assert.throws(() => validateMemoryState(invalid), /缺少替代/);
});
