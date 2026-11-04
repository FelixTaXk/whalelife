import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { temporaryDirectory } from "./temporary-directory.ts";
import { toolContentSnapshot, promptText, TOOL_CONTENT_LIMITS } from "../core/tool-content.ts";
import { TRANSIENT_REPLY } from "../core/tool-retention.ts";
import type { Context, MultimodalToolOutput, ChatOptions } from "whalelife";

const foreign = "SYNTHETIC_PRIVATE_VISUAL_TEXT";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ/gAAAAASUVORK5CYII=", "base64");
const image = (data = png) => ({ type: "image" as const, mimeType: "image/png" as const, data });
const call = (name: string, args: any = {}, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function sse(res: ServerResponse, text = "", calls: any[] = [], usage: any = { prompt_tokens: 900, completion_tokens: 11 }) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = { content: text, reasoning_content: "SYNTHETIC_PROTOCOL_REASONING", tool_calls: calls.map((c, index) => ({ index, ...c })) };
  res.end("data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\ndata: " + JSON.stringify({ choices: [], ...(usage ? { usage } : {}) }) + "\n\ndata: [DONE]\n\n");
}
async function diskText(root: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    text += entry.isDirectory() ? await diskText(path) : await readFile(path, "utf8");
  }
  return text;
}
async function fixture(t: TestContext) {
  const root = await temporaryDirectory("whale-multimodal-");
  const requests: any[] = [], events: any[] = [], failures: unknown[] = [];
  let app: any, respond = (body: any, res: ServerResponse) => sse(res, "普通回答");
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body); respond(body, res);
    } catch (error) { failures.push(error); res.writeHead(500); res.end(); }
  });
  t.after(async () => { await app?.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); assert.deepEqual(failures, []); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  await mkdir(join(root, "config"));
  await mkdir(join(root, "plugins/pictures"), { recursive: true });
  await writeFile(join(root, "plugins/pictures/plugin.yaml"), 'id: pictures\nname: Synthetic pictures\nversion: 1.0.0\ndescription: Isolated multimodal fixture\napiVersion: "1"\n');
  await writeFile(join(root, "plugins/pictures/index.ts"), `export function apply(ctx) {
    let waiting = false;
    const png = Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64');
    ctx.tools.registerMultimodal({ name: 'view_media', description: 'View synthetic image', schema: { type: 'object', properties: {} }, danger: 'safe', origin: { platform: 'synthetic-source', action: '查看资料' },
      async run(args, session) {
        if (args.wait) { waiting = true; await new Promise(r => session.signal.addEventListener('abort', r, { once: true })); }
        if (args.expired) return { content: [{ type: 'text', text: '引用已过期，未读取资料' }], receipt: null };
        const data = args.large ? Buffer.concat([png, Buffer.alloc(120000)]) : png;
        const part = args.invalid ? { type: 'image', mimeType: 'image/png', data: Buffer.from('invalid') }
          : { type: 'image', mimeType: 'image/png', data, detail: 'low' };
        return { content: [{ type: 'text', text: ${JSON.stringify(foreign)} + ':' + session.id + '; frame 00:01.250' }, ...Array.from({ length: args.count || 1 }, () => part)],
          receipt: { action: 'view', count: args.count || 1 } };
      } });
    ctx.tools.register({ name: 'plain_echo', description: 'Old tool', schema: { text: { type: 'string' } }, danger: 'safe', run: args => args });
    ctx.provide('pictures', { supported: () => typeof ctx.tools.registerMultimodal === 'function', waiting: () => waiting,
      run: input => ctx.sessions.run(input), call: (args, id) => ctx.tools.call('view_media', args, { id, permission: 'full' }) });
  }`);
  await writeFile(join(root, "p.md"), "SYNTHETIC_PERSONA_STAYS_THE_SAME");
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    log: { level: "info" }, web: { port: 0 }, providers: [{ id: "provider", base_url: base, api_key: "synthetic-key" }],
    models: [{ id: "chat", provider: "provider", model: "custom-vision-model", type: "chat", enabled: true,
      context_window: 32000, parameters: { thinking: { type: "enabled" } } }],
    model_bindings: { chat: "chat" }, personas: { p: { name: "P", file: "p.md", permission: "full" } },
    channels: { web: { persona: "p", permission: "full" } }, memory: { root: "memory", budget_tokens: 6000 },
  }));
  app = await boot(root);
  app.runtime.events.on("tool/called", (event: any) => events.push(event));
  const id = await app.sessions.current();
  const clean = async () => {
    await app.runtime.events.drain();
    for (const text of [JSON.stringify(events), await diskText(join(root, "memory")), await diskText(join(root, "logs"))]) {
      for (const marker of [foreign, png.toString("base64"), "SYNTHETIC_PROTOCOL_REASONING", "data:image/"])
        assert.ok(!text.includes(marker), "temporary body must not persist: " + marker.slice(0, 30));
    }
  };
  return { app, id, requests, events, clean, api: () => app.runtime.services.get("pictures").value,
    model: (fn: typeof respond) => { respond = fn; } };
}
const hasMedia = (body: any) => body.messages.some((m: any) => Array.isArray(m.content));
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, "condition must become true"); await new Promise(r => setTimeout(r, 10)); }
}

