import { test } from "node:test";
import assert from "node:assert/strict";
import { temporaryDirectory } from "./temporary-directory.ts";
import { join } from "node:path";
import { Memory } from "../core/memory.ts";
import { MemoryAdmin } from "../core/memory-admin.ts";
import { Logger } from "../core/logger.ts";

test("chat context uses a compact line while memory retains detailed usage", async () => {
  const { renderContextMeter } = await import(
    new URL("../core/ui/context.js", import.meta.url).href
  );
  const value = {
    model: { name: "chat", context_window: 10000 },
    usage: {
      used_tokens: 1000,
      input_tokens: 800,
      output_tokens: 200,
      percent: 10,
      measured_at: new Date().toISOString(),
    },
  };
  const compact = renderContextMeter(value, true);
  assert.match(compact, /1,000 \/ 10,000 tokens · 10.00%/);
  assert.match(compact, /会话与上下文设置/);
  assert.doesNotMatch(compact, /<progress|<p>|context-meter/);
  assert.match(renderContextMeter(value), /<progress/);
  for (const pending of [
    null,
    { error: "<img src=x>" },
    { model: { context_window: null }, usage: null },
  ]) {
    const text = renderContextMeter(pending, true);
    assert.match(text, /chat-context-compact/);
    assert.doesNotMatch(text, /<img|<p>/);
  }
});

test("archive records the last used persona without binding or changing shared context", async () => {
  const root = await temporaryDirectory("whale-last-persona-");
  const logger = new Logger(join(root, "logs")),
    memory = new Memory(join(root, "memory"), logger);
  await memory.init();
  const admin = new MemoryAdmin(
    memory,
    { root, locks: new Set(), blockedSessions: new Set() },
    logger,
  );
  const context = { history_scope: "session", recent_lines: 30 };
  await memory.saveSessionMeta("shared", { name: "共享会话", context });
  await memory.appendEvent({
    session: "shared",
    type: "message",
    role: "assistant",
    text: "A",
    persona_id: "a",
    persona_name: "Alpha",
  });
  await memory.appendEvent({
    session: "shared",
    type: "message",
    role: "user",
    text: "B",
    persona_id: "b",
    persona_name: "Beta",
  });
  await memory.appendEvent({
    session: "shared",
    type: "tool",
    name: "unrelated",
  });
  await memory.appendEvent({
    session: "legacy",
    type: "message",
    role: "user",
    text: "无元数据",
  });
  await memory.appendEvent({
    session: "id-only",
    type: "message",
    role: "assistant",
    text: "只有ID",
    persona_id: "older",
  });
  const entries = (await admin.catalog()).sessions.items;
  assert.deepEqual(entries.find((x) => x.id === "shared")?.last_persona, {
    id: "b",
    name: "Beta",
  });
  assert.equal(entries.find((x) => x.id === "legacy")?.last_persona, null);
  assert.deepEqual(entries.find((x) => x.id === "id-only")?.last_persona, {
    id: "older",
    name: "older",
  });
  assert.deepEqual((await memory.sessionMeta("shared")).context, context);
  assert.equal((await memory.readSession("shared")).length, 3);
});

test("archive persona labels escape names and distinguish missing historical metadata", async () => {
  const { renderMemory } = await import(
    new URL("../core/ui/memory.js", import.meta.url).href
  );
  const marker = '<img src=x onerror="alert(1)">';
  const html = renderMemory({
    state: {
      session: "test",
      memoryTab: "sessions",
      memoryLoadedTab: "sessions",
      memoryLoadedSession: "test",
      memoryCatalog: {
        root: "memory",
        bytes: 0,
        facts: { count: 0 },
        summaries: { count: 0, bytes: 0 },
        sessions: {
          count: 2,
          bytes: 0,
          total: 2,
          offset: 0,
          limit: 25,
          items: [
            {
              id: "test",
              bytes: 0,
              last_persona: { id: '" onmouseover="bad', name: marker },
            },
            { id: "old", bytes: 0, last_persona: null },
          ],
        },
      },
    },
  });
  assert.match(html, /最后使用人格：&lt;img/);
  assert.match(html, /最后使用人格：未记录/);
  assert.ok(!html.includes(marker));
  assert.doesNotMatch(html, /title="" onmouseover=/);
});
