/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelConfig } from "../core/model-config.ts";
import { probeModelCompatibility } from "../core/model-compatibility-probe.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const logger: any = { secrets: [], info() {}, warn() {}, error() {} };
const target = { id: "p", name: "synthetic", model: "synthetic-target", enabled: true, protocol: "openai-compatible",
  base_url: "https://target.invalid/v1", api_key: "SYNTHETIC_TARGET_KEY", timeout_seconds: 10, proxy_url: "", parameters: {},
  reasoning_compatibility: { fill_missing: true } };
const assistant = { ...target, model: "synthetic-helper", base_url: "https://helper.invalid/v1", api_key: "SYNTHETIC_HELPER_KEY" };
const rawUsage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, completion_tokens_details: { reasoning_tokens: 2 } };
const frame = (delta: any, finish_reason?: string) => ({ choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }] });
const tool = (id = "call-one", name = "whalelife_compat_probe", args = "{}") =>
  ({ index: 0, id, function: { name, arguments: args } });
function sse(frames: any[], usage: any = rawUsage) {
  const rows = [...frames, ...(usage === null ? [] : [{ choices: [], usage }])];
  return new Response(rows.map(row => "data: " + JSON.stringify(row) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}
const goodMapping = { response_field: "metadata.thought", request_field: "thought" };
function normal(round: number, body: any) {
  if (round === 0) return sse([frame({ metadata: { thought: "PRIVATE_SAMPLE_THINKING" }, tool_calls: [tool("sample-call")] }, "tool_calls")]);
  if (round === 1) return sse([frame({ content: JSON.stringify(goodMapping) }, "stop")]);
  if (round === 2) return sse([frame({ metadata: { thought: "PRIVATE_" } }), frame({ metadata: { thought: null } }),
    frame({ metadata: { thought: "VALIDATION_THINKING" }, tool_calls: [tool("validation-call")] }, "tool_calls")]);
  assert.equal(round, 3, "no extra paid request may be attempted");
  return sse([frame({ content: JSON.parse(body.messages.at(-1).content).code }, "stop")]);
}

test("AI proposes an observed mapping and real LLM request encoding verifies one isolated tool continuation", async t => {
  const requests: any[] = [], before = structuredClone({ target, assistant });
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    const body = JSON.parse(init.body), round = requests.length; requests.push({ url, body });
    assert.equal(body.max_tokens, 1024);
    assert.equal(Object.hasOwn(body, "reasoning_compatibility"), false);
    if (round === 1) {
      assert.equal(String(url), "https://helper.invalid/v1/chat/completions");
      assert.equal(body.tools, undefined);
      assert.doesNotMatch(JSON.stringify(body.messages), /PRIVATE_|SYNTHETIC_TARGET_KEY|SYNTHETIC_HELPER_KEY|target\.invalid|helper\.invalid/);
      assert.deepEqual(JSON.parse(body.messages[1].content).response_fields, [{ path: "metadata.thought", type: "string" }]);
      assert.equal(JSON.parse(body.messages[1].content).model, target.model);
      assert.equal(JSON.parse(body.messages[1].content).default_request_field, "reasoning_content");
    } else assert.equal(String(url), "https://target.invalid/v1/chat/completions");
    if (round === 3) {
      assert.equal(body.messages[1].thought, "PRIVATE_VALIDATION_THINKING");
      assert.equal(Object.hasOwn(body.messages[1], "reasoning_content"), false);
      assert.equal(body.messages[1].tool_calls[0].id, "validation-call");
      assert.equal(body.messages[2].tool_call_id, "validation-call");
      assert.equal(Object.hasOwn(body, "tool_choice"), false);
    }
    return normal(round, body);
  });
  const result = await probeModelCompatibility({ target, assistant, logger });
  assert.equal(result.verified, true); assert.equal(result.requests, 4);
  assert.deepEqual(result.compatibility, goodMapping);
  assert.deepEqual(result.usage, { requests: ["sample", "mapping", "tool", "continuation"].map(stage =>
    ({ stage, input_tokens: 10, output_tokens: 4, reasoning_tokens: 2 })), input_tokens: 40, output_tokens: 16 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|SYNTHETIC_TARGET_KEY|SYNTHETIC_HELPER_KEY/);
  assert.deepEqual({ target, assistant }, before);
});

test("a response reasoning alias does not imply an identically named request field", async t => {
  let calls = 0;
  const mapping = { response_field: "reasoning", request_field: "reasoning_content" };
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const round = calls++, body = JSON.parse(init.body);
    if (round === 0 || round === 2) return sse([frame({ reasoning: "PRIVATE_ALIAS_TEXT", tool_calls: [tool()] }, "tool_calls")]);
    if (round === 1) {
      assert.match(body.messages[0].content, /不能依据响应字段同名推断回传名称/);
      assert.match(body.messages[0].content, /request_field 保留 reasoning_content/);
      assert.deepEqual(JSON.parse(body.messages[1].content).response_fields, [{ path: "reasoning", type: "string" }]);
      return sse([frame({ content: JSON.stringify(mapping) }, "stop")]);
    }
    assert.equal(round, 3);
    assert.equal(body.messages[1].reasoning_content, "PRIVATE_ALIAS_TEXT");
    assert.equal(Object.hasOwn(body.messages[1], "reasoning"), false);
    return sse([frame({ content: JSON.parse(body.messages[2].content).code }, "stop")]);
  });
  const result = await probeModelCompatibility({ target, assistant, logger });
  assert.equal(result.verified, true); assert.equal(result.requests, 4);
  assert.deepEqual(result.compatibility, mapping);
});

