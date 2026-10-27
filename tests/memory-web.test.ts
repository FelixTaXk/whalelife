import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boot } from "../core/index.ts";

test("memory console routes require authentication and support revision-safe editing, browsing and recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "whale-memory-web-"));
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config/config.json"),
    JSON.stringify({
      web: { host: "127.0.0.1", port: 0 },
      providers: [],
      personas: {},
      channels: { web: { persona: "none" } },
      memory: { root: "memory" },
    }),
  );
  const app = await boot(root);
  try {
    const url = "http://127.0.0.1:" + (app.web.server.address() as any).port;
    assert.equal((await fetch(url + "/api/memory")).status, 401);
    assert.equal(
      (await fetch(url + "/api/session/context?id=one")).status,
      401,
    );
    for (const path of [
      "/api/session/context",
      "/api/memory/session/rename",
      "/api/memory/session/delete",
    ])
      assert.equal(
        (await fetch(url + path, { method: "POST", body: "{}" })).status,
        401,
      );
    const login = await fetch(url + "/api/login", {
      method: "POST",
      body: "{}",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const get = (path: string) =>
      fetch(url + path, { headers: { Cookie: cookie } });
    const post = (path: string, value: any) =>
      fetch(url + path, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
    const facts = await (await get("/api/memory/facts")).json();
    const saved = await post("/api/memory/facts", {
      revision: facts.revision,
      text: "测试事实",
    });
    assert.equal(saved.status, 200);
    assert.equal(
      (
        await post("/api/memory/facts", {
          revision: facts.revision,
          text: "过期修改",
        })
      ).status,
      409,
    );
    await app.memory.appendEvent({
      session: "web-test",
      type: "message",
      role: "user",
      text: "可搜索的记录",
    });
    const catalog = await (
      await get("/api/memory?search=" + encodeURIComponent("可搜索"))
    ).json();
    assert.equal(catalog.facts.count, 1);
    assert.equal(catalog.sessions.total, 1);
    assert.equal(
      (await (await get("/api/memory/session?id=web-test")).json()).items[0]
        .text,
      "可搜索的记录",
    );
    assert.equal(
      (await get("/api/memory/summary?id=..%2Fconfig%2Fconfig")).status,
      400,
    );
    const backup = await (await post("/api/memory/backup", {})).json();
    assert.equal(
      (
        await post("/api/memory/session/rename", {
          id: "web-test",
          name: "新名字",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await (
          await get("/api/memory?search=" + encodeURIComponent("新名字"))
        ).json()
      ).sessions.total,
      1,
    );
    assert.equal(
      (await post("/api/memory/session/delete", { id: "web-test" })).status,
      200,
    );
    assert.equal((await (await get("/api/memory")).json()).sessions.count, 0);
    const latest = await (await get("/api/memory/facts")).json();
    await post("/api/memory/facts", {
      revision: latest.revision,
      text: "修改之后",
    });
    app.sessions.locks.add("busy");
    assert.equal(
      (await post("/api/memory/restore", { id: backup.id })).status,
      409,
    );
    app.sessions.locks.clear();
    const restored = await post("/api/memory/restore", { id: backup.id });
    assert.equal(restored.status, 200);
    assert.match(
      await readFile(join(root, "memory/facts.md"), "utf8"),
      /测试事实/,
    );
    assert.equal(
      (await (await get("/api/memory/backups")).json()).items.length,
      2,
    );
  } finally {
    await app.close();
  }
});

test("memory page renders untrusted facts and session identifiers as text", async () => {
  const { renderMemory } = await import(
    new URL("../core/ui/memory.js", import.meta.url).href
  );
  const marker = '<img src=x onerror="alert(1)">';
  const state: any = {
    memoryTab: "facts",
    memoryLoadedTab: "facts",
    memoryFactsDraft: marker,
    memoryDetails: {},
    memoryCatalog: {
      root: "memory",
      bytes: 0,
      facts: { count: 1 },
      sessions: { count: 0, bytes: 0 },
      summaries: { count: 0, bytes: 0 },
    },
  };
  assert.ok(!renderMemory({ state }).includes(marker));
  assert.match(renderMemory({ state }), /&lt;img/);
  state.memoryTab = state.memoryLoadedTab = "sessions";
  state.memoryCatalog.sessions = {
    count: 1,
    bytes: 0,
    offset: 0,
    limit: 25,
    total: 1,
    items: [{ id: marker, bytes: 0 }],
  };
  assert.ok(!renderMemory({ state }).includes(marker));
});
