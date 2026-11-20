/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { directoryAt } from "./official-package-files.ts";

const area = ".whalelife-updates";
const format = "whalelife.host-backup/1";
const reserved = new Set([area, ".git", ".artifacts", "core", "market", "node_modules", "runtime", "tools", "tests",
  "architecture", "start.bat", "package.json", "package-lock.json"]);
type BackupItem = { path: string; present: boolean };

async function stat(path: string) {
  return lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
}

function relativeData(root: string, path: string) {
  const name = relative(root, resolve(root, path)).split(sep).join("/");
  const first = name.split("/")[0].toLowerCase();
  if (!name || first === ".." || isAbsolute(name) || reserved.has(first) || first.startsWith("."))
    throw Error("资料路径位于实例外或与程序目录重叠，无法创建可回滚的本体更新。");
  return name;
}

async function backupPaths(root: string) {
  await directoryAt(root, "config");
  const configFile = join(root, "config/config.json");
  if (!(await lstat(configFile)).isFile()) throw Error("配置文件不是可备份的普通文件。");
  const config = JSON.parse((await readFile(configFile, "utf8")).replace(/^\uFEFF/, ""));
  const names = ["plugins", "config", "memory", "data", "personas", "backups", "logs/executions", config.memory.root,
    ...Object.values<{file: string}>(config.personas).map(p => p.file)];
  const paths: string[] = [];
  for (const name of [...new Set(names.map(p => relativeData(root, p)))].sort((a,b) => a.length-b.length)) {
    if (!paths.some(parent => name === parent || name.startsWith(parent + "/"))) paths.push(name);
  }
  return paths;
}

async function validateBackup(root: string) {
  const base = await directoryAt(root, area + "/backup");
  if (!base) return;
  const owner = join(base, "owner");
  if (!(await lstat(owner)).isFile() || await readFile(owner, "utf8") !== format)
    throw Error("现有备份目录归属不明，请保留现场。");
  return base;
}

export async function prepareHostBackup(root: string) {
  const parent = (await directoryAt(root, area, true))!;
  const paths = await backupPaths(root);
  const committed = join(parent, "backup");
  if (await stat(committed)) throw Error("上次本体更新的资料备份尚待处理。");
  const base = await mkdtemp(join(parent, ".backup-preparing-"));
  try {
    await writeFile(join(base, "owner"), format, { flag: "wx", mode: 0o600 });
    await mkdir(join(base, "saved"));
    await mkdir(join(base, "displaced"));
    await mkdir(join(base, "restoring"));
    const items: BackupItem[] = [];
    for (const path of paths) {
      const source = join(root, path);
      const parentPath = dirname(path).split(sep).join("/");
      await directoryAt(root, parentPath === "." ? "" : parentPath);
      const exists = !!await stat(source);
      if (exists) await cp(source, join(base, "saved", String(items.length)), {
        recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
        filter: async entry => {
          const info = await lstat(entry);
          if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
            throw Error("资料目录含有链接或特殊文件，无法完整备份：" + relative(root, entry));
          return true;
        },
      });
      items.push({ path, present: exists });
    }
    // The supervisor cannot start the trial until this manifest is complete.
    await writeFile(join(base, "items.json"), JSON.stringify(items), { flag: "wx", mode: 0o600 });
    await rename(base, committed);
  } catch (error) {
    await rm(base, {recursive: true, force: true});
    throw error;
  }
}

export async function restoreHostBackup(root: string) {
  const base = await validateBackup(root);
  if (!base) throw Error("缺少更新前的资料备份，已停止恢复。");
  for (const name of ["saved", "displaced", "restoring"]) {
    if (!await directoryAt(root, area + "/backup/" + name)) throw Error("资料备份目录不完整：" + name);
  }
  const items: BackupItem[] = JSON.parse(await readFile(join(base, "items.json"), "utf8"));
  for (const [i, item] of items.entries()) {
    if (typeof item.present !== "boolean" || relativeData(root, item.path) !== item.path) throw Error("备份清单无效。");
    const target = join(root, item.path), saved = join(base, "saved", String(i)), displaced = join(base, "displaced", String(i));
    const restoring = join(base, "restoring", String(i));
    const parent = dirname(item.path).split(sep).join("/");
    await directoryAt(root, parent === "." ? "" : parent, item.present);
    if (item.present && !(await stat(saved))) {
      if (!(await stat(restoring))?.isFile() || !(await stat(target))) throw Error("原始备份或恢复记录缺失：" + item.path);
      continue; // Already renamed back during an earlier interrupted restore.
    }
    if (await stat(target)) await rename(target, displaced);
    if (item.present) {
      await writeFile(restoring, "", {mode: 0o600});
      await rename(saved, target);
    }
  }
}

export async function discardHostBackup(root: string) {
  const base = await validateBackup(root);
  if (base) await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const parent = await directoryAt(root, area);
  if (!parent) return;
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.backup-preparing-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const temp = join(parent, entry.name), owner = join(temp, "owner");
    if ((await stat(owner))?.isFile() && await readFile(owner, "utf8") === format)
      await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