test("HTTP/SSE sees real images after complete tool batch; same model/persona/reasoning, receipts and usage survive", async t => {
  const f = await fixture(t);
  assert.equal(await f.api().supported(), true);
  f.model((body, res) => {
    const rounds = body.messages.filter((m: any) => m.role === "assistant").length;
    sse(res, rounds === 2 ? foreign : "", rounds === 0 ? [call("view_media", { large: true }), call("plain_echo", { text: "ordinary" })]
      : rounds === 1 ? [call("plain_echo", { text: foreign }), call("remember_fact", { text: foreign })] : []);
  });
  assert.equal(await f.api().run({ text: "看一下图片" }), foreign);
  assert.equal(f.requests.length, 3);
  const body = f.requests[1];
  assert.deepEqual(body.messages.slice(-4).map((m: any) => m.role), ["assistant", "tool", "tool", "user"]);
  assert.equal(body.messages.at(-3).tool_call_id, "view_media");
  assert.equal(body.messages.at(-2).tool_call_id, "plain_echo");
  const blocks = body.messages.at(-1).content;
  assert.match(blocks[0].text, /pictures.*synthetic-source/);
  assert.match(blocks[0].text, /不是真人新发言/);
  assert.match(blocks[1].text, /frame 00:01.250/);
  assert.equal(blocks[2].type, "image_url");
  assert.equal(blocks[2].image_url.detail, "low");
  assert.deepEqual(Buffer.from(blocks[2].image_url.url.split(",")[1], "base64"), Buffer.concat([png, Buffer.alloc(120000)]));
  assert.ok(!body.messages.filter((m: any) => m.role === "tool").some((m: any) => m.content.includes("base64")));
  for (const request of f.requests) {
    assert.equal(request.model, "custom-vision-model");
    assert.equal(request.thinking.type, "enabled");
    assert.match(request.messages[0].content, /SYNTHETIC_PERSONA_STAYS_THE_SAME/);
    for (const m of request.messages.filter((m: any) => m.role === "assistant")) assert.equal(m.reasoning_content, "SYNTHETIC_PROTOCOL_REASONING");
  }
  const state = await f.app.memoryEngine.state(f.id);
  assert.equal(state.usage.chat.input_tokens, 2700);
  assert.equal(state.usage.chat.requests, 3);
  assert.equal((await f.app.sessions.contextStatus(f.id, { persona: "p" })).usage.used_tokens, 911);
  assert.equal((await f.app.memory.readSession(f.id)).at(-1).text, TRANSIENT_REPLY);
  assert.equal((await f.app.memoryEngine.localFacts(f.id)).text, "");
  await f.clean();
  assert.deepEqual(f.events.find((e: any) => e.name === "view_media").result, { action: "view", count: 1 });
  f.model((_body, res) => sse(res, "下一轮"));
  await f.api().run({ text: "继续交流" });
  assert.ok(!hasMedia(f.requests.at(-1)));
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes(foreign));
  await f.clean();
});

test("byte transport returns normal ToolResult shape; invalid images and expired references do not create visual blocks", async t => {
  const f = await fixture(t);
  const result = await f.api().call({}, f.id);
  assert.equal(result.ok, true);
  assert.deepEqual(Buffer.from(result.result[1].data), png);
  for (const args of [{ invalid: true }, { count: 17 }]) {
    const invalid = await f.api().call(args, f.id);
    assert.equal(invalid.ok, false);
    assert.match(invalid.result, /图片/);
  }
  assert.deepEqual(await f.api().call({ expired: true }, f.id), { ok: true, result: [{ type: "text", text: "引用已过期，未读取资料" }] });
  await f.clean();
});

test("concurrent sessions never mix temporary image sources", async t => {
  const f = await fixture(t), other = await f.app.sessions.create("独立测试");
  f.model((body, res) => sse(res, hasMedia(body) ? "看到了" : "", hasMedia(body) ? [] : [call("view_media")]));
  await Promise.all([f.api().run({ sessionId: f.id, text: "one" }), f.api().run({ sessionId: other, text: "two" })]);
  assert.equal(f.requests.length, 4);
  for (const body of f.requests.filter(hasMedia)) {
    const blocks = body.messages.at(-1).content;
    const own = body.messages.some((m: any) => m.content === "one") ? f.id : other;
    assert.ok(blocks[1].text.includes(own));
    assert.ok(!blocks[1].text.includes(own === other ? f.id : other));
  }
  await f.clean();
});

