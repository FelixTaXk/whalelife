/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LLM } from "../core/llm.ts";
import { Diagnostics } from "../core/diagnostics.ts";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { Sessions } from "../core/session.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const logger: any = { info() {}, warn() {}, error() {} };
const provider = { id: "synthetic", model: "deepseek-synthetic", protocol: "openai-compatible",
  base_url: "https://unused.invalid/v1", api_key: "synthetic-key", parameters: { thinking: { type: "enabled" } } };
const usage = { prompt_tokens: 31, completion_tokens: 12, total_tokens: 43,
  completion_tokens_details: { reasoning_tokens: 9 }, prompt_tokens_details: { cached_tokens: 4 } };
const input = { provider, messages: [{ role: "user", content: "合成协议测试" }] };
const chunk = (delta: any, finish_reason?: string) => ({ choices: [{ delta,
  ...(finish_reason === undefined ? {} : { finish_reason }) }] });
function stream(frames: any[]) {
  const data = new TextEncoder().encode([...frames, "[DONE]"]
    .map(value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`).join(""));
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    // Split both SSE records and UTF-8 sequences, as real network reads may do.
    for (let offset = 0; offset < data.length; offset += 7) controller.enqueue(data.slice(offset, offset + 7));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

test("reasoning alias survives split/null deltas without changing tool calls, usage or text streaming", async t => {
  const chunks: string[] = [], requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    requests.push(JSON.parse(init.body));
    return stream([
      chunk({ reasoning: "SYNTHETIC_PRIVATE_", reasoning_details: [{ type: "reasoning.text", text: "metadata copy" }] }),
      chunk({ reasoning: null }), chunk({ reasoning: "REASONING_鲸" }),
      chunk({ content: "可见", tool_calls: [{ index: 0, id: "call-one", function: { name: "probe", arguments: '{"x":' } }] }),
      chunk({ reasoning: null, content: "文字", tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, "tool_calls"),
      { choices: [], usage },
    ]);
  });
  const reply = await new LLM(logger).chat({ ...input, onChunk: (value: string) => chunks.push(value) });
  assert.equal(reply.reasoning_content, "SYNTHETIC_PRIVATE_REASONING_鲸");
  assert.deepEqual(reply.toolCalls, [{ id: "call-one", name: "probe", arguments: '{"x":1}' }]);
  assert.equal(reply.finish_reason, "tool_calls");
  assert.equal(reply.text, "可见文字"); assert.deepEqual(chunks, ["可见", "文字"]);
  assert.deepEqual(reply.usage, usage); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].thinking, { type: "enabled" });
  assert.equal(Object.hasOwn(reply, "reasoning_details"), false);
});

const cases: { name: string; deltas: any[]; expected: string | undefined }[] = [
  { name: "alias empty string is an observed value", deltas: [{ reasoning: "" }, { reasoning: null }], expected: "" },
  { name: "standard empty string is an observed value", deltas: [{ reasoning_content: "" }], expected: "" },
  { name: "missing fields remain absent despite reasoning token usage", deltas: [{}], expected: undefined },
  { name: "null fields remain absent", deltas: [{ reasoning_content: null, reasoning: null }], expected: undefined },
  { name: "non-string fields are not coerced", deltas: [{ reasoning: 7 }, { reasoning_content: { text: "not a string" } },
    { reasoning_details: [{ type: "reasoning.text", text: "not a supported string field" }] }], expected: undefined },
  { name: "null standard field allows a real alias string", deltas: [{ reasoning_content: null, reasoning: "alias" }], expected: "alias" },
  { name: "standard chunks survive later nulls", deltas: [{ reasoning_content: "stand" },
    { reasoning_content: null }, { reasoning_content: "ard" }], expected: "standard" },
  { name: "duplicated fields in the same deltas are not counted twice", deltas: [
    { reasoning_content: "first", reasoning: "first" }, { reasoning_content: "second", reasoning: "second" }], expected: "firstsecond" },
  { name: "standard stream wins over alias chunks arriving before and after it", deltas: [
    { reasoning: "alias-before" }, { reasoning_content: "stand" }, { reasoning: "alias-after" },
    { reasoning_content: "ard", reasoning: "alias-copy" }], expected: "standard" },
  { name: "standard empty string wins over nonempty alias in the same delta", deltas: [
    { reasoning_content: "", reasoning: "alias" }], expected: "" },
  { name: "late standard empty string replaces an earlier alias and remains authoritative", deltas: [
    { reasoning: "alias-before" }, { reasoning_content: "" }, { reasoning: "alias-after", reasoning_content: null }], expected: "" },
];
for (const sample of cases) test(sample.name, async t => {
  const chunks: string[] = [];
  t.mock.method(globalThis, "fetch", async () => stream([
    ...sample.deltas.map(value => chunk(value)), chunk({ content: "final" }, "stop"), { choices: [], usage },
  ]));
  const reply = await new LLM(logger).chat({ ...input, onChunk: (value: string) => chunks.push(value) });
  assert.equal(reply.reasoning_content, sample.expected);
  assert.equal(Object.hasOwn(reply, "reasoning_content"), sample.expected !== undefined);
  assert.equal(reply.text, "final"); assert.deepEqual(chunks, ["final"]);
  assert.deepEqual(reply.usage, usage);
});

test("diagnostics preserve raw alias and detail fields while reporting the normalized reasoning result", async t => {
  const base = await temporaryDirectory("whale-reasoning-diagnostics-"), root = join(base, "app"), directory = join(base, "capture");
  await mkdir(root);
  const diagnostics = new Diagnostics(root, { enabled: true, directory }, logger, () => []);
  t.after(() => diagnostics.close());
  await diagnostics.initialize();
  const llm = new LLM(logger); llm.diagnostics = diagnostics;
  const raw = [chunk({ reasoning: "SYNTHETIC_DIAGNOSTIC_REASONING",
    reasoning_details: [{ type: "reasoning.text", text: "raw detail must remain intact" }] }),
    chunk({ reasoning: null, content: "final" }, "stop"), { choices: [], usage }];
  t.mock.method(globalThis, "fetch", async () => stream(raw));
  const reply = await llm.chat(input);
  await diagnostics.flush();
  const files = await readdir(directory);
  const events: any[] = (await Promise.all(files.filter(file => /\.(jsonl|ndjson)$/.test(file)).map(async file =>
    (await readFile(join(directory, file), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))))).flat();
  events.sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(events.filter(event => event.kind === "response.chunk" && event.data.phase === "sse")
    .map(event => event.data.raw), [...raw, "[DONE]"]);
  assert.equal(events.find(event => event.kind === "request.end").data.reasoning_content, "SYNTHETIC_DIAGNOSTIC_REASONING");
  assert.equal(reply.reasoning_content, "SYNTHETIC_DIAGNOSTIC_REASONING");
  assert.deepEqual(reply.usage, usage);
});

test("Sessions round-trips alias reasoning through two tool continuations without persisting it", async t => {
  const root = await temporaryDirectory("whale-reasoning-session-"), memory = new Memory(join(root, "memory"), logger);
  const engine = new MemoryEngine(memory), llm = new LLM(logger);
  let sessions: Sessions | undefined;
  t.after(async () => { await sessions?.close(); await memory.queue; });
  await memory.init();
  await writeFile(join(root, "p.md"), "合成人格，仅供离线测试。");
  const config: any = {
    providers: [{ id: provider.id, protocol: provider.protocol, base_url: provider.base_url, api_key: provider.api_key }],
    models: [{ id: "chat", name: "Synthetic", provider: provider.id, model: provider.model, type: "chat", enabled: true,
      context_window: 32000, parameters: provider.parameters }],
    model_bindings: { chat: "chat" }, personas: { p: { name: "Synthetic", file: "p.md", model: "chat" } },
    channels: { web: { persona: "p", permission: "full" } }, memory: { diary_enabled: false },
  };
  const executed: number[] = [], requests: any[] = [], chunks: string[] = [];
  const tools: any = {
    list: () => [{ type: "function", function: { name: "synthetic_step", description: "Offline test step",
      parameters: { type: "object", properties: { step: { type: "integer" } }, required: ["step"] } } }],
    call: async (name: string, args: any) => {
      assert.equal(name, "synthetic_step"); executed.push(args.step); return { ok: true, result: { step: args.step } };
    },
  };
  sessions = new Sessions(root, config, { memory, memoryEngine: engine, llm, tools, logger });
  await memory.saveSessionMeta("one", {});
  await memory.appendEvent({ session: "one", type: "message", role: "assistant", text: "旧的最终回答" });
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    assert.equal(String(url), "https://unused.invalid/v1/chat/completions");
    const body = JSON.parse(init.body), round = requests.length;
    requests.push(body);
    assert.ok(round < 3, "unexpected extra model call");
    assert.deepEqual(body.thinking, { type: "enabled" });
    const assistants = body.messages.filter((message: any) => message.role === "assistant");
    assert.equal(assistants.length, round);
    for (let index = 0; index < round; index++) {
      assert.equal(assistants[index].reasoning_content, `SYNTHETIC_PRIVATE_ROUND_${index}`);
      assert.equal(Object.hasOwn(assistants[index], "reasoning"), false);
      assert.equal(assistants[index].tool_calls[0].id, `call-${index}`);
    }
    const results = body.messages.filter((message: any) => message.role === "tool");
    assert.deepEqual(results.map((message: any) => message.tool_call_id), Array.from({ length: round }, (_, index) => `call-${index}`));
    assert.deepEqual(results.map((message: any) => JSON.parse(message.content).result.step), executed);
    if (round === 2) return stream([chunk({ content: "两步已完成" }, "stop"), { choices: [], usage }]);
    return stream([chunk({ reasoning: "SYNTHETIC_PRIVATE_" }), chunk({ reasoning: null }),
      chunk({ reasoning: `ROUND_${round}`, tool_calls: [{ index: 0, id: `call-${round}`,
        function: { name: "synthetic_step", arguments: JSON.stringify({ step: round }) } }] }, "tool_calls"), { choices: [], usage }]);
  });
  assert.equal(await sessions.chat("one", "执行两个合成步骤", value => chunks.push(value)), "两步已完成");
  assert.equal(requests.length, 3); assert.deepEqual(executed, [0, 1]); assert.deepEqual(chunks, ["两步已完成"]);
  assert.ok(requests[0].messages.some((message: any) => message.content?.startsWith("【历史对话引用")));
  const rows = await memory.readSession("one"), state = await engine.state("one");
  assert.doesNotMatch(JSON.stringify([rows, state]), /SYNTHETIC_PRIVATE_|reasoning_details/);
  assert.equal(state.usage.chat.requests, 3);
  assert.equal(state.usage.chat.input_tokens, usage.prompt_tokens * 3);
  assert.equal(state.usage.chat.output_tokens, usage.completion_tokens * 3);
  assert.equal(sessions.locks.has("one"), false);
});
