import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryEngine, estimateTokens } from "../core/memory-engine.ts";
import { Tools } from "../core/tools.ts";
import { registerMemoryTools } from "../core/memory-tools.ts";
import { Sessions } from "../core/session.ts";
import { persona } from "../core/persona.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "whale-memory-integration-"));
  const logger: any = { info() {}, warn() {}, error() {} };
  const memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  await writeFile(join(root, "a.md"), "你叫Alpha，按用户配置回应。");
  const config: any = {
    providers: [
      {
        id: "demo",
        protocol: "openai-compatible",
        base_url: "https://unused.example/v1",
        model: "chat-a",
      },
    ],
    models: [
      {
        id: "chat-a",
        provider: "demo",
        model: "chat-a",
        type: "chat",
        enabled: true,
        context_window: 32000,
      },
    ],
    model_bindings: { chat: "chat-a" },
    personas: { a: { file: "a.md", name: "Alpha", provider: "demo" } },
    channels: { web: { persona: "a", permission: "full" } },
    memory: { recent_lines: 30, budget_tokens: 6000 },
  };
  const memoryEngine = new MemoryEngine(memory);
  const tools = new Tools(logger);
  registerMemoryTools(tools, memoryEngine);
  const services: any = {
    memory,
    memoryEngine,
    tools,
    logger,
    llm: {
      chat: async () => ({
        text: "收到",
        toolCalls: [],
        usage: { prompt_tokens: 800, completion_tokens: 200 },
      }),
    },
  };
  const sessions = new Sessions(root, config, services);
  t.after(async () => {
    await memory.queue;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, memory, memoryEngine, tools, services, sessions };
}

