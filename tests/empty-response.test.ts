import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { EmptyModelResponseError } from "../core/model-response-error.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

type Reply = { text?: string; reasoning?: string; finish?: string; tool?: boolean };
const privateThought = "SYNTHETIC_PRIVATE_THOUGHT_NOT_HISTORY";
function respond(res: ServerResponse, reply: Reply) {
  const delta = { ...(reply.text === undefined ? {} : { content: reply.text }),
    ...(reply.reasoning === undefined ? {} : { reasoning_content: reply.reasoning }),
    ...(reply.tool ? { tool_calls: [{ index: 0, id: "action-1", type: "function",
      function: { name: "perform_once", arguments: "{}" } }] } : {}) };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: reply.finish ?? "stop" }],
    usage: { prompt_tokens: 43, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 7 } } }) +
    "\n\ndata: [DONE]\n\n");
}
async function fixture(t: TestContext, replies: Reply[]) {
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
    channels: { web: { persona: "p", permission: "full" } }, memory: { root: "memory", diary_enabled: false },
  }));
  app = await boot(root);
  const id = await app.sessions.current();
  let actions = 0;
  app.tools.register({ name: "perform_once", description: "Synthetic action", schema: {}, danger: "safe",
    run() { actions++; return { completed: true }; } });
  return { app, id, root, requests, actions: () => actions,
    chat: () => app!.sessions.chat(id, "合成测试请求", () => {}) };
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
