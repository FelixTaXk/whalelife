import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { boot } from "../core/index.ts";

test("console config API persists model selection, protects secrets and changes the next chat request", async () => {
  const requested: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          data: [{ id: "chat-a" }, { id: "chat-b" }, { id: "vector-a" }],
        }),
      );
    }
    if (req.url === "/v1/embeddings") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }),
      );
    }
    if (req.url === "/v1/chat/completions") {
      requested.push(body.model);
      res.setHeader("Content-Type", "text/event-stream");
      return res.end(
        "data: " +
          JSON.stringify({
            choices: [{ delta: { content: "模型 " + body.model } }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const providerPort = (provider.address() as any).port;
  const root = await mkdtemp(join(tmpdir(), "whale-console-"));
  await mkdir(join(root, "config"));
  const config = {
    web: { host: "127.0.0.1", port: 19274 },
    providers: [
      {
        id: "local",
        base_url: `http://127.0.0.1:${providerPort}/v1`,
        api_key: "private-fixture-secret",
        model: "chat-a",
      },
    ],
    personas: {
      whale: {
        name: "鲸鲸",
        file: "memory/personas/whale.md",
        provider: "local",
        permission: "off",
      },
    },
    channels: { web: { persona: "whale", permission: "off" } },
    memory: { root: "memory" },
    custom: { keep: "unchanged" },
  };
  await writeFile(join(root, "config/config.json"), JSON.stringify(config));
  let app: any;
  const url = "http://127.0.0.1:19274";
  try {
    app = await boot(root);
    const login = await fetch(url + "/api/login", {
      method: "POST",
      body: "{}",
    });
    let cookie = login.headers.get("set-cookie")!.split(";")[0];
    const get = async (path: string) =>
      await fetch(url + path, { headers: { Cookie: cookie } });
    const post = async (path: string, data: any) =>
      fetch(url + path, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    assert.equal((await fetch(url + "/api/model-config")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/model-config/probe", {
          method: "POST",
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal((await get("/")).status, 200);
    assert.equal(
      (await get("/ui/app.js")).headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assert.equal((await get("/ui/not-allowed")).status, 404);
    assert.match(
      (await get("/ui/models.css")).headers.get("content-type") || "",
      /text\/css/,
    );
    let snapshot = await (await get("/api/model-config")).json();
    assert.ok(!JSON.stringify(snapshot).includes("private-fixture-secret"));
    const draft = () => ({
      revision: snapshot.revision,
      providers: snapshot.providers,
      models: snapshot.models,
      bindings: snapshot.bindings,
      personaModels: Object.fromEntries(
        snapshot.personas.map((p: any) => [p.id, p.model]),
      ),
    });
    const next = draft();
    next.models.push(
      {
        id: "second",
        name: "第二个对话模型",
        model: "chat-b",
        provider: "local",
        type: "chat",
        enabled: true,
        parameters: { temperature: 0.2 },
      },
      {
        id: "vector",
        name: "向量模型",
        model: "vector-a",
        provider: "local",
        type: "embedding",
        enabled: true,
        parameters: {},
      },
    );
    next.bindings.chat = "second";
    next.bindings.embedding = "vector";
    const saved = await post("/api/model-config", next);
    assert.equal(saved.status, 200);
    snapshot = await saved.json();
    assert.ok(!JSON.stringify(snapshot).includes("private-fixture-secret"));
    const persisted = JSON.parse(
      await readFile(join(root, "config/config.json"), "utf8"),
    );
    assert.equal(persisted.providers[0].api_key, "private-fixture-secret");
    assert.deepEqual(persisted.custom, { keep: "unchanged" });
    const probe = await post("/api/model-config/test", { modelId: "vector" });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).dimensions, 4);
    const beforeDraftTest = await readFile(
      join(root, "config/config.json"),
      "utf8",
    );
    const draftPayload = {
      provider: {
        ...snapshot.providers[0],
        api_key: "",
        timeout_seconds: 15,
        proxy_url: "",
      },
      model: {
        ...snapshot.models.find((m: any) => m.id === "vector"),
        dimensions: 8,
      },
    };
    assert.equal(
      (await post("/api/model-config/probe", draftPayload)).status,
      502,
    );
    const detected = await post("/api/model-config/probe", {
      ...draftPayload,
      detectDimensions: true,
    });
    assert.equal(detected.status, 200);
    assert.equal((await detected.json()).dimensions, 4);
    assert.equal(
      await readFile(join(root, "config/config.json"), "utf8"),
      beforeDraftTest,
      "draft tests must not save or switch the active model",
    );
    const available = await post("/api/model-config/models", {
      providerId: "local",
    });
    assert.deepEqual((await available.json()).models, [
      "chat-a",
      "chat-b",
      "vector-a",
    ]);
    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url.replace("http", "ws") + "/ws/chat", {
        headers: { Cookie: cookie },
      });
      let text = "";
      const timer = setTimeout(() => {
        ws.close();
        reject(Error("chat timeout"));
      }, 5000);
      ws.on("open", () =>
        ws.send(JSON.stringify({ session: "console-test", text: "测试选择" })),
      );
      ws.on("message", (raw) => {
        const item = JSON.parse(raw.toString());
        if (item.type === "chunk") text += item.text;
        else {
          clearTimeout(timer);
          ws.close();
          if (item.type === "error") reject(Error(item.error));
          else resolve(text);
        }
      });
      ws.on("error", reject);
    });
    assert.match(reply, /chat-b/);
    assert.equal(requested.at(-1), "chat-b");
    assert.equal(
      (await (await get("/api/session?id=console-test")).json()).length,
      2,
    );
    const pluginReply = await app.llm.chat({
      model: "second",
      messages: [{ role: "user", content: "explicit registry selection" }],
    });
    assert.match(pluginReply.text, /chat-b/);
    await assert.rejects(
      () => app.llm.chat({ model: "vector", messages: [] }),
      /对话模型/,
    );
    const invalid = draft();
    invalid.models = invalid.models.filter((m: any) => m.id !== "second");
    assert.equal((await post("/api/model-config", invalid)).status, 400);
    assert.equal((await post("/api/model-config", next)).status, 409);
    const malformed = await fetch(url + "/api/model-config", {
      method: "POST",
      headers: { Cookie: cookie },
      body: '{"api_key":"new-malformed-secret"',
    });
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes("new-malformed-secret"));
    assert.ok(!app.logger.lines.join("\n").includes("new-malformed-secret"));
    await app.close();
    app = await boot(root);
    assert.equal(app.config.model_bindings.chat, "second");
    assert.equal(app.config.model_bindings.embedding, "vector");
  } finally {
    await app?.close();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});
