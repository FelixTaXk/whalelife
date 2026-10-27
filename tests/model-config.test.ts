import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "whale-models-"));
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
