import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { temporaryDirectory } from "./temporary-directory.ts";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { Logger } from "../core/logger.ts";
import {
  ModelConfig,
  resolveChatModel,
  validateModelParameters,
} from "../core/model-config.ts";
import { LLM } from "../core/llm.ts";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { connect, type Socket } from "node:net";
import { resolveModel } from "../core/model-config.ts";

async function fixture() {
  const root = await temporaryDirectory("whale-models-");
  await mkdir(join(root, "config"));
  const config: any = {
    providers: [
      {
        id: "first",
        base_url: "https://unused.example/v1",
        api_key: "first-secret",
        model: "unused-chat",
      },
      {
        id: "selected",
        base_url: "https://models.example/v1",
        api_key: "kept-secret",
        model: "selected-chat",
      },
    ],
    personas: {
      whale: {
        name: "鲸鲸",
        provider: "selected",
        file: "memory/personas/whale.md",
        permission: "ask",
      },
    },
    channels: { web: { persona: "whale", permission: "full" } },
    memory: { root: "memory", recent_lines: 30 },
    custom: { preserve: true },
  };
  const file = join(root, "config/config.json");
  await writeFile(file, JSON.stringify(config, null, 2));
  const logger = new Logger(join(root, "logs"));
  const manager = new ModelConfig(root, config, logger);
  const input = () => {
    const s = manager.snapshot();
    return {
      revision: s.revision,
      providers: s.providers,
      models: s.models,
      bindings: s.bindings,
      personaModels: Object.fromEntries(s.personas.map((p) => [p.id, p.model])),
    };
  };
  return { root, file, config, logger, manager, input };
}

test("a concurrent snapshot cannot make a stale pending save overwrite an external edit", async () => {
  const f = await fixture();
  const fs = createRequire(import.meta.url)("node:fs/promises");
  const original = fs.writeFile;
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (reached = r)),
    gate = new Promise<void>((r) => (release = r));
  fs.writeFile = async (path: any, ...args: any[]) => {
    await original(path, ...args);
    if (
      String(path).startsWith(f.file + ".") &&
      String(path).endsWith(".tmp")
    ) {
      reached();
      await gate;
    }
  };
  syncBuiltinESMExports();
  try {
    const save = f.manager.save(f.input());
    const rejected = assert.rejects(save, (error: any) => error.status === 409);
    await ready;
    const external = JSON.parse(await readFile(f.file, "utf8"));
    external.custom.preserve = "external-change";
    await original(f.file, JSON.stringify(external));
    f.manager.snapshot();
    release();
    await rejected;
    assert.equal(
      JSON.parse(await readFile(f.file, "utf8")).custom.preserve,
      "external-change",
    );
  } finally {
    release();
    fs.writeFile = original;
    syncBuiltinESMExports();
  }
});

test("legacy migration follows the configured persona, never provider array order", async () => {
  const f = await fixture();
  const s = f.manager.snapshot();
  assert.equal(s.bindings.chat, "selected-chat");
  assert.equal(s.personas[0].model, null);
  assert.equal(resolveChatModel(f.config, "whale").model, "selected-chat");
  assert.ok(!JSON.stringify(s).includes("secret"));
  assert.equal(s.providers[1].has_key, true);
  f.config.model_bindings.chat = null;
  assert.throws(() => resolveChatModel(f.config, "whale"), /选择/);
  await assert.rejects(
    () =>
      new LLM(f.logger, [{ id: "first", model: "should-not-default" }]).chat({
        messages: [],
      }),
    /明确选择/,
  );
});

