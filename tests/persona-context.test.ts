import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { temporaryDirectory } from "./temporary-directory.ts";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Sessions } from "../core/session.ts";
import { persona } from "../core/persona.ts";
import { Memory } from "../core/memory.ts";
import { Logger } from "../core/logger.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { contextPolicy } from "../core/session-context.ts";

test("default session history and summary survive persona switches and edits, with explicit isolation still available", async () => {
  assert.equal(contextPolicy({}).history_scope, "session");
  assert.equal(
    contextPolicy({}, { history_scope: "persona" }).history_scope,
    "persona",
  );
  const root = await temporaryDirectory("whale-shared-personas-");
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  const engine = new MemoryEngine(memory);
  await writeFile(join(root, "a.md"), "当前名字ALPHA");
  await writeFile(join(root, "b.md"), "当前名字BETA");
  const config: any = {
    providers: [
      { id: "demo", model: "chat", base_url: "https://unused.example/v1" },
    ],
    personas: {
      a: { name: "A", file: "a.md", provider: "demo" },
      b: { name: "B", file: "b.md", provider: "demo" },
    },
    channels: { web: { persona: "a", permission: "off" } },
    memory: { recent_lines: 30 },
  };
  const requests: any[] = [];
  const sessions = new Sessions(root, config, {
    memory,
    memoryEngine: engine,
    logger,
    tools: {},
    llm: {
      chat: async (r: any) => {
        requests.push(structuredClone(r.messages));
        return { text: "收到", toolCalls: [] };
      },
    },
  });
  engine.maintenance = (id) =>
    sessions.memoryMaintenance || !!(id && sessions.blockedSessions.has(id));
  await sessions.chat("same", "共同暗号：海蓝123", () => {});
  const rows = await memory.readSession("same"),
    key = rows.at(-1).summary_id;
  await engine.commitSummary("same", key, {
    text: "共同摘要：下次讨论星空摄影",
    covered: 2,
    last_id: rows.at(-1).id,
    last_offset: 0,
  });
  config.channels.web.persona = "b";
  await sessions.chat("same", "换人格后继续", () => {});
  assert.match(requests[1][0].content, /当前名字BETA/);
  assert.match(requests[1][0].content, /共同摘要：下次讨论星空摄影/);
  assert.match(JSON.stringify(requests[1]), /共同暗号：海蓝123/);
  assert.equal((await memory.readSession("same")).at(-1).summary_id, key);
  await writeFile(join(root, "b.md"), "当前名字GAMMA");
  await sessions.chat("same", "修改人格后继续", () => {});
  assert.match(requests[2][0].content, /当前名字GAMMA/);
  assert.match(requests[2][0].content, /共同摘要/);
  assert.match(JSON.stringify(requests[2]), /共同暗号/);
  const status = await sessions.updateContext(
    "same",
    contextPolicy(config.memory),
  );
  assert.equal(
    status.policy.history_scope,
    "session",
    "status reads after releasing the maintenance lock",
  );
  assert.equal((await memory.readSession("same")).length, 6);
});

test("persona changes isolate history and summaries while retaining the saved transcript", async () => {
  const root = await temporaryDirectory("whale-persona-context-");
  const logger = new Logger(join(root, "logs"));
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  await memory.saveSessionMeta("same", {
    context: { history_scope: "persona" },
  });
  await writeFile(join(root, "a.md"), "我叫 ALPHA");
  await writeFile(join(root, "b.md"), "我叫 BETA");
  await memory.writeFacts(["重复的共享事实", "重复的共享事实"]);
  await memory.writeSummary("same", "旧人格的历史摘要");
  await memory.appendEvent({
    session: "same",
    type: "message",
    role: "assistant",
    text: "旧人格回复",
  });
  const config = {
    providers: [
      { id: "test", model: "chat", base_url: "https://unused.example/v1" },
    ],
    personas: {
      a: { name: "A", file: "a.md", provider: "test" },
      b: { name: "B", file: "b.md", provider: "test" },
    },
    channels: { web: { persona: "a", permission: "off" } },
    memory: { recent_lines: 30 },
  };
  const requests: any[] = [],
    contexts: any[] = [];
  const sessions = new Sessions(root, config, {
    memory,
    logger,
    tools: {},
    llm: {
      chat: async (request: any) => {
        requests.push(structuredClone(request.messages));
        return { text: "回复 " + requests.length, toolCalls: [] };
      },
    },
  });
  const talk = (text: string) =>
    sessions.chat(
      "same",
      text,
      () => {},
      (value) => contexts.push(value),
    );
  await talk("首次 A");
  assert.equal(requests[0].length, 2);
  assert.ok(!JSON.stringify(requests[0]).includes("旧人格"));
  assert.equal(requests[0][0].content.split("重复的共享事实").length - 1, 1);
  assert.match(
    requests[0][0].content,
    /【当前人格设定】\n我叫 ALPHA\n【人格设定结束】/,
  );
  assert.equal(contexts[0].contextReset, true);
  await talk("继续 A");
  assert.deepEqual(
    requests[1].slice(1).map((x: any) => x.content),
    ['【历史来源 {"channel":"web"}】\n首次 A', "回复 1", "继续 A"],
  );
  assert.equal(contexts[1].contextReset, false);
  const a = await persona(root, config, "a");
  const summaryId =
    "p_" +
    createHash("sha256")
      .update("same:" + a.revision)
      .digest("hex")
      .slice(0, 40);
  await memory.writeSummary(summaryId, "ALPHA 的过期摘要");
  config.channels.web.persona = "b";
  await talk("首次 B");
  assert.equal(requests[2].length, 2);
  assert.ok(!JSON.stringify(requests[2]).includes("ALPHA"));
  assert.equal(contexts[2].personaId, "b");
  config.channels.web.persona = "a";
  await talk("切回 A");
  await talk("继续切回后的 A");
  assert.equal(requests[3].length, 2);
  assert.ok(!JSON.stringify(requests[4]).includes("过期摘要"));
  await writeFile(join(root, "a.md"), "我叫 GAMMA");
  await talk("编辑后 A");
  assert.equal(requests[5].length, 2);
  assert.match(requests[5][0].content, /我叫 GAMMA/);
  assert.ok(!JSON.stringify(requests[5]).includes("ALPHA"));
  const rows = await memory.readSession("same");
  assert.equal(rows.length, 13, "all original history remains on disk");
  assert.equal(rows[5].persona_id, "b");
  assert.equal(rows.at(-1).persona_name, "A");
  assert.notEqual(rows[1].persona_revision, rows.at(-1).persona_revision);
  await assert.rejects(
    () => sessions.chat("same", "过期标签页", () => {}, undefined, "b"),
    /其他窗口/,
  );
  assert.equal(requests.length, 6);
  assert.equal((await memory.readSession("same")).length, rows.length);
});
