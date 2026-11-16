/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LLM } from "../core/llm.ts";
import {
  validateReasoningCompatibility, encodeReasoningMessages, ReasoningAccumulator, readReasoningDelta,
} from "../core/reasoning-compatibility.ts";
import { Memory } from "../core/memory.ts";
import { MemoryEngine } from "../core/memory-engine.ts";
import { Sessions } from "../core/session.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const logger: any = { info() {}, warn() {}, error() {} };
const provider = { id: "synthetic", model: "deepseek-synthetic", protocol: "openai-compatible",
  base_url: "https://unused.invalid/v1", api_key: "synthetic-key", parameters: { thinking: { type: "enabled" } } };
const usage = { prompt_tokens: 31, completion_tokens: 12, total_tokens: 43,
  completion_tokens_details: { reasoning_tokens: 9 }, prompt_tokens_details: { cached_tokens: 4 } };
const tool = { type: "function", function: { name: "synthetic_step", description: "Offline step",
  parameters: { type: "object", properties: { step: { type: "integer" } }, required: ["step"] } } };
const call = { index: 0, id: "call-0", function: { name: "synthetic_step", arguments: '{"step":0}' } };
const frame = (delta: any, finish_reason?: string) => ({ choices: [{ delta,
  ...(finish_reason === undefined ? {} : { finish_reason }) }] });
function stream(deltas: any[], toolCalls = false) {
  const frames = [...deltas.map(delta => frame(delta)),
    frame({ content: "可见正文", ...(toolCalls ? { tool_calls: [call] } : {}) }, toolCalls ? "tool_calls" : "stop"),
    { choices: [], usage }];
  const bytes = new TextEncoder().encode([...frames.map(value => JSON.stringify(value)), "[DONE]"]
    .map(value => `data: ${value}\n\n`).join(""));
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

test("disabled reasoning compatibility normalizes to absence without changing existing messages", () => {
  const messages = [{ role: "assistant", content: "old", reasoning_content: "real" }];
  for (const value of [undefined, null, false, {}, { fill_missing: false }]) {
    const config = validateReasoningCompatibility(value);
    assert.equal(config, undefined);
    assert.equal(encodeReasoningMessages(messages, config), messages);
  }
  const input = { response_field: "extensions.thought.text", request_field: "thinking_text", fill_missing: false };
  assert.deepEqual(validateReasoningCompatibility(input), { response_field: input.response_field, request_field: input.request_field });
  assert.equal(input.fill_missing, false);
});

test("reasoning compatibility rejects unsafe paths, unrelated protocol fields and invalid settings", () => {
  const values: unknown[] = [true, [], "reasoning", { fill_missing: 1 }, { unknown: true }, new Date(),
    { response_field: "" }, { request_field: "" }, { response_field: "a.b.c.d.e" },
    { response_field: "a[0].text" }, { request_field: "a.b" }, { response_field: "a".repeat(65) },
    { response_field: " reasoning" }, { response_field: "reasoning\n" }, { response_field: "é" }];
  for (const key of ["__proto__", "prototype", "constructor", "role", "content", "tool_calls", "tool_call_id",
    "usage", "reasoning_tokens", "api_key", "headers", "model", "reasoning_details", "signature", "encrypted_content"])
    values.push({ response_field: key }, { response_field: "meta." + key }, { request_field: key });
  values.push(JSON.parse('{"__proto__":{"polluted":true}}'));
  for (const value of values) assert.throws(() => validateReasoningCompatibility(value), (error: any) => error.status === 400);
  assert.equal(({} as any).polluted, undefined);
});

test("an explicit source cannot accidentally pass verification by reading a different field", () => {
  const config = validateReasoningCompatibility({ response_field: "extra.thought" });
  const reasoning = new ReasoningAccumulator(config);
  reasoning.push({ reasoning_content: "standard text", reasoning: "alias text" });
  assert.equal(reasoning.value(), undefined);
  assert.equal(readReasoningDelta({ reasoning_content: "standard text" }, config), undefined);
  reasoning.push({ extra: { thought: 12 } }); reasoning.push({ extra: { thought: null } });
  assert.equal(reasoning.value(), undefined);
  reasoning.push({ extra: { thought: "" } });
  assert.equal(reasoning.value(), "");
  reasoning.push({ extra: { thought: "mapped" } });
  assert.equal(reasoning.value(), "mapped");
  assert.equal(readReasoningDelta(Object.create({ reasoning: "inherited" })), undefined);
});

test("mapped chunks round-trip through their configured field without mutating requests or visible text", async t => {
  const requests: any[] = [], chunks: string[] = [], deltas: any[] = [];
  const p = { ...provider, reasoning_compatibility: { response_field: "extensions.thought.text", request_field: "thinking_text" } };
  const initial = [{ role: "user", content: "合成协议测试" }];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? stream([
      { extensions: { thought: { text: "PRIVATE_" } }, reasoning_content: "different-standard" },
      { extensions: { thought: { text: null } } },
      { extensions: { thought: { text: "MAPPED_鲸" } }, reasoning: "different-alias" },
    ], true) : stream([]);
  });
  const llm = new LLM(logger);
  const first = await llm.chat({ provider: p, messages: initial, tools: [tool], onChunk: (v: string) => chunks.push(v),
    onProtocolDelta(delta: any) { deltas.push(structuredClone(delta)); delta.content = "not visible"; delta.extensions = {}; } });
  assert.equal(first.reasoning_content, "PRIVATE_MAPPED_鲸");
  assert.deepEqual(first.usage, usage); assert.deepEqual(chunks, ["可见正文"]);
  assert.ok(deltas.some(delta => delta.extensions?.thought?.text === "PRIVATE_"));
  const messages = [...initial, { role: "assistant", content: first.text, reasoning_content: first.reasoning_content,
    tool_calls: [{ id: first.toolCalls[0].id, type: "function", function: { name: first.toolCalls[0].name, arguments: first.toolCalls[0].arguments } }] },
    { role: "tool", tool_call_id: first.toolCalls[0].id, content: '{"result":0}' }];
  const before = structuredClone(messages);
  const final = await llm.chat({ provider: p, messages, tools: [tool] });
  assert.equal(final.text, "可见正文");
  assert.equal(Object.hasOwn(final, "reasoning_content"), false);
  assert.equal(requests[1].messages[1].thinking_text, "PRIVATE_MAPPED_鲸");
  assert.equal(Object.hasOwn(requests[1].messages[1], "reasoning_content"), false);
  assert.deepEqual(requests[1].messages[2], messages[2]);
  assert.deepEqual(messages, before);
  for (const request of requests) {
    assert.equal(Object.hasOwn(request, "reasoning_compatibility"), false);
    assert.deepEqual(request.thinking, provider.parameters.thinking);
  }
});

