import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
export async function startWeb(config: any, services: any, runtime: any) {
  const { logger, memory, sessions } = services;
  const { host = "127.0.0.1", port = 9270 } = config.web;
  if (host !== "127.0.0.1" && (!config.web.lan_enabled || !config.web.password))
    throw Error("局域网监听需 lan_enabled 与访问密码");
  const tokens = new Set<string>();
  const routes = new Map<string, any>();
  const register = (method: string, path: string, handler: any) => {
    if (!path.startsWith("/plugins/") || routes.has(method + " " + path))
      throw Error("插件路由必须位于 /plugins/ 且不可重复");
    const key = method + " " + path;
    routes.set(key, handler);
    return () => routes.delete(key);
  };
  const origin = `http://${host}:${port}`;
  const assets = new Set([
    "styles.css",
    "models.css",
    "app.js",
    "api.js",
    "icons.js",
    "models.js",
    "views.js",
    "personas.js",
    "memory.js",
    "context.js",
  ]);
  const allowedOrigin = (req: any) =>
    !req.headers.origin ||
    req.headers.origin === origin ||
    (config.web.lan_enabled &&
      (() => {
        try {
          const url = new URL(req.headers.origin);
          return url.protocol === "http:" && url.host === req.headers.host;
        } catch {
          return false;
        }
      })());
  const authorized = (req: any) =>
    tokens.has(
      (req.headers.cookie ?? "").match(/(?:^|; )whale=([a-f0-9]+)/)?.[1],
    );
  const body = async (req: any, limit = 65536) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Error("请求过大");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw Error("请求 JSON 格式无效");
    }
  };
  const savePersona = (input: any) => {
    if (sessions.memoryMaintenance) throw Error("记忆恢复中，请稍后编辑人格");
    return memory.serial(() => {
      if (sessions.memoryMaintenance) throw Error("记忆恢复中，请稍后编辑人格");
      return services.modelConfig.savePersona(input);
    });
  };
  const server = createServer(async (req, res) => {
    const send = (status: number, value: any) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (!allowedOrigin(req)) return send(403, { error: "来源无效" });
      if (req.method === "GET" && req.url?.startsWith("/ui/")) {
        const asset = req.url.slice(4);
        if (!assets.has(asset)) return send(404, { error: "文件不存在" });
        res.writeHead(200, {
          "Content-Type": asset.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(await readFile(new URL("./ui/" + asset, import.meta.url)));
        return;
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(await readFile(new URL("./ui/index.html", import.meta.url)));
        return;
      }
      if (req.method === "POST" && req.url === "/api/login") {
        const input = await body(req);
        const expected = String(config.web.password ?? "");
        const actual = String(input.password ?? "");
        if (
          expected &&
          (Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
            !timingSafeEqual(Buffer.from(actual), Buffer.from(expected)))
        )
          return send(401, { error: "访问密码错误" });
        const token = randomBytes(32).toString("hex");
        tokens.add(token);
        res.setHeader(
          "Set-Cookie",
          `whale=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
        return send(200, { ok: true });
      }
      if (!authorized(req)) return send(401, { error: "请先登录" });
      const memoryUrl = new URL(req.url!, origin);
      if (memoryUrl.pathname === "/api/memory/local-facts") {
        if (req.method === "GET")
          return send(
            200,
            await services.memoryEngine.localFacts(
              memoryUrl.searchParams.get("id"),
            ),
          );
        if (req.method === "POST") {
          const input = await body(req, 4096);
          if (typeof input.revision !== "string")
            throw Error("请先读取事实版本");
          return send(
            200,
            await services.memoryEngine.saveLocalFacts(
              input.id,
              input.text,
              input.revision,
            ),
          );
        }
      }
      if (memoryUrl.pathname === "/api/memory/knowledge") {
        if (req.method === "GET")
          return send(
            200,
            await services.memoryEngine.inspect(
              memoryUrl.searchParams.get("id"),
              memoryUrl.searchParams.get("query") || "",
              memoryUrl.searchParams.get("archived") === "true",
            ),
          );
        if (req.method === "POST") {
          const input = await body(req);
          return send(
            200,
            await services.memoryEngine.change(
              input.id,
              input.record_id,
              input.action,
              input.space_id,
            ),
          );
        }
      }
      if (
        req.method === "POST" &&
        memoryUrl.pathname === "/api/memory/settings"
      ) {
        const input = await body(req);
        return send(
          200,
          await services.memoryEngine.settings(
            input.id,
            input.settings,
            input.memberships,
          ),
        );
      }
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/spaces")
        return send(
          200,
          await services.memoryEngine.createSpace((await body(req)).name),
        );
      if (req.method === "GET" && memoryUrl.pathname === "/api/session/context")
        return send(
          200,
          await sessions.contextStatus(memoryUrl.searchParams.get("id")),
        );
      if (
        req.method === "POST" &&
        memoryUrl.pathname === "/api/session/context"
      ) {
        const input = await body(req);
        return send(200, await sessions.updateContext(input.id, input.context));
      }
      if (
        req.method === "POST" &&
        memoryUrl.pathname === "/api/memory/session/rename"
      )
        return send(
          200,
          await services.memoryAdmin.renameSession(await body(req)),
        );
      if (
        req.method === "POST" &&
        memoryUrl.pathname === "/api/memory/session/delete"
      )
        return send(
          200,
          await services.memoryAdmin.deleteSession(await body(req)),
        );
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory")
        return send(
          200,
          await services.memoryAdmin.catalog({
            search: memoryUrl.searchParams.get("search") || "",
            offset: Number(memoryUrl.searchParams.get("offset") || 0),
            limit: Number(memoryUrl.searchParams.get("limit") || 25),
          }),
        );
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory/facts")
        return send(200, await services.memoryAdmin.facts());
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/facts")
        return send(
          200,
          await services.memoryAdmin.saveFacts(await body(req, 131072)),
        );
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory/session")
        return send(
          200,
          await services.memoryAdmin.session(
            memoryUrl.searchParams.get("id"),
            Number(memoryUrl.searchParams.get("offset") || 0),
            Number(memoryUrl.searchParams.get("limit") || 100),
            memoryUrl.searchParams.get("search") || "",
          ),
        );
      if (
        req.method === "GET" &&
        memoryUrl.pathname === "/api/memory/summaries"
      )
        return send(200, await services.memoryAdmin.summaries());
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory/summary")
        return send(
          200,
          await services.memoryAdmin.summary(memoryUrl.searchParams.get("id")),
        );
      if (req.method === "GET" && memoryUrl.pathname === "/api/memory/backups")
        return send(200, await services.memoryAdmin.backups());
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/backup")
        return send(200, await services.memoryAdmin.backup());
      if (req.method === "POST" && memoryUrl.pathname === "/api/memory/restore")
        return send(200, await services.memoryAdmin.restore(await body(req)));
      if (req.method === "GET" && req.url?.startsWith("/api/persona?")) {
        const id = new URL(req.url, origin).searchParams.get("id");
        return send(200, await services.personaFiles.get(id));
      }
      if (req.method === "POST" && req.url === "/api/persona/config")
        return send(200, await savePersona(await body(req)));
      if (req.method === "POST" && req.url === "/api/persona") {
        const input = await body(req);
        const snapshot = services.modelConfig.snapshot();
        const selected = snapshot.personas.find((p: any) => p.id === input.id);
        if (!selected) return send(400, { error: "人格不存在" });
        const result = await savePersona({
          ...input,
          name: selected.name,
          model: selected.model,
          configRevision: snapshot.revision,
          activate: false,
        });
        return send(200, result.persona);
      }
      if (req.url === "/api/model-config" && req.method === "GET")
        return send(200, services.modelConfig.snapshot());
      if (req.url === "/api/model-config" && req.method === "POST") {
        const value = await services.modelConfig.save(await body(req));
        services.llm.providers = config.providers;
        return send(200, value);
      }
      if (req.url === "/api/model-config/models" && req.method === "POST") {
        const value = await body(req);
        return send(
          200,
          await services.modelConfig.listModels(value.providerId),
        );
      }
      if (req.url === "/api/model-config/test" && req.method === "POST") {
        const value = await body(req);
        return send(
          200,
          await services.modelConfig.testModel(
            value.modelId,
            value.detectDimensions === true,
          ),
        );
      }
      if (req.url === "/api/model-config/models/draft" && req.method === "POST")
        return send(
          200,
          await services.modelConfig.listDraftModels(await body(req)),
        );
      if (req.url === "/api/model-config/probe" && req.method === "POST") {
        return send(
          200,
          await services.modelConfig.probeDraft(await body(req)),
        );
      }
      if (req.method === "GET" && req.url?.startsWith("/api/session?")) {
        const id = new URL(req.url, origin).searchParams.get("id");
        if (!id) return send(400, { error: "请提供会话 ID" });
        return send(200, await memory.readSession(id, 100));
      }
      if (req.method === "GET" && req.url === "/api/status")
        return send(200, {
          core: "running",
          models: (config.models ?? config.providers).map((p: any) => ({
            id: p.id,
            model: p.model,
          })),
          persona: config.channels.web.persona,
          personaName: config.personas?.[config.channels.web.persona]?.name,
          permission:
            config.channels.web.permission ??
            config.personas?.[config.channels.web.persona]?.permission,
          memory: await memory.status(),
          plugins: runtime.list(),
        });
      if (req.method === "GET" && req.url === "/api/logs")
        return send(200, logger.lines);
      if (req.method === "POST" && req.url === "/api/plugin") {
        const data = await body(req);
        await runtime.action(data.id, data.action);
        return send(200, { ok: true });
      }
      const route = routes.get(req.method + " " + req.url);
      if (route) {
        await route(req, res);
        return;
      }
      send(404, { error: "接口不存在" });
    } catch (error: any) {
      logger.error("Web 请求失败", { error });
      if (!res.headersSent)
        send(
          [400, 404, 409, 413, 500, 502].includes(error.status)
            ? error.status
            : 400,
          {
            error: error.message,
          },
        );
      else res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on("upgrade", (req, socket, head) => {
    if (
      !allowedOrigin(req) ||
      !authorized(req) ||
      !["/ws/logs", "/ws/chat"].includes(req.url ?? "")
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (ws: WebSocket, req: any) => {
    const send = (data: any) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    };
    if (req.url === "/ws/logs") {
      for (const line of logger.lines) send({ type: "log", line });
      const listener = (line: string) => {
        if (ws.bufferedAmount > 1024 * 1024) {
          ws.close();
          return;
        }
        send({ type: "log", line });
      };
      logger.on("line", listener);
      ws.on("close", () => logger.off("line", listener));
      return;
    }
    let busy = false;
    ws.on("message", async (raw) => {
      if (busy) {
        send({ type: "error", error: "正在回复，请稍候" });
        return;
      }
      busy = true;
      try {
        const data = JSON.parse(raw.toString());
        await sessions.chat(
          data.session,
          String(data.text ?? ""),
          (text: string) => send({ type: "chunk", text }),
          (context: any) => send({ type: "context", ...context }),
          typeof data.persona === "string" ? data.persona : undefined,
        );
        send({ type: "done" });
      } catch (error: any) {
        logger.error("聊天失败", { error });
        send({
          type: "error",
          error: "回复失败：" + error.message + "。请检查配置或日志后重试。",
        });
      } finally {
        busy = false;
      }
    });
    ws.on("error", (error) => logger.warn("WebSocket 错误", { error }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  logger.info("Web 监听", { url: origin });
  return {
    server,
    wss,
    page: (path: string, handler: any) => register("GET", path, handler),
    api: (path: string, handler: any) => register("POST", path, handler),
    async close() {
      for (const ws of wss.clients) ws.close();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