test("rejected continuation reports its safe candidate and actual upstream HTTP status without a retry", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const round = calls++, body = JSON.parse(init.body);
    assert.ok(round <= 3);
    if (round !== 3) return normal(round, body);
    return new Response(JSON.stringify({ error: { message: "PRIVATE_BODY SYNTHETIC_TARGET_KEY missing reasoning_content must passed back" } }), { status: 400 });
  });
  const result = await probeModelCompatibility({ target, assistant, logger });
  assert.equal(result.verified, false); assert.equal(result.requests, 4);
  assert.equal(Object.hasOwn(result, "compatibility"), false);
  assert.deepEqual(result.diagnostic, { stage: "continuation", http_status: 400,
    reason: "思考模式要求回传完整 reasoning_content，请检查工具续轮协议", attempted_mapping: goodMapping });
  assert.match(result.message, /工具续轮验证失败.*HTTP 400.*读取 metadata\.thought，回传 thought/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|SYNTHETIC_TARGET_KEY|passed back/);
});

const invalid: { name: string; round: number; reply: (body: any) => Response; pattern: RegExp }[] = [
  { name: "missing thinking cannot be repaired by the draft's fill_missing option", round: 0,
    reply: () => sse([frame({ tool_calls: [tool()] }, "tool_calls")]), pattern: /未返回可映射/ },
  { name: "structured-only reasoning is not flattened into invented text", round: 0,
    reply: () => sse([frame({ reasoning_details: [{ type: "reasoning.encrypted", data: "OPAQUE" }], tool_calls: [tool()] }, "tool_calls")]), pattern: /结构化/ },
  { name: "a plain reply is not a tool protocol pass", round: 0,
    reply: () => sse([frame({ content: "OK" }, "stop")]), pattern: /唯一.*工具/ },
  { name: "unknown tools are never executed or reported successful", round: 0,
    reply: () => sse([frame({ metadata: { thought: "text" }, tool_calls: [tool("other", "send_message")] }, "tool_calls")]), pattern: /工具名称/ },
  { name: "nonempty tool arguments are not accepted as a successful probe", round: 0,
    reply: () => sse([frame({ metadata: { thought: "text" }, tool_calls: [tool("one", undefined, '{"side_effect":true}')] }, "tool_calls")]), pattern: /空对象/ },
  { name: "truncated responses stop without larger-budget retries", round: 0,
    reply: () => sse([frame({ metadata: { thought: "text" }, tool_calls: [tool()] }, "length")]), pattern: /截断/ },
  { name: "malformed mapping JSON is not executed", round: 1,
    reply: () => sse([frame({ content: "process.exit(0)" }, "stop")]), pattern: /有效 JSON/ },
  { name: "unobserved fields cannot be mapped", round: 1,
    reply: () => sse([frame({ content: JSON.stringify({ ...goodMapping, response_field: "not_observed" }) }, "stop")]), pattern: /未观察到/ },
  { name: "AI cannot enable force-empty mode", round: 1,
    reply: () => sse([frame({ content: JSON.stringify({ ...goodMapping, fill_missing: true }) }, "stop")]), pattern: /不支持的操作/ },
  { name: "AI cannot overwrite protocol fields", round: 1,
    reply: () => sse([frame({ content: JSON.stringify({ ...goodMapping, request_field: "tool_calls" }) }, "stop")]), pattern: /安全的文本/ },
  { name: "changed response schema fails validation instead of relying on old aliases", round: 2,
    reply: () => sse([frame({ reasoning_content: "some new schema", tool_calls: [tool()] }, "tool_calls")]), pattern: /重新请求/ },
  { name: "HTTP success without the exact tool result is not a pass", round: 3,
    reply: () => sse([frame({ content: "OK" }, "stop")]), pattern: /准确续接/ },
  { name: "an extra tool request is never executed", round: 3,
    reply: () => sse([frame({ tool_calls: [tool()] }, "tool_calls")]), pattern: /准确续接/ },
];
for (const sample of invalid) test(sample.name, async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const round = requests++, body = JSON.parse(init.body);
    assert.ok(round <= sample.round, "failure must not trigger another request");
    if (round === 3) assert.equal(Object.hasOwn(body, "tool_choice"), false,
      "continuation must use the same default tool selection as Sessions");
    return round === sample.round ? sample.reply(body) : normal(round, body);
  });
  const result = await probeModelCompatibility({ target, assistant, logger });
  assert.equal(result.verified, false); assert.equal(result.requests, sample.round + 1);
  assert.equal(requests, result.requests); assert.ok(requests <= 4);
  assert.equal(Object.hasOwn(result, "compatibility"), false); assert.match(result.message, sample.pattern);
});

