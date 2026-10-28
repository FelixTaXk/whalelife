import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Memory } from "../core/memory.ts";
import { MemoryEngine, validateMemoryState } from "../core/memory-engine.ts";
import { MemoryAdmin } from "../core/memory-admin.ts";
import { Sessions } from "../core/session.ts";
import { persona } from "../core/persona.ts";
import type { Logger } from "../core/logger.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-memory-resilience-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("whale-memory-resilience-"));
    await rm(root, { recursive: true, force: true });
  });
  const warnings: any[] = [];
  const logger = {
    info() {},
    error() {},
    warn: (...args: any[]) => warnings.push(args),
  } as unknown as Logger;
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  await writeFile(join(root, "persona.md"), "你叫测试助手");
  const config: any = {
    providers: [
      {
        id: "demo",
        protocol: "openai-compatible",
        model: "test-chat",
        base_url: "https://unused.example/v1",
      },
    ],
    models: [
      {
        id: "test-chat",
        provider: "demo",
        model: "test-chat",
        type: "chat",
        enabled: true,
        context_window: 100000,
      },
    ],
    model_bindings: { chat: "test-chat" },
    personas: {
      test: { file: "persona.md", name: "测试助手", provider: "demo" },
    },
    channels: { web: { persona: "test", permission: "off" } },
    memory: { recent_lines: 10, budget_tokens: 6000 },
  };
  const engine = new MemoryEngine(memory),
    extractions: any[] = [];
  const services = {
    memory,
    memoryEngine: engine,
    logger,
    tools: {},
    modelConfig: {
      listModels: async () => ({
        details: [{ id: "test-chat", context_window: 100000 }],
      }),
    },
    llm: {
      chat: async (request: any) => {
        if (request.max_tokens === 1500) {
          const input = JSON.parse(request.messages[1].content);
          extractions.push(input);
          return {
            text: JSON.stringify({
              summary: `已处理批次${extractions.length}`,
              cognition: [
                {
                  text: "此段交流包含有来源的历史记录",
                  evidence: [input.episodes[0].id],
                },
              ],
            }),
            toolCalls: [],
            usage: { prompt_tokens: 300, completion_tokens: 40 },
          };
        }
        return {
          text: "收到",
          toolCalls: [],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        };
      },
    },
  };
  const sessions = new Sessions(root, config, services),
    p = await persona(root, config, "test");
  const policy = {
    recent_lines: 10,
    budget_tokens: 6000,
    include_facts: true,
    include_summary: true,
    history_scope: "session",
  };
  await memory.saveSessionMeta("chat", { context: policy });
  const key =
    "p_" +
    createHash("sha256").update("chat:session").digest("hex").slice(0, 40);
  const seed = async (count: number) => {
    for (let i = 0; i < count; i++)
      await memory.appendEvent({
        session: "chat",
        type: "message",
        role: i % 2 ? "assistant" : "user",
        text: `历史消息${i}`,
        persona_revision: p.revision,
      });
    return memory.readSession("chat");
  };
  return {
    root,
    memory,
    engine,
    sessions,
    services,
    policy,
    key,
    seed,
    extractions,
    warnings,
    logger,
  };
}

test("increasing recent_lines does not rewind a committed summary cursor into already covered history", async (t) => {
  const f = await fixture(t),
    seeded = await f.seed(46);
  await f.sessions.chat("chat", "第一轮", () => {});
  assert.equal(f.extractions.length, 1);
  const checkpoint = await f.engine.summaryState("chat", f.key);
  assert.equal(checkpoint.last_id, seeded[19].id);
  assert.equal(checkpoint.last_offset, 0);
  await f.memory.saveSessionMeta("chat", {
    context: { ...f.policy, recent_lines: 40 },
  });
  await f.sessions.chat("chat", "增加近期消息窗口", () => {});
  assert.equal(
    f.extractions.length,
    1,
    "covered cursor now lies inside recent history and must not restart at index zero",
  );
  const preserved = await f.engine.summaryState("chat", f.key);
  assert.equal(preserved.last_id, checkpoint.last_id);
  assert.equal(preserved.covered, checkpoint.covered);
  await f.memory.saveSessionMeta("chat", { context: f.policy });
  await f.sessions.chat("chat", "恢复原窗口", () => {});
  assert.equal(f.extractions.length, 2);
  assert.equal(f.extractions[1].episodes[0].id, seeded[20].id);
});