test("request remapping preserves existing real text and rejects conflicting extension fields", () => {
  const config = validateReasoningCompatibility({ request_field: "thinking_text", fill_missing: true });
  const messages = [
    { role: "assistant", content: "final" },
    { role: "assistant", content: null, tool_calls: [call], reasoning_content: "real" },
    { role: "assistant", tool_calls: [call], thinking_text: "already encoded" },
    { role: "tool", tool_call_id: "call-0", content: "result" },
    { role: "user", content: "user", reasoning_content: "user extension" },
  ];
  const before = structuredClone(messages), result = encodeReasoningMessages(messages, config);
  assert.equal(result[0], messages[0]); assert.equal(result[1].thinking_text, "real");
  assert.equal(result[2].thinking_text, "already encoded"); assert.equal(result[3], messages[3]);
  assert.equal(result[4], messages[4]); assert.deepEqual(messages, before);
  assert.throws(() => encodeReasoningMessages([{ role: "assistant", reasoning_content: "a", thinking_text: "b" }], config), /冲突/);
  assert.throws(() => encodeReasoningMessages([{ role: "assistant", thinking_text: { signature: "opaque" } }], config), /冲突/);
  const defaults = validateReasoningCompatibility({ fill_missing: true });
  const historical = [{ role: "assistant", reasoning: "real alias", tool_calls: [call] },
    { role: "assistant", tool_calls: [call] }];
  assert.deepEqual(encodeReasoningMessages(historical, defaults), historical,
    "filling must not rewrite caller-supplied historical assistant messages");
});

