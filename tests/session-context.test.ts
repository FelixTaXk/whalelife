import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Sessions } from "../core/session.ts";
import { Memory } from "../core/memory.ts";
import { Logger } from "../core/logger.ts";
import { persona } from "../core/persona.ts";
import { contextPolicy, requestUsage } from "../core/session-context.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "whale-session-context-"));
  const logger = new Logger(join(root, "logs"));
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  await writeFile(join(root, "a.md"), "你叫 Alpha");
  const config: any = {
    providers: [
      {
        id: "demo",
        protocol: "openai-compatible",
        model: "chat-a",
        base_url: "https://unused.example/v1",
      },
    ],
    models: [
      {
        id: "chat-a",
        provider: "demo",
        model: "chat-a",
        type: "chat",
        enabled: true,
      },
    ],
    model_bindings: { chat: "chat-a" },
    personas: { a: { file: "a.md", name: "Alpha", provider: "demo" } },
    channels: { web: { persona: "a", permission: "off" } },
    memory: { recent_lines: 30, budget_tokens: 6000 },
  };
  const requests: any[] = [];
  let modelReads = 0;
  const services = {
    memory,
    logger,
    tools: {},
    modelConfig: {
      listModels: async () => {
        modelReads++;
        return { details: [{ id: "chat-a", context_window: 10000 }] };
      },
    },
    llm: {
      chat: async (request: any) => {
        requests.push(structuredClone(request.messages));
        return {
          text: "收到",
          toolCalls: [],
          usage: {
            prompt_tokens: 800,
            completion_tokens: 200,
            total_tokens: 99999,
          },
        };
      },
    },
  };
  const sessions = new Sessions(root, config, services);
  return {
    root,
    memory,
    config,
    sessions,
    services,
    requests,
    modelReads: () => modelReads,
  };
}

test("context usage reports the latest provider request, caches model limits and persists across restart", async () => {
  const f = await fixture();
  const initial = await f.sessions.contextStatus("one");
  assert.equal(initial.model.context_window, 10000);
  assert.equal(initial.usage, null);
  await f.sessions.chat("one", "你好", () => {});
  let status = await f.sessions.contextStatus("one");
  assert.equal(status.usage.used_tokens, 1000);
  assert.equal(
    status.usage.percent,
    10,
    "do not use cumulative billing or file bytes",
  );
  assert.equal(f.modelReads(), 1);
  const restarted = new Sessions(f.root, f.config, f.services);
  assert.equal((await restarted.contextStatus("one")).usage.percent, 10);
  const policy = { ...initial.policy, recent_lines: 0 };
  await f.sessions.updateContext("one", policy);
  assert.equal(
    (await f.sessions.contextStatus("one")).usage.settings_changed,
    true,
  );
  assert.deepEqual((await restarted.contextStatus("one")).policy, policy);
  // A newer reply without provider usage must not silently reuse an older measurement.
  const p = await persona(f.root, f.config, "a");
  await f.memory.appendEvent({
    session: "one",
    type: "message",
    role: "assistant",
    text: "未提供用量",
    persona_revision: p.revision,
  });
  assert.equal((await f.sessions.contextStatus("one")).usage, null);
  assert.equal(
    requestUsage({ prompt_tokens: NaN, completion_tokens: 1 }, {}, 100),
    null,
  );
  f.config.models[0].context_window = 20000;
  await f.sessions.chat("one", "继续", () => {});
  status = await f.sessions.contextStatus("one");
  assert.equal(status.usage.percent, 5);
  assert.equal(status.model.limit_source, "configured");
  f.config.models[0].model = "chat-b";
  assert.equal((await f.sessions.contextStatus("one")).usage, null);
});

test("per-session settings control actual history, facts and summary sent to the model", async () => {
  const f = await fixture();
  await f.memory.writeFacts(["只存在于共享事实"]);
  await f.memory.appendEvent({
    session: "one",
    type: "message",
    role: "user",
    text: "旧人格的历史",
  });
  await f.sessions.chat("one", "首次", () => {});
  assert.ok(!JSON.stringify(f.requests[0]).includes("旧人格的历史"));
  const p = await persona(f.root, f.config, "a");
  const summaryId =
    "p_" +
    createHash("sha256")
      .update("one:" + p.revision)
      .digest("hex")
      .slice(0, 40);
  await f.memory.writeSummary(summaryId, "只存在于会话摘要");
  await f.memory.saveSessionMeta("one", { name: "保留名字" });
  const policy = {
    ...contextPolicy(f.config.memory),
    recent_lines: 0,
    include_facts: false,
    include_summary: false,
  };
  await f.sessions.updateContext("one", policy);
  await f.sessions.chat("one", "独立问题", () => {});
  assert.equal(f.requests[1].length, 2);
  assert.ok(!JSON.stringify(f.requests[1]).includes("只存在于"));
  assert.equal((await f.memory.sessionMeta("one")).name, "保留名字");
  await f.sessions.updateContext("one", {
    ...policy,
    recent_lines: 30,
    history_scope: "session",
  });
  await f.sessions.chat("one", "继续历史", () => {});
  assert.ok(JSON.stringify(f.requests[2]).includes("旧人格的历史"));
  assert.equal(
    (await f.sessions.contextStatus("unrelated")).policy.recent_lines,
    30,
  );
  assert.equal(
    (await f.sessions.contextStatus("unrelated")).policy.include_facts,
    true,
  );
});

test("invalid, busy or deleted sessions cannot update context or resume chat", async () => {
  const f = await fixture(),
    policy = contextPolicy(f.config.memory);
  for (const invalid of [
    { ...policy, recent_lines: -1 },
    { ...policy, budget_tokens: 1 },
    { ...policy, history_scope: "unknown" },
  ])
    await assert.rejects(() => f.sessions.updateContext("one", invalid));
  f.sessions.locks.add("one");
  await assert.rejects(
    () => f.sessions.updateContext("one", policy),
    /正在处理/,
  );
  f.sessions.locks.clear();
  await f.memory.saveSessionMeta("gone", { deleted: true });
  await assert.rejects(() => f.sessions.contextStatus("gone"), /已删除/);
  await assert.rejects(
    () => f.sessions.updateContext("gone", policy),
    /已删除/,
  );
  await assert.rejects(
    () => f.sessions.chat("gone", "重建", () => {}),
    /已删除/,
  );
  assert.equal(f.sessions.blockedSessions.size, 0);
});

test("unknown limits preserve measured token counts without inventing a percentage", async () => {
  const f = await fixture();
  f.services.modelConfig.listModels = async () => {
    throw Error("not supported");
  };
  await f.sessions.chat("one", "你好", () => {});
  const value = await f.sessions.contextStatus("one");
  assert.equal(value.model.context_window, null);
  assert.equal(value.usage.used_tokens, 1000);
  assert.equal(value.usage.percent, null);
});
