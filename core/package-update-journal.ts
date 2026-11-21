/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import {createHash} from "node:crypto";
import {lstat, readFile, readdir, rename, unlink} from "node:fs/promises";
import {join} from "node:path";
import {readPackageInstalls} from "./community-install-receipts.ts";
import {atomic} from "./memory.ts";
import {directoryAt, rollbackInterruptedInstall, type OfficialPackageSpec} from "./official-package-files.ts";
import {validPluginId} from "./plugin-state.ts";
import type {Runtime} from "./runtime.ts";

type Change = {id:string; action:"enable"|"install"; enabled:boolean; mayRemove:boolean; files:OfficialPackageSpec;
  dependencies:string[]; bundled:string[]};
type Journal = {format:1; transactionId:string; target:string; sha256:string; baseline:Record<string,string>;
  changes:Change[]; started:number};
const cache = ".artifacts/official-packages";
const prefix = "update-dependencies-";
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const digest = /^[\da-f]{64}$/;
const missing = (err:unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

// Before normal discovery there are no runtime dependency records. Detect later additions
// and manifest changes conservatively; an unknown consumer may need the newly installed dependency.
async function manifests(root:string) {
  const result:Record<string,string> = Object.create(null);
  async function visit(relative:string, parentId:string) {
    const dir = await directoryAt(root, relative);
    if (!dir) return;
    for (const child of await readdir(dir, {withFileTypes:true})) {
      if (!validPluginId(child.name)) continue;
      if (child.isSymbolicLink()) throw Error("插件目录含有链接，无法确认依赖：" + child.name);
      if (!child.isDirectory()) continue;
      const id = parentId ? parentId + "/" + child.name : child.name;
      const path = join(dir, child.name, "plugin.yaml");
      const info = await lstat(path).catch(e => { if (!missing(e)) throw e; });
      if (info) {
        if (!info.isFile() || info.size > 2 * 1024 ** 2) throw Error("无法核对插件清单：" + id);
        result[id] = createHash("sha256").update(await readFile(path)).digest("hex");
      }
      await visit(relative + "/" + child.name + "/sub", id);
    }
  }
  await visit("plugins", "");
  return result;
}

export async function beginUpdateDependencies(root:string, transactionId:string, target:string, sha256:string, changes:Change[]) {
  if (!changes.length) return;
  const dir = (await directoryAt(root, cache, true))!;
  const path = join(dir,prefix + transactionId + ".json");
  const data:Journal = {format:1, transactionId, target, sha256, changes, started:0, baseline:await manifests(root)};
  if (!valid(data,prefix + transactionId + ".json")) throw Error("依赖程序的安装状态已经变化，请重新检查更新。");
  await atomic(path,JSON.stringify(data));
  return {
    start: async (id:string) => {
      if (data.changes[data.started]?.id !== id) throw Error("更新依赖步骤与确认计划不一致。");
      data.started++;
      await atomic(path,JSON.stringify(data));
    },
    finish: () => unlink(path),
  };
}

function valid(data:Journal, name:string) {
  return data?.format === 1 && uuid.test(data.transactionId) && name === prefix + data.transactionId + ".json" &&
    validPluginId(data.target) && digest.test(data.sha256) && data.baseline && typeof data.baseline === "object" &&
    !Array.isArray(data.baseline) && Object.entries(data.baseline).every(([id, value]) => validPluginId(id) && digest.test(value)) &&
    Object.hasOwn(data.baseline,data.target) && Array.isArray(data.changes) && data.changes.length <= 1024 &&
    Number.isInteger(data.started) && data.started >= 0 && data.started <= data.changes.length &&
    data.changes.every(c => c && validPluginId(c.id) && c.id !== data.target && ["install","enable"].includes(c.action) &&
      typeof c.enabled === "boolean" && typeof c.mayRemove === "boolean" && c.files?.directory === "plugins/" + c.id.split("/").join("/sub/") &&
      (c.action === "enable" ? !c.enabled && Object.hasOwn(data.baseline,c.id) : !Object.hasOwn(data.baseline,c.id)) &&
      digest.test(c.files.sha256) && (c.action === "enable" || !c.files.recognitionOnly) && (c.files.preserve === undefined ||
        (Array.isArray(c.files.preserve) && c.files.preserve.every(p => typeof p === "string"))) &&
      Array.isArray(c.dependencies) && c.dependencies.every(validPluginId) &&
      Array.isArray(c.bundled) && c.bundled.every(id => validPluginId(id) && id.startsWith(c.id + "/")));
}

async function recover(runtime:Runtime, dir:string, name:string) {
  const path = join(dir,name), info = await lstat(path);
  if (!info.isFile() || info.size > 4 * 1024 ** 2) throw Error("更新依赖记录格式异常。");
  const data:Journal = JSON.parse(await readFile(path,"utf8"));
  if (!valid(data,name)) throw Error("更新依赖记录无效。");
  const receipts = await readPackageInstalls(runtime.root);
  const receipt = receipts.official.get(data.target) ?? receipts.community.get(data.target);
  if (receipt?.sha256 === data.sha256 && receipt.transactionId === data.transactionId) return unlink(path);
  const switching = "updating-plugins." + data.target.split("/").join(".sub.");
  const affected = [data.target, ...data.changes.map(c => c.id)];
  const blocked = [...runtime.packageRecoveryBlocks.keys()].some(id => affected.some(part =>
    id === part || part.startsWith(id + "/") || id.startsWith(part + "/")));
  if (blocked || (await readdir(dir)).includes(switching)) {
    runtime.logger.warn("目标插件尚待恢复，已保留它的依赖和事务记录", {id:data.target});
    return;
  }
  const current = await manifests(runtime.root);
  if (current[data.target] !== data.baseline[data.target]) throw Error("目标插件并非更新前的版本。");
  const started = data.changes.slice(0,data.started);
  const planned = new Set(started.filter(c => c.action === "install").flatMap(c => [c.id,...c.bundled]));
  const newConsumer = Object.entries(current).some(([id,sha]) => !planned.has(id) && data.baseline[id] !== sha);
  const allReceipts = [...receipts.official.values(), ...receipts.community.values()];
  for (const c of [...started].reverse()) {
    if (c.action === "enable") {
      if (current[c.id] !== data.baseline[c.id]) throw Error("依赖已被另外更改，保留当前启停设置：" + c.id);
      if (runtime.pluginState.enabled(c.id)) await runtime.pluginState.setEnabled(c.id,false);
      continue;
    }
    const used = !c.mayRemove || newConsumer ||
      Object.keys(current).some(id => id.startsWith(c.id + "/") && !c.bundled.includes(id)) ||
      allReceipts.some(r => current[r.id] && r.dependencies.includes(c.id)) ||
      started.some(other => current[other.id] && other.dependencies.includes(c.id));
    if (used) { runtime.logger.warn("已保留可能仍有其他插件依赖的程序", {id:c.id}); continue; }
    await rollbackInterruptedInstall(runtime.root,c.files);
    if (!c.enabled && runtime.pluginState.enabled(c.id)) await runtime.pluginState.setEnabled(c.id,false);
    delete current[c.id];
    for (const child of c.bundled) delete current[child];
  }
  await unlink(path);
  runtime.logger.info("已恢复被中断的插件更新依赖", {id:data.target});
}

/** Run after recovery of the target tree and before discovering or starting third-party plugins. */
export async function recoverUpdateDependencies(runtime:Runtime) {
  try {
    const dir = await directoryAt(runtime.root,cache);
    if (!dir) return;
    await runtime.pluginState.load();
    for (const name of await readdir(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      try { await recover(runtime,dir,name); }
      catch (error) {
        const path = join(dir,name);
        // Leave questionable files untouched and take this intent out of automatic replay.
        await rename(path,path + ".held").catch(() => {});
        runtime.logger.warn("插件更新依赖需人工核对，已保留记录", {file:name,error});
      }
    }
  } catch (error) { runtime.logger.warn("无法检查中断的插件更新依赖", {error}); }
}