test("saving preserves blank keys and unrelated configuration, supports explicit key clearing", async () => {
  const f = await fixture();
  const edit = f.input();
  edit.providers[1].name = "Renamed connection";
  (edit.providers[1] as any).api_key = "";
  const saved = await f.manager.save(edit);
  const disk = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(disk.providers[1].api_key, "kept-secret");
  assert.deepEqual(disk.custom, { preserve: true });
  assert.equal(disk.channels.web.permission, "full");
  assert.notEqual(saved.revision, edit.revision);
  assert.ok(!JSON.stringify(saved).includes("kept-secret"));
  assert.ok(f.logger.secrets.includes("kept-secret"));
  const clear = f.input();
  (clear.providers[1] as any).clear_key = true;
  await f.manager.save(clear);
  assert.equal(
    JSON.parse(await readFile(f.file, "utf8")).providers[1].api_key,
    "",
  );
  assert.equal(f.manager.snapshot().providers[1].has_key, false);
});

test("revision conflicts reject stale windows and external edits without overwriting them", async () => {
  const f = await fixture();
  const stale = f.input();
  await f.manager.save(f.input());
  await assert.rejects(
    () => f.manager.save(stale),
    (e: any) => e.status === 409,
  );
  const pending = f.input();
  const disk = JSON.parse(await readFile(f.file, "utf8"));
  disk.custom.external = "preserve me";
  await writeFile(f.file, JSON.stringify(disk));
  await assert.rejects(
    () => f.manager.save(pending),
    (e: any) => e.status === 409,
  );
  assert.equal(
    JSON.parse(await readFile(f.file, "utf8")).custom.external,
    "preserve me",
  );
  const refreshed = f.input();
  await f.manager.save(refreshed);
  assert.equal(
    JSON.parse(await readFile(f.file, "utf8")).custom.external,
    "preserve me",
  );
});

test("model references, capabilities, enabled state and secret destination changes are validated", async () => {
  const f = await fixture();
  let edit = f.input();
  edit.providers = edit.providers.filter((p: any) => p.id !== "selected");
  await assert.rejects(() => f.manager.save(edit), /提供商不存在/);
  edit = f.input();
  edit.providers[1].enabled = false;
  await assert.rejects(() => f.manager.save(edit), /绑定/);
  edit = f.input();
  edit.models.find((m: any) => m.id === "selected-chat").type = "embedding";
  await assert.rejects(() => f.manager.save(edit), /用途匹配/);
  edit = f.input();
  edit.providers[1].base_url = "https://other.example/v1";
  await assert.rejects(() => f.manager.save(edit), /重新输入密钥/);
  assert.equal(
    f.manager.snapshot().providers[1].base_url,
    "https://models.example/v1",
  );
  (edit.providers[1] as any).api_key = "replacement-secret";
  await f.manager.save(edit);
  assert.ok(f.logger.secrets.includes("replacement-secret"));
  assert.ok(f.logger.secrets.includes("kept-secret"));
  edit = f.input();
  edit.providers[1].base_url =
    "https://user:password@example.com/v1?api_key=bad";
  await assert.rejects(() => f.manager.save(edit), /不可包含/);
  assert.throws(
    () => validateModelParameters({ headers: { Authorization: "secret" } }),
    /认证字段/,
  );
  assert.throws(() => validateModelParameters({ model: "override" }), /覆盖/);
  assert.deepEqual(
    validateModelParameters({ temperature: 0.5, dimensions: 1024 }),
    { temperature: 0.5, dimensions: 1024 },
  );
});

