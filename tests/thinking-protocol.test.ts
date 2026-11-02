import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { LLM } from "../core/llm.ts";
import { renderHistory, historyTail } from "../core/provenance.ts";
import { estimateTokens } from "../core/memory-engine.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

function sse(response: ServerResponse, reasoning: string | undefined, tool: any, text: string, prompt = 40) {
  const frames: any[] = [];
  if (reasoning !== undefined) {
    const half = Math.floor(reasoning.length / 2);
    frames.push({ reasoning_content: reasoning.slice(0, half) }, { reasoning_content: reasoning.slice(half) });
  }
  if (tool) {
    frames.push({ tool_calls: [{ index: 0, id: tool.id, function: { name: tool.name, arguments: '{"text":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.text) + "}" } }] });
  }
  if (text) frames.push({ content: text });
  const wire = frames.map(delta => "data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\n").join("") +
    "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: 7 } }) + "\n\ndata: [DONE]\n\n";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const bytes = Buffer.from(wire);
  for (let i = 0; i < bytes.length; i += 17) response.write(bytes.subarray(i, i + 17));
  response.end();
}

async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-thinking-protocol-");
  const requests: any[] = [], violations: string[] = [];
  let app: any, omitReasoning = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const thinking = body.thinking?.type !== "disabled", tools = !!body.tools?.length;
    const assistants = body.messages.filter((x: any) => x.role === "assistant");
    const reasoning = (n: number) => "PRIVATE_PROTOCOL_REASONING_" + n + "鲸";
    if (thinking && tools && (body.messages.at(-1).role === "system" ||
      assistants.some((x: any, i: number) => x.reasoning_content !== reasoning(i)))) {
      violations.push("missing reasoning or missing turn boundary");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "The reasoning_content in the thinking mode must be passed back to the API." } }));
      return;
    }
    const quiet = body.messages.some((x: any) => x.content?.includes("case-quiet"));
    const round = assistants.length;
    const tool = tools && round < 2 ? { id: "call_" + round, name: quiet ? "protocol_quiet" : "protocol_record", text: "真实决定" + round } : null;
    sse(res, thinking && !omitReasoning ? reasoning(round) : undefined, tool, tool ? "" : "最终回答", 40 + round);
  });
  t.after(async () => { await app?.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  await mkdir(join(root, "config"));
  await mkdir(join(root, "plugins/protocol-probe"), { recursive: true });
  await writeFile(join(root, "plugins/protocol-probe/plugin.yaml"), 'id: protocol-probe\nname: Protocol probe\nversion: 1.0.0\ndescription: Isolated protocol test\napiVersion: "1"\n');
  await writeFile(join(root, "plugins/protocol-probe/index.ts"), `export function apply(ctx) {
    let controller, channel;
    const delivered = [];
    for (const name of ['protocol_record', 'protocol_quiet']) ctx.tools.register({ name, description: 'Synthetic record', danger: 'safe', schema: { text: { type: 'string' } },
      async run(args, session) {
        await ctx.memory.recordExperience(session.id, { event_id: args.text, outcome: 'succeeded', text: args.text, origin: { action: '实际判断' } });
        if (name === 'protocol_quiet') controller.abort(Error('explicit-finish'));
        return { recorded: true };
      } });
    ctx.provide('protocol-probe', {
      run: input => ctx.sessions.run(input), transient: input => ctx.sessions.runTransient(input),
      async capture(input) {
        const chunks = [];
        const text = await ctx.sessions.runTransient({ ...input, onChunk: chunk => { chunks.push(chunk); } });
        return { text, chunks };
      },
      async channel(text) {
        channel ??= ctx.channels.register({ id: 'protocol', account: 'test', persona: 'p', permission: 'full',
          send: async message => { delivered.push(message.text); } });
        await channel.bind('peer', await ctx.sessions.current());
        const result = await channel.receive({ peer: 'peer', sender: 'synthetic-user', messageId: 'message-1', text });
        return { result, delivered };
      },
      async quiet(text) {
        controller = new AbortController();
        try { return await ctx.sessions.runTransient({ text, signal: controller.signal }); }
        catch (error) { return { cancelled: controller.signal.aborted, error: error.message }; }
        finally { controller = undefined; }
      },
    });
  }`);
  await writeFile(join(root, "p.md"), "人格协议测试标记，保留来源。");
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "error" }, web: { port: 0 },
    providers: [{ id: "test", base_url: base, api_key: "synthetic-secret" }],
    models: [{ id: "chat", provider: "test", name: "Protocol", model: "deepseek-flash", type: "chat", enabled: true,
      context_window: 32000, parameters: { thinking: { type: "enabled" }, reasoning_effort: "high" } }],
    model_bindings: { chat: "chat" }, personas: { p: { name: "P", file: "p.md", permission: "full" } },
    channels: { web: { persona: "p", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  const id = await app.sessions.current(), api = app.runtime.services.get("protocol-probe").value;
  return { app, id, api, requests, violations, base, omit: () => { omitReasoning = true; } };
}

for (const history of [false, true]) test(`thinking transient full HTTP tool chain with ${history ? "legacy completed" : "empty"} history`, async t => {
  const f = await fixture(t), trigger = "case-trigger-ephemeral";
  if (history) {
    await f.app.memory.appendEvent({ session: f.id, type: "message", role: "user", text: "真实用户历史", channel: "web" });
    await f.app.memory.appendEvent({ session: f.id, type: "message", role: "assistant", text: "过去的最终回答", channel: "web" });
  }
  const original = await f.app.memory.readSession(f.id);
  await f.app.memoryEngine.saveLocalFacts(f.id, "事实协议标记");
  const captured = await f.api.capture({ text: trigger, origin: { action: "临时检查" } });
  assert.equal(captured.text, "最终回答");
  assert.deepEqual(f.violations, []);
  assert.equal(f.requests.length, 3);
  const first = f.requests[0];
  assert.equal(first.messages.at(-1).role, "user");
  assert.match(first.messages.at(-1).content, /不是真人发言/);
  assert.match(first.messages.at(-1).content, /protocol-probe/);
  assert.match(JSON.stringify(first), /人格协议测试标记/);
  assert.match(JSON.stringify(first), /事实协议标记/);
  if (history) {
    assert.equal(first.messages.some((x: any) => x.role === "assistant"), false);
    const reference = first.messages.find((x: any) => x.content?.startsWith("【历史对话引用"));
    assert.match(reference.content, /真实用户历史/);
    assert.match(reference.content, /过去的最终回答/);
    assert.match(reference.content, /assistant/);
  }
  assert.deepEqual(captured.chunks, ["最终回答"]);
  for (const [round, body] of f.requests.entries()) {
    assert.equal(body.thinking.type, "enabled");
    assert.equal(body.reasoning_effort, "high");
    assert.ok(body.messages.some((x: any) => x.content?.includes(trigger)));
    assert.equal(body.messages.filter((x: any) => x.reasoning_content !== undefined).length, round);
  }
  const rows = await f.app.memory.readSession(f.id), state = await f.app.memoryEngine.state(f.id);
  assert.deepEqual(rows.slice(0, original.length), original);
  assert.equal(JSON.stringify([rows, state]).includes(trigger), false);
  assert.equal(JSON.stringify([rows, state]).includes("PRIVATE_PROTOCOL_REASONING"), false);
  assert.ok(state.records.some((x: any) => x.text === "真实决定0" && x.origin.plugin === "protocol-probe"));
  assert.equal(state.usage.chat.requests, 3);
  assert.equal(state.usage.chat.input_tokens, 123);
  assert.equal((await f.app.sessions.contextStatus(f.id)).usage.used_tokens, 49);
  assert.equal(f.app.logger.lines.some((x: string) => x.includes("PRIVATE_PROTOCOL_REASONING")), false);
  await f.api.run({ text: "正常新问题" });
  assert.equal(f.requests.length, 6);
  assert.equal(JSON.stringify(f.requests.slice(3)).includes(trigger), false);
  assert.equal((await f.app.memory.readSession(f.id)).filter((x: any) => x.role === "user").length, original.filter((x: any) => x.role === "user").length + 1);
  assert.deepEqual(f.violations, []);
});

test("actual HTTP reasoning stream remains protocol-only during plugin explicit-end cancellation", async t => {
  const f = await fixture(t);
  const result = await f.api.quiet("case-quiet");
  assert.deepEqual(result, { cancelled: true, error: "explicit-finish" });
  assert.equal(f.requests.length, 1);
  const state = await f.app.memoryEngine.state(f.id), rows = await f.app.memory.readSession(f.id);
  assert.ok(state.records.some((x: any) => x.text === "真实决定0"));
  assert.equal(state.usage.chat.requests, 1);
  assert.equal(rows.some((x: any) => x.type === "message"), false);
  assert.equal(JSON.stringify([rows, state]).includes("PRIVATE_PROTOCOL_REASONING"), false);
  assert.equal(f.app.sessions.locks.has(f.id), false);
});

test("missing required reasoning is diagnosed before a tool side effect, without a retry or fabricated value", async t => {
  const f = await fixture(t);
  f.omit();
  await assert.rejects(f.api.transient({ text: "case-missing" }), /缺少 reasoning_content/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual((await f.app.memoryEngine.state(f.id)).records, []);
  assert.equal(f.app.sessions.locks.has(f.id), false);
});

test("disabled thinking and tool-free calls preserve ordinary historical roles and configured settings", async t => {
  const f = await fixture(t);
  await f.app.memory.appendEvent({ session: f.id, type: "message", role: "assistant", text: "真实旧回答" });
  f.app.config.models[0].parameters.thinking.type = "disabled";
  await f.api.transient({ text: "case-disabled" });
  assert.equal(f.requests[0].thinking.type, "disabled");
  assert.ok(f.requests[0].messages.some((x: any) => x.role === "assistant" && x.content.includes("真实旧回答")));
  f.app.config.models[0].parameters.thinking.type = "enabled";
  const start = f.requests.length;
  await f.api.transient({ text: "case-no-tools", permission: "off" });
  assert.equal(f.requests.length, start + 1);
  assert.equal(f.requests[start].tools, undefined);
  assert.ok(f.requests[start].messages.some((x: any) => x.role === "assistant" && x.content.includes("真实旧回答")));
});

test("raw LLM exposes real reasoning for caller-managed tools but never streams it as final text", async t => {
  const f = await fixture(t), chunks: string[] = [];
  const llm = new LLM({ info() {}, error() {} } as any);
  const reply = await llm.chat({ provider: { model: "deepseek-flash", base_url: f.base, parameters: { thinking: { type: "enabled" } } },
    messages: [{ role: "user", content: "synthetic raw" }], onChunk: (s: string) => chunks.push(s) });
  assert.equal(reply.reasoning_content, "PRIVATE_PROTOCOL_REASONING_0鲸");
  assert.deepEqual(chunks, ["最终回答"]);
  assert.equal(reply.text, "最终回答");
});

test("Web and a synthetic registered channel retain normal message, stream, receipt and reasoning-tool behavior", async t => {
  const f = await fixture(t), chunks: string[] = [];
  await f.app.channels.web(f.id, "普通Web问题", (text: string) => chunks.push(text));
  assert.deepEqual(chunks, ["最终回答"]);
  const sent = await f.api.channel("普通渠道问题");
  assert.equal(sent.result.status, "sent");
  assert.deepEqual(sent.delivered, ["最终回答"]);
  const rows = await f.app.memory.readSession(f.id);
  assert.ok(rows.some((x: any) => x.role === "user" && x.text === "普通Web问题" && x.channel === "web"));
  assert.ok(rows.some((x: any) => x.role === "user" && x.text === "普通渠道问题" && x.channel === "protocol"));
  assert.equal(f.requests.length, 6);
  assert.deepEqual(f.violations, []);
  assert.equal(JSON.stringify(rows).includes("PRIVATE_PROTOCOL_REASONING"), false);
});

test("quoted history trimming accounts for JSON escaping and source labels", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: '历史"引用"\\\n🐋'.repeat(8),
    origin: { channel: "test" }, ts: "2026-01-01T00:00:00Z" }));
  for (const budget of [500, 1000, 4000]) {
    const fitted = historyTail(rows, budget, estimateTokens, 0, "Asia/Shanghai", true);
    const actual = estimateTokens(JSON.stringify(renderHistory(fitted.rows, "Asia/Shanghai", true)));
    assert.ok(actual <= budget, `${actual} > ${budget}`);
    assert.ok(fitted.tokens >= actual);
  }
});
