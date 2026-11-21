/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { directoryAt, validPackagePath, verifyReplacementTree, type OfficialPackageSpec } from "./official-package-files.ts";

export const replacementFormat = "whalelife.plugin-replacement/1";
export type ReplacementJournal = {
  format: string; transactionId?: string; old: OfficialPackageSpec; next: OfficialPackageSpec;
  stageIdentity: string; parentIdentity: string; oldIdentity: string; trialIdentity: string;
  children: { path:string; identity:string }[];
};
type Recovery = { directory: string; status: "restored" | "committed" | "pending"; message: string };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const directoryPattern = /^plugins\/[a-z][a-z0-9-]*(?:\/sub\/[a-z][a-z0-9-]*)*$/;
const identityPattern = /^\d+\/[1-9]\d*\/-?\d+$/;
const allowedFiles = new Set(["original", "candidate", "trial", "transaction.json", "committed"]);
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
export const replacementName = (directory: string) => "updating-" + directory.replaceAll("/", ".");

export async function replacementIdentity(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || !info.ino)
    throw Error("无法确认更新目录身份：" + path);
  return [info.dev, info.ino, info.birthtimeNs].join("/");
}
async function existingIdentity(path: string) {
  try { return await replacementIdentity(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
async function readRecord(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw Error("事务记录不是有效的普通文件。");
  return JSON.parse(await readFile(path, "utf8"));
}
function validSpec(spec: OfficialPackageSpec) {
  return spec && typeof spec.directory === "string" && directoryPattern.test(spec.directory) &&
    typeof spec.sha256 === "string" && /^[a-f0-9]{64}$/.test(spec.sha256) &&
    (spec.recognitionOnly === undefined || typeof spec.recognitionOnly === "boolean") &&
    (spec.preserve === undefined || Array.isArray(spec.preserve) && spec.preserve.every(validPackagePath));
}
function validate(j: ReplacementJournal) {
  if (!j || j.format !== replacementFormat || !validSpec(j.old) || !validSpec(j.next) ||
      j.next.recognitionOnly || j.old.directory !== j.next.directory ||
      (j.transactionId !== undefined && (typeof j.transactionId !== "string" || !uuid.test(j.transactionId))) ||
      ![j.stageIdentity, j.parentIdentity, j.oldIdentity, j.trialIdentity].every(id => typeof id === "string" && identityPattern.test(id)) ||
      new Set([j.stageIdentity, j.parentIdentity, j.oldIdentity, j.trialIdentity]).size !== 4 ||
      !Array.isArray(j.children) || j.children.length > 10000 ||
      j.children.some(child => !child || !validPackagePath(child.path) || !/^(?:sub\/[^/]+\/)*sub\/[^/]+$/.test(child.path) ||
        typeof child.identity !== "string" || !identityPattern.test(child.identity)) ||
      new Set(j.children.map(c => c.path.toLowerCase())).size !== j.children.length ||
      new Set(j.children.map(c => c.identity)).size !== j.children.length)
    throw Error("更新事务的版本、路径或目录身份记录不完整。");
  const paths = new Set(j.children.map(c => c.path.toLowerCase()));
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 2; i < parts.length; i += 2)
      if (paths.has(parts.slice(0, i).join("/"))) throw Error("独立子插件恢复路径重叠。");
  }
}

/** A quarantined trial can contain unrecognized local changes. Only the cleanup prefix is eligible for deletion. */
export async function retireReplacement(stage: string, cache: string, quarantine = false) {
  const target = join(cache, (quarantine ? "settled-" : "cleanup-plugin-") + randomUUID());
  await rename(stage, target);
  if (!quarantine) await rm(target, {recursive:true, force:true, maxRetries:3});
  return target;
}

async function recoverOne(root: string, cache: string, name: string): Promise<Recovery> {
  const stage = join(cache, name), cleaning = name.startsWith("cleanup-plugin-");
  let directory = cleaning ? "" : name.slice("updating-".length).replaceAll(".", "/");
  try {
    const stageIdentity = await replacementIdentity(stage);
    const j: ReplacementJournal = await readRecord(join(stage, "transaction.json"));
    validate(j);
    if (cleaning ? !uuid.test(name.slice("cleanup-plugin-".length)) : replacementName(j.old.directory) !== name)
      throw Error("备份位置与目标插件不一致。");
    directory = j.old.directory;
    if (stageIdentity !== j.stageIdentity) throw Error("备份目录身份不一致。");
    const entries = await readdir(stage);
    if (entries.some(entry => !allowedFiles.has(entry))) throw Error("备份中含有归属不明的文件。");
    const parent = await directoryAt(root, directory.slice(0, directory.lastIndexOf("/")));
    if (!parent || await replacementIdentity(parent) !== j.parentIdentity) throw Error("目标父目录已经变化。");
    const base = join(root, directory), original = join(stage, "original");
    const candidate = join(stage, "candidate"), trial = join(stage, "trial");
    const [live, old, next, failed] = await Promise.all([base, original, candidate, trial].map(existingIdentity));
    if ((live && live !== j.oldIdentity && live !== j.trialIdentity) || (old && old !== j.oldIdentity) ||
        (next && next !== j.trialIdentity) || (failed && failed !== j.trialIdentity) ||
        (live === j.oldIdentity && old) || [next, failed, live === j.trialIdentity].filter(Boolean).length > 1)
      throw Error("现场目录身份与更新前记录不一致。");
    const oldTree = old ? original : live === j.oldIdentity ? base : undefined;
    const newTree = next ? candidate : failed ? trial : live === j.trialIdentity ? base : undefined;
    let committed = false;
    if (entries.includes("committed")) {
      const marker = await readRecord(join(stage, "committed"));
      if (marker?.stage !== j.stageIdentity || marker.sha256 !== j.next.sha256) throw Error("提交确认记录不一致。");
      committed = true;
    }
    if (j.transactionId) {
      const {readPackageInstalls} = await import("./community-install-receipts.ts");
      const receipts = await readPackageInstalls(root);
      const id = directory.slice("plugins/".length).replaceAll("/sub/", "/");
      const registered = [receipts.community.get(id), receipts.official.get(id)].some(r =>
        r?.sha256 === j.next.sha256 && (r as {transactionId?: string}).transactionId === j.transactionId);
      if (committed && !registered) throw Error("事务提交标记与本次更新的安装回执不一致。");
      committed = registered;
    }
    // Do not delete either tree on a guess. A partial cleanup missing its last proof stays on disk.
    if (!oldTree && !(cleaning && committed && live === j.trialIdentity))
      throw Error("找不到可确认归属的原版本目录。");
    let preserveTrial = false;
    if (oldTree) {
      const retained = await verifyReplacementTree(root, oldTree, j.old);
      if (committed && oldTree === original && retained.children.length) preserveTrial = true;
    }
    if (newTree) {
      try {
        const paths = await verifyReplacementTree(root, newTree, j.next);
        if (newTree !== base || !committed) preserveTrial ||= paths.children.some(path => !j.children.some(c =>
          path === c.path || c.path.startsWith(path + "/")));
      } catch (error) {
        if (committed) throw error;
        preserveTrial = true; // Incomplete extraction, failed migration or a local edit stays available.
      }
    }
    if (committed && live !== j.trialIdentity) throw Error("已提交回执与实际安装目录不一致。");
    const moved: string[] = [];
    for (const child of j.children) {
      const owner = async (tree: string | undefined) => {
        if (!tree || !await directoryAt(tree, child.path.slice(0, child.path.lastIndexOf("/")))) return;
        return existingIdentity(join(tree, child.path));
      };
      const [a, b] = await Promise.all([owner(oldTree), owner(newTree)]);
      if ((a && a !== child.identity) || (b && b !== child.identity) || (!a && !b) || (a && b) || (committed && !b))
        throw Error("无法唯一确认独立子插件：" + child.path);
      if (b && !committed) moved.push(child.path);
    }
    if (cleaning && ((committed && live !== j.trialIdentity) || (!committed && live !== j.oldIdentity)))
      throw Error("临时清理目录和当前运行版本不一致。");
    if (!committed && oldTree === original) {
      let donor = newTree;
      if (live === j.trialIdentity) { await rename(base, trial); donor = trial; }
      for (const path of moved) {
        await directoryAt(original, path.slice(0, path.lastIndexOf("/")), true);
        await rename(join(donor!, path), join(original, path));
      }
      if (await existingIdentity(base)) throw Error("原安装路径出现了新目录，已保留现场。");
      await rename(original, base);
    } else if (moved.length && !committed) throw Error("独立子插件仍在试运行目录，原目录已被移动。");
    const status = committed ? "committed" : "restored";
    let message = committed ? "已确认提交的新版。" : "已恢复更新前的插件程序和资料。";
    if (cleaning && !preserveTrial) await rm(stage, {recursive:true, force:true, maxRetries:3});
    else {
      const saved = await retireReplacement(stage, cache, preserveTrial);
      if (preserveTrial) message += "含有其他改动的备份已保留在 " + saved;
    }
    return {directory, status, message};
  } catch (error) {
    // Once the staging directory has been retired, any remaining issue concerns cleanup only.
    return {directory:cleaning ? "" : directory, status:"pending", message:text(error) + " 备份保留在 " + stage};
  }
}

export async function recoverReplacementDirectories(root: string, cache: string, live: ReadonlySet<string>) {
  const results: Recovery[] = [];
  for (const name of (await readdir(cache)).sort()) {
    if ((!name.startsWith("updating-") && !name.startsWith("cleanup-plugin-")) || live.has(join(cache, name))) continue;
    results.push(await recoverOne(root, cache, name));
  }
  return results;
}