test("a rejected fact write disables further tools for this reply instead of repeatedly spending tokens", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.services.llm.chat = async (request: any) => {
    calls++;
    if (calls === 1)
      return {
        text: "",
        toolCalls: [
          {
            id: "over-limit",
            name: "edit_facts",
            arguments: JSON.stringify({ text: "字".repeat(101) }),
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      };
    assert.deepEqual(request.tools, []);
    assert.match(JSON.stringify(request.messages), /不能超过100/);
    return {
      text: "超过100字符，原内容未改动。",
      toolCalls: [],
      usage: { prompt_tokens: 200, completion_tokens: 15 },
    };
  };
  assert.match(
    await f.sessions.chat("one", "写入超过限制的独立事实", () => {}),
    /未改动/,
  );
  assert.equal(calls, 2);
  assert.equal((await f.memoryEngine.localFacts("one")).text, "");
});

test("chat tools edit only local facts, next request receives them, and context usage excludes earlier tool rounds", async (t) => {
  const f = await fixture(t);
  await f.memory.writeFacts(["共享事实由用户维护"]);
  const requests: any[] = [];
  f.services.llm.chat = async (request: any) => {
    requests.push(structuredClone(request.messages));
    if (requests.length === 1)
      return {
        text: "",
        toolCalls: [
          {
            id: "call-one",
            name: "remember_fact",
            arguments: '{"text":"喜欢深蓝色"}',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      };
    return {
      text: "记好了",
      toolCalls: [],
      usage: { prompt_tokens: 200, completion_tokens: 20 },
    };
  };
  await f.sessions.chat("one", "记住我喜欢深蓝色", () => {});
  assert.equal((await f.memoryEngine.localFacts("one")).text, "喜欢深蓝色");
  assert.deepEqual(await f.memory.readFacts(), ["共享事实由用户维护"]);
  const toolReply = requests[1].find((x: any) => x.role === "tool");
  assert.equal(JSON.parse(toolReply.content).result.text, "喜欢深蓝色");
  assert.equal(JSON.parse(toolReply.content).result.history, undefined);
  await f.sessions.chat("one", "继续", () => {});
  assert.match(requests[2][0].content, /喜欢深蓝色/);
  const status = await f.sessions.contextStatus("one");
  assert.equal(status.usage.used_tokens, 220);
  assert.equal(status.usage.percent, (220 / 32000) * 100);
  assert.equal(status.consumption.chat.requests, 3);
  assert.equal(status.consumption.chat.input_tokens, 500);
  assert.equal(status.consumption.memory.requests, 0);
});

test("incremental consolidation catches up after restart without gaps, duplicates, or mixing token meters", async (t) => {
  const f = await fixture(t);
  f.config.memory.short_term_min_messages = 4;
  const p = await persona(f.root, f.config, "a");
  for (let i = 0; i < 40; i++) {
    await f.memory.appendEvent({
      ts: new Date(Date.now() - 30 * 86400000).toISOString(),
      session: "one",
      type: "message",
      role: i % 2 ? "assistant" : "user",
      text: "档案记录" + i,
      persona_revision: p.revision,
      persona_id: "a",
      persona_name: "Alpha",
    });
  }
  const seededIds = (await f.memory.readSession("one")).map((x) => x.id);
  const batches: any[][] = [];
  f.services.llm.chat = async (request: any) => {
    if (request.messages[0].content.includes("只返回JSON")) {
      assert.equal(request.max_tokens, 4096);
      const reservation = estimateTokens(JSON.stringify(request.messages)) + 4096;
      assert.equal((await f.memoryEngine.state("one")).daily.reserved, batches.length * 40 + reservation,
        "in-flight work holds its full estimate in addition to previously settled usage");
      const input = JSON.parse(request.messages[1].content);
      batches.push(input.episodes);
      return {
        text: JSON.stringify({
          summary: "已归纳" + batches.length + "批记录",
          cognition: [
            { text: "用户正持续整理档案", evidence: [input.episodes[0].id] },
          ],
        }),
        toolCalls: [],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      };
    }
    return {
      text: "收到",
      toolCalls: [],
      usage: { prompt_tokens: 800, completion_tokens: 200 },
    };
  };
  await f.sessions.chat("one", "第一轮", () => {});
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 20);
  const services = { ...f.services, memoryEngine: new MemoryEngine(f.memory) };
  const restarted = new Sessions(f.root, f.config, services);
  await restarted.chat("one", "第二轮", () => {});
  await restarted.chat("one", "第三轮", () => {});
  assert.equal(
    batches.length,
    2,
    "remaining short tail should not trigger another model call",
  );
  const consumed = batches.flat().map((x) => x.id);
  assert.deepEqual(consumed, seededIds);
  assert.equal(new Set(consumed).size, 40);
  const rows = await f.memory.readSession("one");
  const summaryId = rows.findLast((x) => x.role === "assistant").summary_id;
  const checkpoint = await services.memoryEngine.summaryState("one", summaryId);
  assert.equal(checkpoint.covered, 40);
  assert.equal(checkpoint.last_id, seededIds.at(-1));
  assert.equal(await f.memory.readSummary(summaryId), "已归纳2批记录");
  const status = await restarted.contextStatus("one");
  assert.equal(status.usage.used_tokens, 1000);
  assert.equal(status.consumption.chat.requests, 3);
  assert.equal(
    status.consumption.chat.input_tokens +
      status.consumption.chat.output_tokens,
    3000,
  );
  assert.equal(status.consumption.memory.requests, 2);
  assert.equal(
    status.consumption.memory.input_tokens +
      status.consumption.memory.output_tokens,
    80,
  );
  const records = (await services.memoryEngine.state("one")).records;
  assert.equal(
    (await services.memoryEngine.state("one")).daily.reserved,
    80,
  );
  assert.equal(records.filter((x: any) => x.kind === "cognition").length, 1,
    "identical cognition is consolidated instead of duplicated");
  assert.ok(records.every((x: any) => !x.kind.includes("intent")));
});

test("chat revises cognition inside the existing summary call and accounts for its full input", async (t) => {
  const f = await fixture(t);
  f.config.memory.short_term_min_messages = 2;
  const p = await persona(f.root, f.config, "a");
  for (let i = 0; i < 12; i++) await f.memory.appendEvent({
      ts: new Date(Date.now() - 30 * 86400000).toISOString(),
    session: "one", type: "message", role: "user",
    text: i === 0 ? "我目前居住南京" : "我已经搬到北京，当前居住北京，记录" + i,
    persona_revision: p.revision,
  });
  const evidence = (await f.memory.readSession("one"))[0].id;
  const old = await f.memoryEngine.record("one", {
    kind: "cognition", text: "用户居住南京", evidence: [evidence], persona_revision: p.revision,
  });
  let chats = 0, extractions = 0, budget = 0;
  f.services.llm.chat = async (request: any) => {
    if (request.messages[0].content.includes("只返回JSON")) {
      extractions++;
      budget += estimateTokens(JSON.stringify(request.messages)) + request.max_tokens;
      assert.equal((await f.memoryEngine.state("one")).daily.reserved, budget);
      const input = JSON.parse(request.messages[1].content);
      assert.equal(input.candidates[0].id, old.id);
      assert.equal(input.candidates[0].revision, undefined, "internal concurrency tokens are not model input");
      return { text: JSON.stringify({ summary: "用户由南京迁居北京", cognition: [{
        text: "用户居住北京", evidence: [input.episodes[1].id], uncertain: false,
        replaces: [input.candidates[0].id], reason: "用户明确说明迁居",
      }], reviews: [] }), toolCalls: [], usage: { prompt_tokens: 90, completion_tokens: 40 } };
    }
    chats++;
    return { text: "你当前居住北京。", toolCalls: [], usage: { prompt_tokens: 200, completion_tokens: 20 } };
  };
  await f.sessions.chat("one", "继续整理", () => {});
  assert.equal(chats, 1);
  assert.equal(extractions, 1, "maintenance must share the existing summary request");
  const state = await f.memoryEngine.state("one");
  assert.equal(state.daily.reserved, 130);
  assert.equal(state.usage.memory.input_tokens, 90);
  assert.equal(state.usage.chat.input_tokens, 200);
  assert.equal(state.records.find((x) => x.id === old.id).status, "superseded");
  const recalled = await f.memoryEngine.search("one", "用户居住");
  assert.deepEqual(recalled.items.filter((x) => x.kind === "cognition").map((x) => x.text), ["用户居住北京"]);
  await f.sessions.chat("one", "你记得我住在哪里吗", () => {});
  assert.equal(chats, 2);
  assert.equal(extractions, 1, "short tail must not launch a separate maintenance cycle");
});

test("failed consolidation retains its cursor and retries the same uncovered source after backoff", async (t) => {
  const f = await fixture(t);
  f.config.memory.short_term_min_messages = 2;
  const p = await persona(f.root, f.config, "a");
  for (let i = 0; i < 12; i++)
    await f.memory.appendEvent({
      ts: new Date(Date.now() - 30 * 86400000).toISOString(),
      session: "one",
      type: "message",
      role: "user",
      text: "待整理记录" + i,
      persona_revision: p.revision,
    });
  const batches: any[][] = [];
  f.services.llm.chat = async (request: any) => {
    if (request.messages[0].content.includes("只返回JSON")) {
      batches.push(JSON.parse(request.messages[1].content).episodes);
      return {
        text:
          batches.length === 1
            ? "不是JSON"
            : JSON.stringify({ summary: "恢复整理", cognition: [] }),
        toolCalls: [],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      };
    }
    return {
      text: "收到",
      toolCalls: [],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    };
  };
  await f.sessions.chat("one", "触发整理", () => {});
  const summaryId = (await f.memory.readSession("one")).findLast(
    (x) => x.role === "assistant",
  ).summary_id;
  const failed = await f.memoryEngine.summaryState("one", summaryId);
  assert.equal(failed.covered, 0);
  assert.ok(failed.retry_at > Date.now());
  await f.sessions.chat("one", "退避期间", () => {});
  assert.equal(batches.length, 1);
  await f.memoryEngine.summaryState("one", summaryId, {
    ...failed,
    retry_at: 0,
  });
  await f.sessions.chat("one", "恢复重试", () => {});
  assert.equal(batches.length, 2);
  assert.deepEqual(
    batches[1].slice(0, batches[0].length).map((x) => x.id),
    batches[0].map((x) => x.id),
  );
  assert.ok(
    (await f.memoryEngine.summaryState("one", summaryId)).covered >=
      batches[0].length,
  );
  assert.equal(
    (await f.memoryEngine.state("one")).usage.memory.requests,
    2,
    "failed parsing still consumed real model tokens",
  );
});

test("a zero consolidation budget keeps chat and recall working without extra model calls", async (t) => {
  const f = await fixture(t);
  f.config.memory.short_term_min_messages = 2;
  const settings = (await f.memoryEngine.state("one")).settings;
  await f.memoryEngine.settings(
    "one",
    { ...settings, daily_memory_tokens: 0 },
    [],
  );
  const p = await persona(f.root, f.config, "a");
  for (let i = 0; i < 12; i++)
    await f.memory.appendEvent({
      ts: new Date(Date.now() - 30 * 86400000).toISOString(),
      session: "one",
      type: "message",
      role: "user",
      text: "蓝鲸档案" + i,
      persona_revision: p.revision,
    });
  const requests: any[] = [];
  f.services.llm.chat = async (request: any) => {
    requests.push(request);
    assert.ok(!request.messages[0].content.includes("只返回JSON"));
    return {
      text: "蓝鲸档案还在",
      toolCalls: [],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    };
  };
  assert.equal(
    await f.sessions.chat("one", "蓝鲸档案有哪些？", () => {}),
    "蓝鲸档案还在",
  );
  const state = await f.memoryEngine.state("one");
  assert.equal(requests.length, 1);
  assert.ok(
    state.trace.selected.length > 0,
    "automatic retrieval must remain available",
  );
  assert.ok(
    (await f.memoryEngine.search("one", "蓝鲸档案", { manual: true })).items
      .length > 0,
  );
  assert.equal(state.usage.chat.requests, 1);
  assert.equal(state.usage.memory.requests, 0);
  assert.equal(state.daily.reserved, 0);
  assert.equal((await f.sessions.contextStatus("one")).usage.used_tokens, 100);
});

test("long episodes remain searchable at the tail and consolidate fully across a restart using character offsets", async (t) => {
  const f = await fixture(t);
  f.config.memory.short_term_min_messages = 2;
  const p = await persona(f.root, f.config, "a");
  const original =
    "🐋日常记录。".repeat(550) + "尾部唯一关键词：NebulaTail9270";
  assert.ok(Array.from(original).length > 3000);
  await f.memory.appendEvent({
      ts: new Date(Date.now() - 30 * 86400000).toISOString(),
    session: "one",
    type: "message",
    role: "user",
    text: original,
    persona_revision: p.revision,
  });
  const longId = (await f.memory.readSession("one"))[0].id;
  for (let i = 0; i < 11; i++)
    await f.memory.appendEvent({
      ts: new Date(Date.now() - 30 * 86400000).toISOString(),
      session: "one",
      type: "message",
      role: "user",
      text: "随后短记录" + i,
      persona_revision: p.revision,
    });
  const recalled = (
    await f.memoryEngine.search("one", "NebulaTail9270", { manual: true })
  ).items;
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].id, longId);
  assert.match(recalled[0].text, /NebulaTail9270/);
  assert.ok(Array.from(recalled[0].text).length <= 501);

  const batches: any[][] = [];
  f.services.llm.chat = async (request: any) => {
    if (request.messages[0].content.includes("只返回JSON")) {
      batches.push(JSON.parse(request.messages[1].content).episodes);
      return {
        text: JSON.stringify({ summary: "长记录整理中", cognition: [] }),
        toolCalls: [],
        usage: { prompt_tokens: 300, completion_tokens: 20 },
      };
    }
    return {
      text: "收到",
      toolCalls: [],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    };
  };
  await f.sessions.chat("one", "第一轮整理", () => {});
  const summaryId = (await f.memory.readSession("one")).findLast(
    (x) => x.role === "assistant",
  ).summary_id;
  const partial = await f.memoryEngine.summaryState("one", summaryId);
  assert.equal(partial.last_id, longId);
  assert.ok(
    partial.last_offset > 0 &&
      partial.last_offset < Array.from(original).length,
  );

  const services = { ...f.services, memoryEngine: new MemoryEngine(f.memory) };
  const restarted = new Sessions(f.root, f.config, services);
  await restarted.chat("one", "第二轮整理", () => {});
  await restarted.chat("one", "第三轮检查", () => {});
  assert.ok(batches.length >= 2);
  const fragments = batches.flat().filter((x) => x.id === longId);
  assert.equal(
    fragments.map((x) => x.text).join(""),
    original,
    "partial-message cursor must not truncate or replay content",
  );
  let offset = 0;
  for (const fragment of fragments) {
    assert.equal(fragment.offset, offset);
    assert.equal(fragment.total_chars, Array.from(original).length);
    assert.ok(Array.from(fragment.text).length <= 1000);
    offset += Array.from(fragment.text).length;
  }
  assert.equal(offset, Array.from(original).length);
  assert.match(fragments.at(-1).text, /NebulaTail9270/);
  assert.equal((await f.memory.readSession("one"))[0].text, original);
});