test("a failed Markdown projection cannot roll back the authoritative summary, cursor or cognition; restart rebuilds it", async (t) => {
  const f = await fixture(t);
  await f.seed(20);
  const original = f.memory.writeSummary.bind(f.memory);
  f.memory.writeSummary = async () => {
    throw Error("simulated Markdown write failure");
  };
  try {
    assert.equal(
      await f.sessions.chat("chat", "触发一次整理", () => {}),
      "收到",
    );
  } finally {
    f.memory.writeSummary = original;
  }
  const checkpoint = await f.engine.summaryState("chat", f.key);
  assert.equal(f.extractions.length, 1);
  assert.equal(checkpoint.text, "已处理批次1");
  assert.ok(checkpoint.last_id);
  assert.equal(
    checkpoint.retry_at,
    undefined,
    "a projection failure must not restore the old checkpoint with a retry timer",
  );
  assert.equal(
    (await f.engine.state("chat")).records.filter(
      (x: any) => x.kind === "cognition",
    ).length,
    1,
  );
  const reopenedMemory = new Memory(f.memory.root, f.logger);
  await reopenedMemory.init();
  const reopened = new MemoryEngine(reopenedMemory);
  assert.equal(await reopened.readSummary("chat", f.key), checkpoint.text);
  await reopened.recoverSummaries();
  assert.equal(await reopenedMemory.readSummary(f.key), checkpoint.text);
  const recovered = await reopened.summaryState("chat", f.key);
  assert.equal(recovered.last_id, checkpoint.last_id);
  assert.equal(recovered.last_offset, checkpoint.last_offset);
  assert.equal(
    (await reopened.state("chat")).records.filter(
      (x: any) => x.kind === "cognition",
    ).length,
    1,
  );
  const restartedSessions = new Sessions(f.root, f.sessions.config, {
    ...f.services,
    memory: reopenedMemory,
    memoryEngine: reopened,
  });
  await restartedSessions.chat("chat", "继续已有会话", () => {});
  assert.equal(
    f.extractions.length,
    1,
    "the committed batch must not be reprocessed after recovery",
  );
});

test("malformed summary/record structures and negative counters are rejected before backup installation", async (t) => {
  const f = await fixture(t),
    admin = new MemoryAdmin(f.memory, f.sessions, f.logger);
  await f.engine.saveLocalFacts("chat", "有效事实");
  const valid = await f.engine.state("chat"),
    file = join(f.memory.sessionDir("chat"), "knowledge/state.json");
  const mutations: Array<[string, (state: any) => void]> = [
    [
      "summary array",
      (s) => {
        s.summaries = [];
      },
    ],
    [
      "null record",
      (s) => {
        s.records = [null];
      },
    ],
    [
      "negative usage",
      (s) => {
        s.usage.chat.requests = -1;
      },
    ],
    [
      "negative reservation",
      (s) => {
        s.daily.reserved = -1;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const damaged = structuredClone(valid);
    mutate(damaged);
    assert.throws(() => validateMemoryState(damaged), name);
    await writeFile(file, JSON.stringify(damaged));
    const backup = await admin.backup();
    await writeFile(file, JSON.stringify(valid));
    const before = await readFile(file, "utf8");
    await assert.rejects(admin.restore({ id: backup.id }), name);
    assert.equal(
      await readFile(file, "utf8"),
      before,
      `${name}: the current memory must survive a rejected restore`,
    );
    assert.equal(f.sessions.memoryMaintenance, false);
  }
});