test("missing usage stays unknown and protocol error text is never reflected to the UI", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: {
    message: "PRIVATE_RESPONSE SYNTHETIC_TARGET_KEY", type: "unexpected-provider-error" } }), { status: 400 }));
  const result = await probeModelCompatibility({ target, assistant, logger });
  assert.equal(result.requests, 1); assert.equal(result.usage.input_tokens, null); assert.equal(result.usage.output_tokens, null);
  assert.deepEqual(result.diagnostic, { stage: "sample", http_status: 400, reason: "接口未提供可安全识别的具体原因" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RESPONSE|SYNTHETIC_TARGET_KEY/);
});

for (const failure of [
  { status: 429, type: "rate_limit_error", message: "rate limit exceeded", expected: "服务请求频率受限" },
  { status: 429, type: "insufficient_quota", message: "insufficient quota", expected: "服务额度或余额不足" },
  { status: 401, type: "authentication_error", message: "invalid API key", expected: "服务拒绝了认证信息" },
]) test(`safe transport cause remains visible for ${failure.status} ${failure.type}`, async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ error: { type: failure.type,
      message: failure.message + " PRIVATE_PROVIDER_BODY SYNTHETIC_TARGET_KEY" } }), { status: failure.status });
  });
  const result = await probeModelCompatibility({ target, assistant, logger });
  assert.equal(result.verified, false); assert.equal(result.requests, 1); assert.equal(calls, 1);
  assert.equal(result.diagnostic?.http_status, failure.status);
  assert.equal(result.diagnostic?.reason, failure.expected + "；" + failure.type);
  assert.ok(result.message.includes(failure.expected));
  assert.equal(Object.hasOwn(result, "compatibility"), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_BODY|SYNTHETIC_TARGET_KEY/);
});