const filling = [
  { name: "missing thought in a tool response", delta: {}, requested: true, called: true, expected: "" },
  { name: "null thought in a tool response", delta: { reasoning_content: null }, requested: true, called: true, expected: "" },
  { name: "a real standard thought", delta: { reasoning_content: "keep real" }, requested: true, called: true, expected: "keep real" },
  { name: "an explicit standard empty thought", delta: { reasoning_content: "", reasoning: "alias" }, requested: true, called: true, expected: "" },
  { name: "a real alias thought", delta: { reasoning: "keep alias" }, requested: true, called: true, expected: "keep alias" },
  { name: "a final answer without a tool call", delta: {}, requested: true, called: false, expected: undefined },
  { name: "an unsolicited tool call when no tools were requested", delta: {}, requested: false, called: true, expected: undefined },
];
for (const sample of filling) test(`fill_missing handles ${sample.name}`, async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return stream([sample.delta], sample.called); });
  const reply = await new LLM(logger).chat({ provider: { ...provider, reasoning_compatibility: { fill_missing: true } },
    messages: [{ role: "user", content: "synthetic" }], ...(sample.requested ? { tools: [tool] } : {}) });
  assert.equal(reply.reasoning_content, sample.expected);
  assert.equal(Object.hasOwn(reply, "reasoning_content"), sample.expected !== undefined);
  assert.deepEqual(reply.usage, usage); assert.equal(reply.text, "可见正文"); assert.equal(requests, 1);
  assert.equal(reply.toolCalls.length, sample.called ? 1 : 0);
});

test("fill_missing preserves actual standard text when an explicitly mapped source disappears", async t => {
  t.mock.method(globalThis, "fetch", async () => stream([{ reasoning_content: "keep actual" }], true));
  const reply = await new LLM(logger).chat({ provider: { ...provider,
    reasoning_compatibility: { response_field: "absent_field", request_field: "thinking_text", fill_missing: true } },
    messages: [], tools: [tool] });
  assert.equal(reply.reasoning_content, "keep actual");
});

for (const enabled of [false, true]) test(`Sessions ${enabled ? "opt-in fallback executes once" : "default rejects before executing"} without persisting protocol data`, async t => {
  const root = await temporaryDirectory("whale-compat-session-"), memory = new Memory(join(root, "memory"), logger);
  const engine = new MemoryEngine(memory), llm = new LLM(logger);
  let sessions: Sessions | undefined;
  t.after(async () => { await sessions?.close(); await memory.queue; });
  await memory.init();
  await writeFile(join(root, "p.md"), "合成人格，仅供离线测试。");
  // Legacy caller providers remain supported. ModelConfig's optional model-level
  // propagation is independently covered by configuration tests.
  const config: any = {
    providers: [{ ...provider, enabled: true, ...(enabled ? { reasoning_compatibility: { fill_missing: true } } : {}) }],
    personas: { p: { name: "Synthetic", file: "p.md", provider: provider.id } },
    channels: { web: { persona: "p", permission: "full" } }, memory: { diary_enabled: false },
  };
  const executed: number[] = [], requests: any[] = [];
  const tools: any = { list: () => [tool], call: async (name: string, args: any) => {
    assert.equal(name, "synthetic_step"); executed.push(args.step); return { ok: true, result: { step: args.step } };
  } };
  sessions = new Sessions(root, config, { memory, memoryEngine: engine, llm, tools, logger });
  await memory.saveSessionMeta("one", {});
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const body = JSON.parse(init.body); requests.push(body);
    assert.ok(requests.length <= 2, "no automatic model or tool retry");
    if (requests.length === 1) return stream([], true);
    const assistant = body.messages.find((message: any) => message.role === "assistant");
    assert.equal(assistant.reasoning_content, "");
    assert.equal(assistant.tool_calls[0].id, "call-0");
    assert.equal(body.messages.find((message: any) => message.role === "tool").tool_call_id, "call-0");
    return stream([{ reasoning_content: "PRIVATE_FINAL_PROTOCOL_DATA" }]);
  });
  if (enabled) {
    assert.equal(await sessions.chat("one", "执行合成步骤", () => {}), "可见正文");
    assert.deepEqual(executed, [0]); assert.equal(requests.length, 2);
  } else {
    await assert.rejects(() => sessions!.chat("one", "执行合成步骤", () => {}), /缺少 reasoning_content/);
    assert.deepEqual(executed, []); assert.equal(requests.length, 1);
  }
  const rows = await memory.readSession("one"), state = await engine.state("one");
  assert.doesNotMatch(JSON.stringify([rows, state]), /PRIVATE_FINAL_PROTOCOL_DATA|reasoning_compatibility/);
  assert.equal(state.usage.chat.requests, enabled ? 2 : 1);
  assert.equal(state.usage.chat.input_tokens, usage.prompt_tokens * requests.length);
  assert.equal(state.usage.chat.output_tokens, usage.completion_tokens * requests.length);
  assert.equal(sessions.locks.has("one"), false);
});
