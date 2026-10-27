import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../core/logger.ts";
import { LLM } from "../core/llm.ts";
import {
  ModelConfig,
  resolveChatModel,
  resolveModel,
  validateModelParameters,
  type ModelType,
} from "../core/model-config.ts";

async function fixture(alter?: (config: any) => void) {
  const root = await mkdtemp(join(tmpdir(), "whale-context-window-"));
  await mkdir(join(root, "config"));
  const config: any = {
    providers: [
      {
        id: "service",
        name: "Test",
        protocol: "openai-compatible",
        base_url: "https://models.example/v1",
        enabled: true,
      },
    ],
    models: [
      {
        id: "chat",
        name: "Chat",
        provider: "service",
        model: "chat-model",
        type: "chat",
        enabled: true,
        parameters: { temperature: 0.2, max_tokens: 128 },
      },
      {
        id: "vector",
        name: "Vector",
        provider: "service",
        model: "vector-model",
        type: "embedding",
        enabled: true,
        parameters: {},
      },
    ],
    model_bindings: { chat: "chat" },
    personas: {
      whale: {
        name: "Whale",
        model: null,
        file: "unused.md",
        permission: "off",
      },
    },
    channels: { web: { persona: "whale", permission: "off" } },
  };
  alter?.(config);
  const file = join(root, "config/config.json");
  await writeFile(file, JSON.stringify(config));
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

test("context window survives save and restart as model metadata outside request parameters", async () => {
  const f = await fixture();
  assert.equal(f.manager.snapshot().models[0].context_window, null);
  const edit = f.input();
  edit.models[0].context_window = 32768;
  const saved = await f.manager.save(edit);
  const disk = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(saved.models[0].context_window, 32768);
  assert.equal(disk.models[0].context_window, 32768);
  const restarted = new ModelConfig(f.root, disk, f.logger);
  assert.equal(restarted.snapshot().models[0].context_window, 32768);
  for (const resolved of [
    resolveModel(disk, "chat"),
    resolveChatModel(disk, "whale"),
  ]) {
    assert.equal(resolved.context_window, 32768);
    assert.deepEqual(resolved.parameters, {
      temperature: 0.2,
      max_tokens: 128,
    });
    assert.equal(Object.hasOwn(resolved.parameters, "context_window"), false);
  }
});

test("context window accepts both boundaries and explicit or omitted empty values", async () => {
  const f = await fixture();
  for (const value of [1, 10000000, null, undefined]) {
    const edit = f.input();
    if (value === undefined) delete edit.models[0].context_window;
    else edit.models[0].context_window = value;
    await f.manager.save(edit);
    assert.equal(f.manager.snapshot().models[0].context_window, value ?? null);
    assert.equal(
      JSON.parse(await readFile(f.file, "utf8")).models[0].context_window,
      value ?? null,
    );
  }
});

test("invalid context windows reject the write without altering saved configuration", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  for (const value of [
    0,
    -1,
    1.5,
    10000001,
    "32768",
    true,
    NaN,
    Infinity,
    {},
    [],
  ]) {
    const edit = f.input();
    (edit.models[0] as any).context_window = value;
    await assert.rejects(f.manager.save(edit), /上下文窗口必须为空或/);
    assert.equal(await readFile(f.file, "utf8"), before);
  }
  for (const type of [
    "embedding",
    "rerank",
    "image",
    "stt",
    "tts",
    "custom",
  ] as ModelType[]) {
    const edit = f.input();
    edit.models[1].type = type;
    edit.models[1].context_window = 4096;
    await assert.rejects(f.manager.save(edit), /上下文窗口仅适用于对话模型/);
    assert.equal(await readFile(f.file, "utf8"), before);
  }
});

test("legacy provider migration leaves context window unset without inferring a default", async () => {
  const f = await fixture((config) => {
    delete config.models;
    delete config.model_bindings;
    delete config.personas.whale.model;
    config.personas.whale.provider = "service";
    config.providers[0].model = "legacy-chat-model";
  });
  assert.equal(f.manager.snapshot().models[0].context_window, null);
  assert.equal(resolveChatModel(f.config, "whale").context_window, null);
  await f.manager.save(f.input());
  const disk = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(disk.models[0].context_window, null);
  assert.equal(disk.models[0].model, "legacy-chat-model");
});

test("adding null metadata preserves old invalid records but changing their window is not an unchanged record", async () => {
  const f = await fixture((config) => {
    config.providers.push(
      {
        id: "deepseek",
        name: "Legacy DeepSeek",
        protocol: "openai-compatible",
        base_url: "https://api.deepseek.com",
        enabled: true,
      },
      {
        id: "native",
        name: "Legacy Native",
        protocol: "dashscope",
        base_url: "https://dashscope.aliyuncs.com/api/v1",
        enabled: true,
      },
    );
    config.models.push(
      {
        id: "bad-vector",
        name: "Old vector",
        provider: "deepseek",
        model: "old-vector",
        type: "embedding",
        enabled: false,
        parameters: {},
      },
      {
        id: "bad-chat",
        name: "Old chat",
        provider: "native",
        model: "old-chat",
        type: "chat",
        enabled: false,
        parameters: {},
      },
    );
  });
  const edit = f.input();
  edit.models[0].context_window = 8192;
  const saved = await f.manager.save(edit);
  for (const id of ["bad-vector", "bad-chat"]) {
    const old = saved.models.find((m: any) => m.id === id)!;
    assert.ok(old.configuration_error);
    assert.equal(old.context_window, null);
  }
  const changed = f.input();
  changed.models.find((m: any) => m.id === "bad-chat")!.context_window = 4096;
  const before = await readFile(f.file, "utf8");
  await assert.rejects(
    f.manager.save(changed),
    /DashScope 原生协议当前仅支持 Embedding/,
  );
  assert.equal(await readFile(f.file, "utf8"), before);
});

test("probe and chat never send context window to the provider API", async (t) => {
  const f = await fixture();
  const edit = f.input();
  edit.models[0].context_window = 65536;
  await f.manager.save(edit);
  const payloads: any[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      payloads.push(payload);
      return payload.stream
        ? new Response(
            'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
          )
        : Response.json({ choices: [{ message: { content: "OK" } }] });
    },
  );
  await f.manager.testModel("chat");
  const llm = new LLM(f.logger, [], (id) => resolveModel(f.config, id));
  await llm.chat({
    model: "chat",
    messages: [{ role: "user", content: "Test" }],
  });
  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.equal(Object.hasOwn(payload, "context_window"), false);
    assert.equal(payload.temperature, 0.2);
    assert.equal(payload.max_tokens, 128);
  }
  assert.throws(
    () => validateModelParameters({ context_window: 4096 }),
    /上下文窗口/,
  );
});