test("gateway MODEL_RATE_LIMITED busy envelope is reported as a failed probe without applying or retrying", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: "MODEL_RATE_LIMITED", type: "rate_limit_error",
      message: "The model is temporarily busy. Please try again later." } }), { status: 429 });
  });
  const result = await probeModelCompatibility({ target, assistant, logger });
  assert.equal(result.verified, false); assert.equal(result.requests, 1); assert.equal(calls, 1);
  assert.equal(result.diagnostic?.http_status, 429);
  assert.match(result.message, /模型服务繁忙/);
  assert.match(result.diagnostic?.reason ?? "", /模型服务繁忙/);
  assert.equal(Object.hasOwn(result, "compatibility"), false);
  assert.doesNotMatch(JSON.stringify(result), /The model is temporarily busy/);
});

test("an omitted usage report does not turn into zero or a misleading complete total", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const round = calls++, body = JSON.parse(init.body);
    if (round === 1) return sse([frame({ content: JSON.stringify(goodMapping) }, "stop")], null);
    return normal(round, body);
  });
  const result = await probeModelCompatibility({ target, assistant, logger });
  assert.equal(result.verified, true); assert.equal(result.usage.input_tokens, null); assert.equal(result.usage.output_tokens, null);
  assert.deepEqual(result.usage.requests[1], { stage: "mapping" });
});

test("pre-cancelled diagnostics perform no request", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw Error("must not fetch"); });
  const result = await probeModelCompatibility({ target, assistant, logger, signal: AbortSignal.abort() });
  assert.equal(result.verified, false); assert.equal(result.requests, 0); assert.match(result.message, /取消/);
});

test("manager uses saved credentials safely, leaves configuration untouched and releases the concurrent probe lock on cancellation", async t => {
  const root = await temporaryDirectory("whale-compatibility-probe-"); await mkdir(join(root, "config"));
  const config: any = { providers: [target, { ...assistant, id: "helper" }],
    models: [{ id: "target-model", name: "target", provider: "p", model: target.model, type: "chat", enabled: true, parameters: {}, reasoning_compatibility: { fill_missing: true } },
      { id: "helper-model", name: "helper", provider: "helper", model: assistant.model, type: "chat", enabled: true, parameters: {} }],
    model_bindings: { chat: "target-model" }, personas: {}, channels: { web: {} } };
  const file = join(root, "config/config.json"); await writeFile(file, JSON.stringify(config));
  const original = await readFile(file, "utf8"), manager = new ModelConfig(root, config, logger);
  const input = { provider: { ...manager.snapshot().providers[0], api_key: "" }, model: manager.snapshot().models[0], assistantModelId: "helper-model" };
  let ready!: () => void;
  const started = new Promise<void>(resolve => ready = resolve), controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    assert.equal(init.headers.Authorization, "Bearer SYNTHETIC_TARGET_KEY"); ready();
    return await new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  const pending = manager.probeCompatibility(input, controller.signal); await started;
  await assert.rejects(manager.probeCompatibility(input), (error: any) => error.status === 409);
  controller.abort(); const cancelled = await pending;
  assert.equal(cancelled.verified, false); assert.match(cancelled.message, /取消/);
  assert.equal(await readFile(file, "utf8"), original);
  const again = await manager.probeCompatibility(input, AbortSignal.abort());
  assert.equal(again.requests, 0); assert.equal(await readFile(file, "utf8"), original);
  await assert.rejects(manager.probeCompatibility({ ...input, assistantModelId: "missing" }), /选择/);
});
