import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boot } from "../core/index.ts";

test("memory V2 routes enforce login, local-fact limits and revisions, and explicit sharing settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "whale-memory-v2-web-"));
  await mkdir(join(root, "config"));
  await mkdir(join(root, "memory"));
  const shared = "# facts\n仅用户维护的共享事实\n";
  await writeFile(join(root, "memory/facts.md"), shared);
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
    const base = "http://127.0.0.1:" + (app.web.server.address() as any).port;
    for (const endpoint of ["local-facts", "knowledge", "settings", "spaces"]) {
      assert.equal(
        (await fetch(`${base}/api/memory/${endpoint}?id=one`)).status,
        401,
      );
      assert.equal(
        (
          await fetch(`${base}/api/memory/${endpoint}`, {
            method: "POST",
            body: "{}",
          })
        ).status,
        401,
      );
    }
    const login = await fetch(base + "/api/login", {
      method: "POST",
      body: "{}",
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const get = (path: string) =>
      fetch(base + path, { headers: { Cookie: cookie } });
    const post = (path: string, value: any) =>
      fetch(base + path, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
    const initial = await (await get("/api/memory/local-facts?id=one")).json();
    assert.equal(initial.text, "");
    assert.equal(initial.chars, 0);
    assert.equal(initial.max, 100);
    const full = "鲸".repeat(99) + "🐋";
    const savedResponse = await post("/api/memory/local-facts", {
      id: "one",
      text: full,
      revision: initial.revision,
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.chars, 100);
    assert.equal(saved.text, full);
    const excess = await post("/api/memory/local-facts", {
      id: "one",
      text: full + "\n",
      revision: saved.revision,
    });
    assert.equal(excess.status, 400);
    assert.match((await excess.json()).error, /100/);
    const conflict = await post("/api/memory/local-facts", {
      id: "one",
      text: "过期覆盖",
      revision: initial.revision,
    });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /已变更/);
    const after = await (await get("/api/memory/local-facts?id=one")).json();
    assert.equal(after.text, full);
    assert.equal(after.revision, saved.revision);
    assert.equal(await readFile(join(root, "memory/facts.md"), "utf8"), shared);
    assert.equal(
      (await (await get("/api/memory/local-facts?id=two")).json()).text,
      "",
    );

    const createdResponse = await post("/api/memory/spaces", {
      name: "测试共享空间",
    });
    assert.equal(createdResponse.status, 200);
    const space = await createdResponse.json();
    assert.ok(space.id);
    const settings = {
      enabled: true,
      half_life_days: 30,
      recall_tokens: 800,
      daily_memory_tokens: 0,
    };
    const configured = await post("/api/memory/settings", {
      id: "one",
      settings,
      memberships: [space.id],
    });
    assert.equal(configured.status, 200);
    const knowledgeResponse = await get("/api/memory/knowledge?id=one");
    assert.equal(knowledgeResponse.status, 200);
    const knowledge = await knowledgeResponse.json();
    assert.equal(knowledge.settings.daily_memory_tokens, 0);
    assert.equal(knowledge.settings.recall_tokens, 800);
    assert.deepEqual(knowledge.memberships, [space.id]);
    assert.equal(
      knowledge.spaces.find((entry: any) => entry.id === space.id)?.joined,
      true,
    );
    const other = await (await get("/api/memory/knowledge?id=two")).json();
    assert.deepEqual(other.memberships, []);
    assert.equal(
      other.spaces.find((entry: any) => entry.id === space.id)?.joined,
      false,
    );
  } finally {
    await app.close();
  }
});
