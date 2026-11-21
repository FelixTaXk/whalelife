import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readdir } from "node:fs/promises";
import { HostUpdates } from "../core/host-updates.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const repository = "https://github.com/iinukami/whalelife";
function metadata(digest: string) {
  const name = "whalelife-v0.1.1.wlhost.gz";
  return {tag_name:"v0.1.1", prerelease:false, draft:false, html_url:repository + "/releases/tag/v0.1.1",
    assets:[{name, size:3, state:"uploaded", digest:"sha256:" + digest,
      browser_download_url:repository + "/releases/download/v0.1.1/" + name}]};
}

test("仅查询、过期版本和未确认操作均不能启动更新；发行包换过摘要时必须重新确认", async () => {
  const root = await temporaryDirectory("whale-host-approval-");
  let digest = "a".repeat(64), fetched = 0, activated = 0;
  const updates = new HostUpdates(root, "0.1.0", () => { activated++; }, async () => {
    fetched++;
    return Response.json(metadata(digest));
  });
  assert.equal((await updates.status()).latest?.version, "0.1.1");
  await updates.status();
  assert.equal(fetched, 1);
  await assert.rejects(updates.apply({ version: "0.1.1", confirmed:false }));
  await assert.rejects(updates.apply({ version: "0.1.2", confirmed:true }));
  assert.deepEqual(await readdir(root), []);
  digest = "b".repeat(64);
  await updates.apply({version:"0.1.1", confirmed:true});
  for (let i=0; i<50 && !(await updates.view()).lastResult; i++) await delay(5);
  const result = await updates.view();
  assert.equal(result.lastResult?.status, "failed");
  assert.match(result.lastResult!.message, /发行版本或摘要已变化/);
  assert.equal(activated, 0);
  assert.deepEqual(await readdir(root), []);
});
