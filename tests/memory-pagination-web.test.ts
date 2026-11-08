/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "../core/index.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

test("knowledge HTTP returns only requested pages, filters on the server and rejects invalid bounds", async t => {
  const root = await temporaryDirectory("whale-knowledge-http-");
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  t.after(async () => { await app?.close(); });
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({
    web: { host: "127.0.0.1", port: 0 }, providers: [], personas: {},
    channels: { web: { persona: "none" } }, memory: { root: "memory" }, log: { level: "error" },
  }));
  app = await boot(root);
  app.llm.chat = async () => { throw Error("Pagination must never call a model"); };
  for (let i = 0; i < 63; i++) await app.memory.appendEvent({
    session: "one", type: "message", role: "user", id: `page_${i}`,
    text: `SYNTHETIC_PAGE_ONLY_${i} 海盐冰淇淋`, ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  });
  await app.memory.appendEvent({ session: "two", type: "message", role: "user", text: "PRIVATE_OTHER_SESSION 海盐冰淇淋" });
  const original = await app.memory.readSession("one"), trace = (await app.memoryEngine.state("one")).trace;
  const base = "http://127.0.0.1:" + (app.web.server.address() as any).port;
  assert.equal((await fetch(base + "/api/memory/knowledge?id=one&offset=25&limit=25")).status, 401);
  const login = await fetch(base + "/api/login", { method: "POST", body: "{}" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const get = (params = "") => fetch(base + "/api/memory/knowledge?id=one" + params, { headers: { Cookie: cookie } });
  const first = await (await get()).json();
  assert.deepEqual([first.total, first.offset, first.limit, first.items.length], [63, 0, 25, 25]);
  assert.deepEqual(first.items.map((x: any) => x.id), Array.from({ length: 25 }, (_, i) => `page_${62 - i}`));
  const secondResponse = await get("&offset=25&limit=25");
  assert.equal(secondResponse.status, 200);
  const serialized = await secondResponse.text(), second = JSON.parse(serialized);
  assert.deepEqual([second.total, second.offset, second.limit, second.items.length], [63, 25, 25, 25]);
  assert.equal(second.items[0].id, "page_37");
  assert.doesNotMatch(serialized, /SYNTHETIC_PAGE_ONLY_62|PRIVATE_OTHER_SESSION/);
  const last = await (await get("&offset=999&limit=25")).json();
  assert.deepEqual([last.offset, last.items.length], [50, 13]);
  const matches = await (await get("&query=" + encodeURIComponent("海盐冰淇淋") + "&offset=25&limit=25")).json();
  assert.deepEqual([matches.total, matches.offset, matches.items.length], [63, 25, 25]);
  const absent = await (await get("&query=unmatched_unique_word&offset=25&limit=25")).json();
  assert.deepEqual([absent.total, absent.offset, absent.items.length], [0, 0, 0]);
  for (const params of ["&offset=-1", "&offset=1.5", "&offset=NaN", "&offset=9007199254740992", "&limit=0", "&limit=101", "&limit=Infinity"]) {
    const bad = await get(params);
    assert.equal(bad.status, 400, params);
  }
  assert.deepEqual((await app.memoryEngine.state("one")).trace, trace);
  assert.deepEqual(await app.memory.readSession("one"), original);
});
