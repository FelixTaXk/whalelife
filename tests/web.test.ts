import { test } from "node:test";
import assert from "node:assert/strict";
import { temporaryDirectory } from "./temporary-directory.ts";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Logger } from "../core/logger.ts";
import { startWeb } from "../core/web.ts";
test("authenticated HTTP/WS, cross-origin rejection and same-source logs", async () => {
  const logger = new Logger(await temporaryDirectory("whale-web-"));
  const config = {
    web: { host: "127.0.0.1", port: 19271, password: "测试密码" },
    providers: [],
    channels: { web: { persona: "test", permission: "off" } },
  };
  const app = await startWeb(
    config,
    {
      logger,
      memory: { status: async () => ({ files: 0 }) },
      sessions: {
        chat: async (_id: any, _text: any, onChunk: any) => {
          onChunk("你好");
        },
      },
    },
    { list: () => [] },
  );
  try {
    const url = "http://127.0.0.1:19271";
    assert.equal((await fetch(url + "/api/status")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/login", {
          method: "POST",
          headers: { Origin: "http://foreign.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/api/login", {
          method: "POST",
          body: JSON.stringify({ password: "wrong" }),
        })
      ).status,
      401,
    );
    const login = await fetch(url + "/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "测试密码" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await fetch(url + "/api/status", { headers: { Cookie: cookie } }))
        .status,
      200,
    );
    const ws = new WebSocket("ws://127.0.0.1:19271/ws/logs", {
      headers: { Cookie: cookie },
    });
    await once(ws, "open");
    const result = new Promise<any>((resolve) =>
      ws.on("message", (raw) => {
        const row = JSON.parse(raw.toString());
        if (row.line.includes("same-source-marker")) resolve(row);
      }),
    );
    logger.info("same-source-marker");
    const line = (await result).line;
    assert.equal(line, logger.lines.at(-1));
    ws.close();
    await once(ws, "close");
    const remove = app.page("/plugins/test", (_req: any, res: any) =>
      res.end("plugin page"),
    );
    assert.equal(
      await (
        await fetch(url + "/plugins/test", { headers: { Cookie: cookie } })
      ).text(),
      "plugin page",
    );
    remove();
    assert.equal(
      (await fetch(url + "/plugins/test", { headers: { Cookie: cookie } }))
        .status,
      404,
    );
  } finally {
    await app.close();
  }
  await assert.rejects(
    () =>
      startWeb(
        { ...config, web: { host: "0.0.0.0", port: 19271 } },
        { logger },
        {},
      ),
    /局域网/,
  );
});