test("saved embedding configuration calls embeddings endpoint and reports dimension without exposing content", async () => {
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({
      path: req.url,
      auth: req.headers.authorization,
      body: raw ? JSON.parse(raw) : null,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models")
      res.end(
        JSON.stringify({
          data: [{ id: "vector-model" }, { id: "chat-model" }],
        }),
      );
    else if (req.url === "/v1/embeddings")
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    else if (req.url === "/v1/chat/completions")
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "OK" } }],
        }),
      );
    else {
      res.statusCode = 401;
      res.end("sensitive upstream body");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  try {
    const f = await fixture();
    const edit = f.input();
    edit.providers.push({
      id: "local",
      name: "Local inference",
      protocol: "openai-compatible",
      base_url: `http://127.0.0.1:${port}/v1`,
      enabled: true,
      has_key: false,
    });
    edit.models.push({
      id: "vector",
      name: "检索向量",
      provider: "local",
      model: "vector-model",
      type: "embedding",
      enabled: true,
      parameters: { dimensions: 3 },
    });
    edit.bindings.embedding = "vector";
    await f.manager.save(edit);
    assert.deepEqual(await f.manager.listModels("local"), {
      details: [
        { id: "vector-model", context_window: null },
        { id: "chat-model", context_window: null },
      ],
      models: ["chat-model", "vector-model"],
    });
    const result = await f.manager.testModel("vector");
    assert.equal(result.ok, true);
    assert.equal(result.dimensions, 3);
    assert.equal(seen[1].path, "/v1/embeddings");
    assert.equal(seen[1].auth, undefined);
    assert.equal(seen[1].body.model, "vector-model");
    assert.equal(seen[1].body.dimensions, 3);
    assert.ok(!JSON.stringify(result).includes("0.1"));
    assert.equal(resolveChatModel(f.config, "whale").model, "selected-chat");
    const e = f.input();
    e.models.push({
      id: "local-chat",
      name: "Local chat",
      provider: "local",
      model: "chat-model",
      type: "chat",
      enabled: true,
      parameters: { temperature: 0.2 },
    });
    e.bindings.chat = "local-chat";
    await f.manager.save(e);
    assert.equal(resolveChatModel(f.config, "whale").model, "chat-model");
    assert.equal((await f.manager.testModel("local-chat")).ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("upstream failures and malformed disk JSON cannot expose response bodies or credential snippets", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("credential-from-upstream-should-stay-private");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const f = await fixture();
    const edit = f.input();
    edit.providers[1].base_url = `http://127.0.0.1:${(server.address() as any).port}`;
    (edit.providers[1] as any).api_key = "local-fake-key";
    await f.manager.save(edit);
    await assert.rejects(
      () => f.manager.listModels("selected"),
      (error: any) =>
        error.status === 502 && error.message === "模型服务返回 HTTP 401",
    );
    assert.ok(!f.logger.lines.join("\n").includes("credential-from-upstream"));
    await writeFile(
      f.file,
      '{"providers":[{"api_key":"new-sensitive-key" BROKEN',
    );
    assert.throws(
      () => f.manager.snapshot(),
      (error: any) => error.message === "配置文件不是有效的 JSON，请修复后重试",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("transport settings have validated defaults and never allow proxy URL credentials", async () => {
  const f = await fixture();
  const initial = f.manager.snapshot();
  assert.equal(initial.providers[0].timeout_seconds, 120);
  assert.equal(initial.providers[0].proxy_url, "");
  let edit = f.input();
  edit.providers[0].timeout_seconds = 25;
  edit.providers[0].proxy_url = "http://127.0.0.1:7890";
  await f.manager.save(edit);
  assert.equal(f.manager.snapshot().providers[0].timeout_seconds, 25);
  assert.equal(
    f.manager.snapshot().providers[0].proxy_url,
    "http://127.0.0.1:7890",
  );
  for (const value of [0, 601, 1.5, "60"]) {
    edit = f.input();
    edit.providers[0].timeout_seconds = value;
    await assert.rejects(() => f.manager.save(edit), /1–600/);
  }
  for (const value of [
    "http://username:secret@localhost:7890",
    "socks5://localhost:7890",
    "https://localhost:7890/path",
  ]) {
    edit = f.input();
    edit.providers[0].proxy_url = value;
    await assert.rejects(() => f.manager.save(edit), /代理/);
  }
});

test("draft embedding tests reuse only matching saved credentials, distinguish expected dimension from request parameters, and never save", async () => {
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({
      path: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(raw),
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const f = await fixture();
    const edit = f.input();
    const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    edit.providers[1].base_url = base;
    (edit.providers[1] as any).api_key = "test-draft-key";
    await f.manager.save(edit);
    const before = await readFile(f.file, "utf8");
    const draft: any = {
      provider: {
        id: "selected",
        protocol: "openai-compatible",
        base_url: base,
        api_key: "",
        enabled: true,
        timeout_seconds: 10,
        proxy_url: "",
      },
      model: {
        model: "embedding-test",
        type: "embedding",
        enabled: true,
        parameters: { dimensions: 2 },
        dimensions: 3,
      },
    };
    const result = await f.manager.probeDraft(draft);
    assert.equal(result.dimensions, 3);
    assert.equal(seen[0].auth, "Bearer test-draft-key");
    assert.equal(seen[0].body.dimensions, 2);
    assert.equal(seen[0].body.input, "WhaleLife connection test");
    draft.model.dimensions = 1024;
    await assert.rejects(
      () => f.manager.probeDraft(draft),
      /预期 1024.*返回 3/,
    );
    const detected = await f.manager.probeDraft({
      ...draft,
      detectDimensions: true,
    });
    assert.equal(detected.dimensions, 3);
    delete draft.model.parameters.dimensions;
    await f.manager.probeDraft({ ...draft, detectDimensions: true });
    assert.ok(!Object.hasOwn(seen.at(-1).body, "dimensions"));
    assert.equal(await readFile(f.file, "utf8"), before);
    const moved = structuredClone(draft);
    moved.provider.base_url += "/elsewhere";
    await assert.rejects(() => f.manager.probeDraft(moved), /重新输入密钥/);
    const changed = structuredClone(draft);
    changed.provider.protocol = "dashscope";
    await assert.rejects(
      () => f.manager.probeDraft(changed),
      /协议后请重新输入密钥/,
    );
    const snapshot = f.manager.snapshot();
    assert.ok(!JSON.stringify(snapshot).includes("test-draft-key"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("DashScope model discovery collects pages, filters non-embedding capabilities and preserves draft credentials", async t => {
  const f = await fixture(), before = await readFile(f.file, "utf8");
  const provider = { id: "dash-draft", name: "DashScope", protocol: "dashscope", base_url: "https://dashscope.aliyuncs.com/api/v1", api_key: "draft-secret", timeout_seconds: 10, enabled: true };
  const requests: any[] = [];
  t.mock.method(f.manager as any, "request", async (p: any, endpoint: string, body: any, signal: AbortSignal) => {
    assert.equal(p.api_key, "draft-secret");
    assert.equal(p.base_url, provider.base_url);
    assert.equal(body, undefined);
    assert.equal(signal.aborted, false);
    const query = new URL(endpoint, provider.base_url).searchParams;
    assert.equal(query.get("capabilities"), "TR");
    requests.push(endpoint);
    return { success: true, output: { total: 4, page_no: Number(query.get("page_no")), models: requests.length === 1 ? [
      { model: "text-embedding-v4", capabilities: ["TR"], model_info: { context_window: 8192 } },
      { model: "qwen-vl", capabilities: ["VU", "TG"] },
    ] : [
      { model: "text-embedding-v3" },
      { model: "text-embedding-v4", capabilities: ["TR"], model_info: { context_window: 8192 } },
    ] } };
  });
  assert.deepEqual(await f.manager.listDraftModels({ provider }), {
    models: ["text-embedding-v3", "text-embedding-v4"],
    details: [{ id: "text-embedding-v4", context_window: 8192 }, { id: "text-embedding-v3", context_window: null }],
  });
  assert.equal(requests.length, 2);
  assert.equal(await readFile(f.file, "utf8"), before, "discovery cannot save a draft or change model routing");
  assert.ok(!JSON.stringify(f.manager.snapshot()).includes("draft-secret"));
});

test("DashScope model discovery rejects broken or runaway pagination and respects cancellation", async t => {
  const f = await fixture();
  const p = { protocol: "dashscope", base_url: "https://fixture.invalid/api/v1", timeout_seconds: 1 };
  let response: any;
  let requests = 0;
  t.mock.method(f.manager as any, "request", async () => { requests++; return response; });
  const fetch = (signal?: AbortSignal) => (f.manager as any).fetchModels(p, signal);
  for (response of [null, { success: false }, { output: { total: -1, models: [] } }, { output: { total: 5001, models: [] } },
    { output: { total: 1, models: [] } }, { output: { total: 1, page_no: 2, models: [{ model: "a" }] } }]) {
    await assert.rejects(fetch(), /百炼/);
  }
  response = { output: { total: 3, models: [{ model: "a" }] } };
  await assert.rejects(fetch(), /分页未完整返回/);
  response = { output: { total: 0, page_no: 1, models: [] } };
  assert.deepEqual(await fetch(), { models: [], details: [] });
  const before = requests;
  await assert.rejects(fetch(AbortSignal.abort(Error("cancelled-catalog"))), /cancelled-catalog/);
  assert.equal(requests, before);
});

test("DashScope embeddings use native endpoint and envelope while dimensions are checked independently", async () => {
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      const url = new URL(req.url!, "http://fixture");
      assert.equal(url.pathname, "/api/v1/models");
      assert.equal(url.searchParams.get("capabilities"), "TR");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ output: { total: 1, page_no: 1, models: [{ model: "text-embedding-v3", capabilities: ["TR"] }] } }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ path: req.url, body: JSON.parse(raw) });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        output: { embeddings: [{ embedding: [0.2, 0.4, 0.6], text_index: 0 }] },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const f = await fixture();
    const edit = f.input();
    edit.providers.push({
      id: "dash",
      name: "阿里原生向量",
      protocol: "dashscope",
      base_url: `http://127.0.0.1:${(server.address() as any).port}/api/v1`,
      enabled: true,
      timeout_seconds: 120,
      proxy_url: "",
      has_key: false,
    });
    edit.models.push({
      id: "dash-vector",
      name: "向量",
      provider: "dash",
      model: "text-embedding-v3",
      type: "embedding",
      enabled: true,
      parameters: { dimension: 3, text_type: "query" },
      dimensions: 3,
    });
    edit.bindings.embedding = "dash-vector";
    await f.manager.save(edit);
    const result = await f.manager.testModel("dash-vector");
    assert.equal(result.dimensions, 3);
    assert.equal(
      seen[0].path,
      "/api/v1/services/embeddings/text-embedding/text-embedding",
    );
    assert.deepEqual(seen[0].body, {
      model: "text-embedding-v3",
      input: { texts: ["WhaleLife connection test"] },
      parameters: { dimension: 3, text_type: "query" },
    });
    const changed = f.input();
    changed.models.find((m: any) => m.id === "dash-vector").dimensions = 1024;
    await f.manager.save(changed);
    await assert.rejects(() => f.manager.testModel("dash-vector"), /预期 1024/);
    assert.equal(
      (await f.manager.testModel("dash-vector", true)).dimensions,
      3,
    );
    assert.deepEqual(await f.manager.listModels("dash"), {
      models: ["text-embedding-v3"], details: [{ id: "text-embedding-v3", context_window: null }],
    });
    const illegal = f.input();
    illegal.models.push({
      id: "dash-chat",
      name: "不支持的原生对话",
      provider: "dash",
      model: "qwen-plus",
      type: "chat",
      enabled: true,
      parameters: {},
      dimensions: null,
    });
    await assert.rejects(() => f.manager.save(illegal), /仅支持 Embedding/);
    f.config.models.push(illegal.models.at(-1));
    assert.throws(
      () => resolveModel(f.config, "dash-chat"),
      /仅支持 Embedding/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("legacy DeepSeek embedding mistakes stay visible and unchanged but cannot be bound, tested or duplicated", async () => {
  const f = await fixture();
  const disk = JSON.parse(await readFile(f.file, "utf8"));
  disk.providers[1].base_url = "https://api.deepseek.com";
  disk.models = f.manager.snapshot().models;
  disk.models.push({
    id: "model_421e97a26ccc",
    name: "误配向量",
    provider: "selected",
    model: "dashscope_embedding",
    type: "embedding",
    enabled: true,
    parameters: {},
  });
  disk.model_bindings = f.manager.snapshot().bindings;
  await writeFile(f.file, JSON.stringify(disk));
  const snapshot = f.manager.snapshot();
  const invalid = snapshot.models.find(
    (m: any) => m.id === "model_421e97a26ccc",
  );
  assert.match(invalid.configuration_error, /DeepSeek 官方接口仅支持对话/);
  assert.equal(invalid.provider, "selected");
  const edit = f.input();
  edit.providers[0].name = "修改另一提供商";
  await f.manager.save(edit);
  const after = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(
    after.models.find((m: any) => m.id === invalid.id).model,
    "dashscope_embedding",
  );
  assert.equal(after.providers[1].api_key, "kept-secret");
  await assert.rejects(() => f.manager.testModel(invalid.id), /DeepSeek/);
  await assert.rejects(() => f.manager.testModel(invalid.id, true), /DeepSeek/);
  const bind = f.input();
  bind.bindings.embedding = invalid.id;
  await assert.rejects(() => f.manager.save(bind), /绑定/);
  const duplicate = f.input();
  duplicate.models.push({ ...invalid, id: "another-invalid" });
  await assert.rejects(() => f.manager.save(duplicate), /DeepSeek/);
  const modified = f.input();
  modified.models.find((m: any) => m.id === invalid.id).model =
    "text-embedding-v3";
  await assert.rejects(() => f.manager.save(modified), /DeepSeek/);
  assert.ok(!JSON.stringify(f.manager.snapshot()).includes("kept-secret"));
});

test("configured HTTP proxy is actually used by probes and streaming chat", async () => {
  const seen: any[] = [];
  const origin = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ path: req.url, body });
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "proxied-chat", context_window: 32768 }],
        }),
      );
    } else if (body?.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        'data: {"choices":[{"delta":{"content":"proxy success"}}]}\n\ndata: [DONE]\n\n',
      );
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "OK" } }],
        }),
      );
    }
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originPort = (origin.address() as any).port;
  const targets: string[] = [];
  const sockets = new Set<Socket>();
  const proxy = createServer();
  proxy.on("connect", (req, client, head) => {
    targets.push(req.url!);
    const upstream = connect(originPort, "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket as Socket);
      socket.on("close", () => sockets.delete(socket as Socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const f = await fixture();
    const edit = f.input();
    edit.providers[1].base_url = "http://only-reachable-via-proxy.invalid/v1";
    (edit.providers[1] as any).api_key = "";
    (edit.providers[1] as any).clear_key = true;
    edit.providers[1].proxy_url = `http://127.0.0.1:${(proxy.address() as any).port}`;
    edit.providers[1].timeout_seconds = 3;
    await f.manager.save(edit);
    assert.deepEqual(await f.manager.listModels("selected"), {
      details: [{ id: "proxied-chat", context_window: 32768 }],
      models: ["proxied-chat"],
    });
    assert.equal((await f.manager.testModel("selected-chat")).ok, true);
    const llm = new LLM(f.logger);
    const result = await llm.chat({
      provider: resolveChatModel(f.config, "whale"),
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.equal(result.text, "proxy success");
    assert.equal(targets.length, 3);
    assert.ok(
      targets.every((t) => t === "only-reachable-via-proxy.invalid:80"),
    );
    assert.equal(seen.length, 3);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((r) => proxy.close(() => r())),
      new Promise<void>((r) => origin.close(() => r())),
    ]);
  }
});

test("provider timeout covers both a slow probe and an unfinished chat stream", async () => {
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const f = await fixture();
    const edit = f.input();
    edit.providers[1].base_url = `http://127.0.0.1:${(server.address() as any).port}`;
    (edit.providers[1] as any).clear_key = true;
    edit.providers[1].timeout_seconds = 1;
    await f.manager.save(edit);
    await assert.rejects(
      () => f.manager.testModel("selected-chat"),
      (e: any) => e.status === 504 && /1 秒/.test(e.message),
    );
    await assert.rejects(
      () =>
        new LLM(f.logger).chat({
          provider: resolveChatModel(f.config, "whale"),
          messages: [],
        }),
      (e: any) => e.status === 504 && /1 秒/.test(e.message),
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
