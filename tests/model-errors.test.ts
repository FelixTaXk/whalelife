import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { withModelResponse } from "../core/model-http.ts";
import { LLM } from "../core/llm.ts";

async function server(t: TestContext, handler: RequestListener) {
  const instance = createServer(handler);
  t.after(async () => { instance.closeAllConnections(); await new Promise<void>(r => instance.close(() => r())); });
  await new Promise<void>(r => instance.listen(0, "127.0.0.1", r));
  return { model: "synthetic", base_url: `http://127.0.0.1:${(instance.address() as any).port}`, api_key: "secret-never-disclose" };
}

test("HTTP diagnostics expose bounded protocol category/type/request ID, never credentials or provider request echoes", async t => {
  let requests = 0;
  const provider = await server(t, (req, res) => {
    requests++;
    req.resume();
    res.writeHead(400, { "Content-Type": "application/json", "x-request-id": "12345678-1234-1234-1234-123456789abc" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message:
      'The reasoning_content in the thinking mode must be passed back to the API. token=secret-never-disclose; PRIVATE_CONTEXT: 私人聊天内容',
      request: { messages: [{ content: "PRIVATE_CONTEXT" }], headers: { Authorization: "Bearer secret-never-disclose" } } } }));
  });
  const errors: any[] = [];
  const llm = new LLM({ info() {}, error(_message: string, data: any) { errors.push(data.error.message); } } as any);
  await assert.rejects(llm.chat({ provider, messages: [{ role: "user", content: "PRIVATE_CONTEXT" }] }), (error: any) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /HTTP 400/);
    assert.match(error.message, /reasoning_content/);
    assert.match(error.message, /invalid_request_error/);
    assert.match(error.message, /12345678-1234-1234-1234-123456789abc/);
    assert.ok(error.message.length < 300);
    return true;
  });
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE_CONTEXT|私人聊天内容|secret-never-disclose|Authorization/);
});

test("unknown, oversized and non-JSON provider errors do not leak raw body text", async t => {
  for (const body of [
    JSON.stringify({ error: { message: "PRIVATE_CONTEXT", type: "PRIVATE_CONTEXT", code: "PRIVATE_CONTEXT" }, request_id: "secret-never-disclose" }),
    "<html>PRIVATE_CONTEXT</html>",
    JSON.stringify({ error: { message: "PRIVATE_CONTEXT".repeat(5000) } }),
  ]) {
    const provider = await server(t, (req, res) => { req.resume(); res.writeHead(400); res.end(body); });
    await assert.rejects(withModelResponse(provider, "/chat/completions", {}, r => r.text()), (error: any) => {
      assert.equal(error.message, "模型服务返回 HTTP 400");
      return true;
    });
  }
});

test("error-body diagnostics have a short read deadline and external cancellation retains its reason", { timeout: 6000 }, async t => {
  let entered!: () => void;
  const first = new Promise<void>(r => entered = r);
  const provider = await server(t, (req, res) => { req.resume(); res.writeHead(400); res.write('{"error":'); entered(); });
  const controller = new AbortController(), reason = Error("diagnostic cancelled");
  const pending = withModelResponse(provider, "/chat/completions", {}, r => r.text(), controller.signal);
  await first;
  controller.abort(reason);
  await assert.rejects(pending, (error: any) => error === reason);
  const started = Date.now();
  await assert.rejects(withModelResponse(provider, "/chat/completions", {}, r => r.text()), /HTTP 400/);
  assert.ok(Date.now() - started < 3000);
});

test("SSE error messages use the same safe diagnostic policy", async t => {
  const provider = await server(t, (req, res) => {
    req.resume(); res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"error":{"type":"invalid_request_error","message":"reasoning_content missing in thinking mode PRIVATE_CONTEXT"}}\n\n');
  });
  const llm = new LLM({ info() {}, error() {} } as any);
  await assert.rejects(llm.chat({ provider, messages: [{ role: "user", content: "test" }] }), (error: any) => {
    assert.match(error.message, /reasoning_content/);
    assert.doesNotMatch(error.message, /PRIVATE_CONTEXT/);
    return true;
  });
});
