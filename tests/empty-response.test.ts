import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { EmptyModelResponseError } from "../core/model-response-error.ts";
import { TOOL_TEXT_NOTICE } from "../core/tool-protocol-text.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

type Reply = { text?: string | string[]; reasoning?: string; finish?: string; tool?: true | string; done?: false };
const privateThought = "SYNTHETIC_PRIVATE_THOUGHT_NOT_HISTORY";
function respond(res: ServerResponse, reply: Reply) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const parts = Array.isArray(reply.text) ? reply.text : [reply.text];
  for (const content of parts.slice(0, -1)) {
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + "\n\n");
  }
  const content = parts.at(-1);
  const delta = { ...(content === undefined ? {} : { content }),
    ...(reply.reasoning === undefined ? {} : { reasoning_content: reply.reasoning }),
    ...(reply.tool ? { tool_calls: [{ index: 0, id: "action-1", type: "function",
      function: { name: reply.tool === true ? "perform_once" : reply.tool, arguments: "{}" } }] } : {}) };
  res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: reply.finish ?? "stop" }],
    usage: { prompt_tokens: 43, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 7 } } }) +
    (reply.done === false ? "\n\n" : "\n\ndata: [DONE]\n\n"));
}
async function fixture(t: TestContext, replies: Reply[], permission: "full" | "off" = "full") {
  const root = await temporaryDirectory("whale-empty-response-");
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    respond(res, replies[requests.length - 1] ?? { text: "unexpected extra request" });
  });
  t.after(async () => { await app?.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "test", base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`, api_key: "synthetic-secret" }],
    models: [{ id: "chat", provider: "test", model: "synthetic-thinking", type: "chat", enabled: true,
      context_window: 32000, parameters: { max_tokens: 700, thinking: { type: "enabled" } } }],
    model_bindings: { chat: "chat" }, personas: { p: { name: "P", file: "p.md", permission: "full" } },
    channels: { web: { persona: "p", permission } }, memory: { root: "memory", diary_enabled: false },
  }));
  app = await boot(root);
  const id = await app.sessions.current();
  let actions = 0;
  app.tools.register({ name: "perform_once", description: "Synthetic action", schema: {}, danger: "safe",
    run() { actions++; return { completed: true }; } });
  return { app, id, root, requests, actions: () => actions,
    chat: (text = "合成测试请求", onChunk: (chunk: string) => void = () => {}) => app!.sessions.chat(id, text, onChunk) };
}

for (const [finish, reason, expected] of [
  ["length", "output_limit", /输出或上下文上限/],
  ["content_filter", "content_filtered", /过滤/],
  ["insufficient_system_resource", "service_unavailable", /资源不足/],
  ["aborted", "generation_aborted", /中止/],
  ["stop", "reasoning_only", /仅返回思考内容/],
] as const) {
  test(`empty final response reports ${reason} without retry, losing usage or saving thoughts`, async t => {
    const f = await fixture(t, [{ text: "", reasoning: privateThought, finish }]);
    await assert.rejects(f.chat(), (error: any) => {
      assert.ok(error instanceof EmptyModelResponseError);
      assert.equal(error.reason, reason); assert.match(error.message, expected);
      assert.doesNotMatch(error.message, new RegExp(privateThought)); return true;
    });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].max_tokens, 700);
    const usage = (await f.app.memoryEngine.state(f.id)).usage.chat;
    assert.equal(usage.requests, 1); assert.equal(usage.input_tokens, 43); assert.equal(usage.output_tokens, 9);
    const rows = await f.app.memory.readSession(f.id);
    assert.equal(rows.filter((row: any) => row.type === "message" && row.role === "assistant").length, 0);
    assert.equal(rows.filter((row: any) => row.type === "message" && row.role === "user").length, 1);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(privateThought));
  });
}

test("whitespace-only output fails without creating an empty assistant history record", async t => {
  const f = await fixture(t, [{ text: " \n\t ", finish: "stop" }]);
  await assert.rejects(f.chat(), (error: any) => error instanceof EmptyModelResponseError && error.reason === "empty");
  assert.equal(f.requests.length, 1);
  const rows = await f.app.memory.readSession(f.id);
  assert.equal(rows.filter((row: any) => row.type === "message" && row.role === "assistant").length, 0);
});

test("an already performed tool stays performed once when final thinking consumes the output allowance", async t => {
  const f = await fixture(t, [
    { reasoning: privateThought, tool: true, finish: "tool_calls" },
    { reasoning: privateThought, text: "", finish: "length" },
  ]);
  await assert.rejects(f.chat(), /输出或上下文上限/);
  assert.equal(f.actions(), 1); assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].messages.some((row: any) => row.role === "tool" && row.tool_call_id === "action-1"));
  assert.equal((await f.app.memoryEngine.state(f.id)).usage.chat.requests, 2);
  const files = await readdir(join(f.root, "logs/executions", f.id));
  const trace = await readFile(join(f.root, "logs/executions", f.id, files[0]), "utf8");
  assert.match(trace, /output|输出或上下文上限/);
  assert.doesNotMatch(trace, new RegExp(privateThought));
});

test("nonempty responses keep their content and request count, including length-ended partial text", async t => {
  const f = await fixture(t, [{ text: " 可用正文 ", reasoning: privateThought, finish: "length" }]);
  assert.equal(await f.chat(), " 可用正文 ");
  assert.equal(f.requests.length, 1);
  const rows = await f.app.memory.readSession(f.id);
  assert.equal(rows.filter((row: any) => row.type === "message" && row.role === "assistant").at(-1)?.text, " 可用正文 ");
});

test("unknown finish labels and provider fields cannot enter the diagnostic", () => {
  const error = new EmptyModelResponseError("PRIVATE_PROVIDER_VALUE");
  assert.equal(error.reason, "empty");
  assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_PROVIDER_VALUE/);
});

function dsmlCall(name = "perform_once", bars = "｜｜") {
  const prefix = bars + "DSML" + bars;
  return [
    `<${prefix}tool_calls>`,
    `<${prefix}invoke name="${name}">`,
    `<${prefix}parameter name="label" string="true">SYNTHETIC_DSML_ARGUMENT</${prefix}parameter>`,
    `</${prefix}invoke>`,
    `</${prefix}tool_calls>`,
  ].join("\n");
}

const wrappedCall = dsmlCall();
const withoutOpener = wrappedCall.split("\n").slice(1).join("\n");
const standaloneInvoke = withoutOpener.split("\n").slice(0, -1).join("\n");
const misspelledOpener = wrappedCall.replace("tool_calls>", "toolcalls>");

for (const [shape, block] of [
  ["canonical wrapper", wrappedCall],
  ["standalone invoke", standaloneInvoke],
  ["missing opener with a closing tag", withoutOpener],
  ["toolcalls opener with a tool_calls closer", misspelledOpener],
]) {
  test(`text-only DSML (${shape}) after a real tool call stays out of delivery and subsequent history`, async t => {
    const preface = "我来处理。\n";
    const before = "结果已返回。\r\n```js\r\nconst ok = true;\r\n```\r\n";
    const after = "\n这是结果说明。  ";
    const f = await fixture(t, [
      { text: preface, reasoning: privateThought, tool: true, finish: "tool_calls" },
      { text: [before, ...block, after] }, // Split even the opening and closing delimiters.
      { text: ["后", "续", "正常。"] },
    ]);
    const chunks: string[] = [];
    const result = await f.chat("请完成合成测试动作。", chunk => chunks.push(chunk));
    assert.equal(result, before + TOOL_TEXT_NOTICE + after);
    assert.equal(chunks.join(""), preface + result);
    assert.equal(f.actions(), 1);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].messages.find((row: any) => row.tool_calls)?.content, preface);
    const rows = await f.app.memory.readSession(f.id);
    assert.deepEqual(rows.filter((row: any) => row.role === "assistant").map((row: any) => row.text), [result]);
    const assistant = rows.find((row: any) => row.role === "assistant");
    assert.equal(assistant.tool_protocol_original, before + block + after);
    assert.equal(rows.filter((row: any) => row.type === "tool" && row.name === "perform_once").length, 1);

    const nextChunks: string[] = [];
    assert.equal(await f.chat("继续聊天。", chunk => nextChunks.push(chunk)), "后续正常。");
    assert.deepEqual(nextChunks, ["后", "续", "正常。"]);
    const nextContext = JSON.stringify(f.requests[2].messages);
    assert.ok(nextContext.includes(TOOL_TEXT_NOTICE));
    assert.doesNotMatch(nextContext, /DSML|SYNTHETIC_DSML_ARGUMENT/);
    assert.equal(f.requests.length, 3);
    assert.equal(f.actions(), 1);
  });
}

test("structured calls execute once and preserve literal content even when the structured field arrives last", async t => {
  const example = [wrappedCall, standaloneInvoke, misspelledOpener].join("\n");
  const f = await fixture(t, [
    { text: [...example, ""], reasoning: privateThought, tool: true, finish: "tool_calls" },
    { text: "已完成。" },
  ]);
  const chunks: string[] = [];
  assert.equal(await f.chat(undefined, chunk => chunks.push(chunk)), "已完成。");
  assert.equal(chunks.join(""), example + "已完成。");
  const structured = f.requests[1].messages.find((row: any) => row.tool_calls);
  assert.equal(structured.content, example);
  assert.equal(structured.tool_calls.length, 1);
  assert.equal(f.actions(), 1);
  assert.equal(f.requests.length, 2);
});

test("legitimate DSML examples, incomplete markup and short responses survive fragmented streams", async t => {
  const example = dsmlCall("perform_once", "｜");
  const cases = [
    { prompt: "写一句话。", text: "短句。" },
    { prompt: "再写一句。", text: "小于号 <" },
    { prompt: "继续。", text: "<｜D" },
    { prompt: "继续。", text: example.slice(0, example.lastIndexOf("</")) },
    { prompt: "继续。", text: dsmlCall("unavailable_test_tool") },
    { prompt: "继续。", text: ["前文", "```xml", example, withoutOpener, misspelledOpener, "```", "后文"].join("\n") },
    { prompt: "请逐字展示 DSML 工具调用的代码示例。", text: [example, standaloneInvoke, withoutOpener, misspelledOpener].join("\n\n") },
  ];
  const nextText = [example, "处理下一项。", standaloneInvoke, "最后一项。", misspelledOpener].join("\n");
  const f = await fixture(t, [...cases.map(({ text }) => ({ text: [...text] })), { text: [...nextText] }]);
  for (const { prompt, text } of cases) {
    const chunks: string[] = [];
    assert.equal(await f.chat(prompt, chunk => chunks.push(chunk)), text);
    assert.equal(chunks.join(""), text);
  }
  const rows = await f.app.memory.readSession(f.id);
  assert.deepEqual(rows.filter((row: any) => row.role === "assistant").map((row: any) => row.text), cases.map(c => c.text));
  // The earlier request for literal examples does not authorize showing a leaked block in the next turn.
  const chunks: string[] = [];
  const notice = await f.chat("完成今天的合成任务。", chunk => chunks.push(chunk));
  assert.equal(notice, [TOOL_TEXT_NOTICE, "处理下一项。", TOOL_TEXT_NOTICE, "最后一项。", TOOL_TEXT_NOTICE].join("\n"));
  assert.equal(chunks.join(""), notice);
  assert.equal(f.actions(), 0);
  assert.equal(f.requests.length, cases.length + 1);
});

test("a session that offered no tools preserves a literal call naming a registered tool", async t => {
  const example = [wrappedCall, standaloneInvoke, withoutOpener, misspelledOpener].join("\n\n");
  const f = await fixture(t, [{ text: [...example] }], "off");
  const chunks: string[] = [];
  assert.equal(await f.chat(undefined, chunk => chunks.push(chunk)), example);
  assert.equal(chunks.join(""), example);
  assert.equal(f.requests[0].tools, undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(f.actions(), 0);
});

test("asking to stop showing DSML markers still protects the reply", async t => {
  const f = await fixture(t, [{ text: [...dsmlCall()] }]);
  const chunks: string[] = [];
  const result = await f.chat("别再发 DSML 标记了，继续处理。", chunk => chunks.push(chunk));
  assert.match(result, /标记|工具调用文本/);
  assert.doesNotMatch(result, /DSML|SYNTHETIC_DSML_ARGUMENT/);
  assert.equal(chunks.join(""), result);
  assert.equal(f.actions(), 0);
  assert.equal(f.requests.length, 1);
});

test("a stream interrupted after a potential protocol block keeps ordinary prose and reports the interruption", async t => {
  const before = "我开始处理了。\n";
  const f = await fixture(t, [{ text: [before, ...dsmlCall()], done: false }]);
  const chunks: string[] = [];
  await assert.rejects(f.chat(undefined, chunk => chunks.push(chunk)), /模型流意外中断/);
  const delivered = chunks.join("");
  assert.ok(delivered.startsWith(before));
  assert.doesNotMatch(delivered, /DSML|SYNTHETIC_DSML_ARGUMENT|perform_once/);
  const rows = await f.app.memory.readSession(f.id);
  assert.equal(rows.filter((row: any) => row.role === "assistant" || row.type === "tool").length, 0);
  assert.equal(f.actions(), 0);
  assert.equal(f.requests.length, 1);
});

test("technical inputs and turns with transient tools keep leaked protocol arguments out of stored records", async t => {
  const example = dsmlCall();
  const f = await fixture(t, [
    { tool: "read_sample", reasoning: privateThought, finish: "tool_calls" },
    { text: [...example] }, { text: [...example] },
  ]);
  f.app.tools.registerTransient({ name: "read_sample", schema: {}, description: "Synthetic input", danger: "safe",
    run() { return { content: "SYNTHETIC_TRANSIENT_RESULT", receipt: { read: true } }; } });
  const userResult = await f.chat();
  assert.match(userResult, /标记|工具调用文本/);
  assert.match(JSON.stringify(f.requests[1].messages), /SYNTHETIC_TRANSIENT_RESULT/);
  const technicalResult = await f.app.sessions.chat(f.id, "内部合成输入", () => {}, undefined, undefined, undefined, true);
  assert.match(technicalResult, /标记|工具调用文本/);
  const rows = await f.app.memory.readSession(f.id);
  assert.doesNotMatch(JSON.stringify(rows), /tool_protocol_original|SYNTHETIC_DSML_ARGUMENT|SYNTHETIC_TRANSIENT_RESULT/);
  assert.doesNotMatch(JSON.stringify(f.requests[2].messages), /SYNTHETIC_DSML_ARGUMENT|SYNTHETIC_TRANSIENT_RESULT/);
  assert.equal(f.actions(), 0);
  assert.equal(f.requests.length, 3);
});
