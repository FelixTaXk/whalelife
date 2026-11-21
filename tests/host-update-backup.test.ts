import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.ts";
import { prepareHostBackup, restoreHostBackup, discardHostBackup } from "../core/host-update-backup.ts";

test("试运行写坏资料后按原路径恢复，重复恢复及清理可安全重试", async () => {
  const root = await temporaryDirectory("whale-host-backup-");
  for (const name of ["config", "plugins/gallery/data", "custom/history", "profiles"])
    await mkdir(join(root, name), {recursive: true});
  const config = JSON.stringify({memory: {root: "custom/history"}, personas: {test: {file: "profiles/test.md"}}});
  const before = new Map([["config/config.json", config], ["plugins/gallery/data/image.png", "image bytes"],
    ["custom/history/diary", "old diary"], ["profiles/test.md", "test persona"]]);
  for (const [name, value] of before) await writeFile(join(root, name), value);
  await prepareHostBackup(root);
  for (const name of before.keys()) await writeFile(join(root, name), "incomplete migration");
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data/partial"), "bad");
  // Simulate a process stop between displacing the install directory and restoring its snapshot.
  const items = JSON.parse(await readFile(join(root, ".whalelife-updates/backup/items.json"), "utf8"));
  const index = items.findIndex((item: {path:string}) => item.path === "data");
  await rename(join(root, "data"), join(root, ".whalelife-updates/backup/displaced", String(index)));
  await restoreHostBackup(root);
  await restoreHostBackup(root);
  for (const [name, expected] of before) assert.equal(await readFile(join(root, name), "utf8"), expected);
  await assert.rejects(readFile(join(root, "data/partial")), {code: "ENOENT"});
  await discardHostBackup(root);
  await discardHostBackup(root);
});

test("配置引用实例外资料时在切换前失败并原样保留", async () => {
  const root = await temporaryDirectory("whale-host-external-");
  await mkdir(join(root, "config"));
  const config = JSON.stringify({memory:{root:"../other-instance"},personas:{}});
  await writeFile(join(root, "config/config.json"), config);
  await assert.rejects(prepareHostBackup(root), /实例外/);
  assert.equal(await readFile(join(root, "config/config.json"), "utf8"), config);
});

test("损坏的快照不能被误判成已完成资料恢复", async () => {
  const root = await temporaryDirectory("whale-host-incomplete-backup-");
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({memory: {root: "memory"}, personas: {}}));
  await writeFile(join(root, "data"), "original");
  await prepareHostBackup(root);
  const backup = join(root, ".whalelife-updates/backup");
  const items = JSON.parse(await readFile(join(backup, "items.json"), "utf8"));
  const index = items.findIndex((item: {path:string}) => item.path === "data");
  await unlink(join(backup, "saved", String(index)));
  await writeFile(join(root, "data"), "incomplete");
  await assert.rejects(restoreHostBackup(root), /原始备份或恢复记录缺失/);
  assert.equal(await readFile(join(root, "data"), "utf8"), "incomplete");
});