test("provider image rejection is explicit and sanitized, no model switch or automatic replay; unknown usage stays unknown", async t => {
  const f = await fixture(t);
  f.model((body, res) => {
    if (!hasMedia(body)) return sse(res, "", [call("view_media")], null);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Image input is not supported " + foreign + png.toString("base64"), type: "invalid_request_error" } }));
  });
  await assert.rejects(f.api().run({ text: "查看" }), /不支持图片输入/);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every((b: any) => b.model === "custom-vision-model"));
  assert.equal((await f.app.memoryEngine.state(f.id)).usage.chat.unknown_requests, 1);
  await f.clean();
  f.model((_body, res) => sse(res, "恢复"));
  assert.equal(await f.api().run({ text: "继续" }), "恢复");
});

test("media limits also apply across tool rounds", async t => {
  const f = await fixture(t);
  f.model((_body, res) => sse(res, "", [call("view_media", { count: 9 })]));
  await assert.rejects(f.api().run({ text: "查看多帧" }), /累计超过/);
  assert.equal(f.requests.length, 2);
  await f.clean();
});

for (const stage of ["tool", "http"] as const) test(`stopping the media provider during ${stage} cancels an independent core caller, with no replay`, async t => {
  const f = await fixture(t);
  f.model((body, res) => { if (!hasMedia(body)) sse(res, "", [call("view_media", { wait: stage === "tool" })]); });
  const pending = assert.rejects(f.app.sessions.chat(f.id, "查看图片", () => {}, undefined, "p"), /停用|停止|失效|关闭|断开/);
  await until(() => stage === "tool" ? f.api().waiting() : f.requests.length === 2);
  await f.app.runtime.action("pictures", "stop");
  await pending;
  assert.equal(f.requests.length, stage === "tool" ? 1 : 2);
  assert.ok(!f.app.tools.list().some((tool: any) => tool.function.name === "view_media"));
  await f.clean();
  f.model((_body, res) => sse(res, "纯文字仍可用"));
  assert.equal(await f.app.sessions.chat(f.id, "继续", () => {}, undefined, "p"), "纯文字仍可用");
  assert.ok(!hasMedia(f.requests.at(-1)));
});

test("caller cancellation aborts the image request without retrying", async t => {
  const f = await fixture(t), abort = new AbortController();
  f.model((body, res) => { if (!hasMedia(body)) sse(res, "", [call("view_media")]); });
  const pending = assert.rejects(f.api().run({ text: "查看", signal: abort.signal }), /cancel-test/);
  await until(() => f.requests.length === 2);
  abort.abort(Error("cancel-test"));
  await pending;
  assert.equal(f.requests.length, 2);
  await f.clean();
});

test("bounded snapshots validate MIME, byte type, detail, total size and copy data; estimates never tokenize base64", () => {
  const source = image(Buffer.from(png)), copy = toolContentSnapshot([source]);
  source.data.fill(0);
  assert.deepEqual((copy[0] as any).data, png);
  for (const value of [[], [{ type: "video", data: png }], [image("url" as any)], [{ ...image(), detail: "huge" }],
    [{ ...image(), mimeType: "image/jpeg" }], [image(Buffer.alloc(TOOL_CONTENT_LIMITS.imageBytes + 1))],
    [{ type: "text", text: "x".repeat(65537) }], Array.from({ length: 65 }, () => ({ type: "text", text: "" }))])
    assert.throws(() => toolContentSnapshot(value));
  const large = Buffer.alloc(TOOL_CONTENT_LIMITS.imageBytes); png.copy(large);
  assert.throws(() => toolContentSnapshot(Array.from({ length: 5 }, () => image(large))), /16MiB/);
  assert.equal(toolContentSnapshot([{ type: "image", mimeType: "image/jpeg", data: Buffer.from([255,216,255,0]) }]).length, 1);
  assert.equal(toolContentSnapshot([{ type: "image", mimeType: "image/webp", data: Buffer.from("RIFF0000WEBP") }]).length, 1);
  assert.ok(!promptText([{ role: "user", content: [{ type: "image_url", image_url: { url: png.toString("base64") } }] }]).includes(png.toString("base64")));
  // Existing text requests retain exactly the previous budgeting representation.
  const plain = [{ role: "tool", content: '{"ok":true}' }];
  assert.equal(promptText(plain), JSON.stringify(plain));
});

// Compile-time public package contract: no imports of implementation classes needed by a plugin.
function publicContract(ctx: Context, output: MultimodalToolOutput) {
  ctx.tools.registerMultimodal({ name: "public_test", description: "example", schema: {}, run: () => output });
  const request: ChatOptions = { model: "chosen", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }] }] };
  return ctx.llm.chat(request);
}
