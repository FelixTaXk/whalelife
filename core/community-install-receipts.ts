/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomic } from "./memory.ts";
import { directoryAt } from "./official-package-files.ts";
import { validPluginId } from "./plugin-state.ts";
import { parseHostRange } from "./package-host-range.ts";

export type CommunityInstallReceipt = { id: string; name: string; version: string; sha256: string; dependencies: string[];
  hostRange?: string; dependencyVersions?: Record<string, string>; transactionId?: string };
export type OfficialInstallReceipt = CommunityInstallReceipt & { repository: string; platform: string; arch: string;
  bundledPluginIds: string[]; preserve: string[] };
const filename = "community-installs.json";
const maxReceiptBytes = 4 * 1024 * 1024;

export async function readPackageInstalls(root: string) {
  const receipts = {community:new Map<string, CommunityInstallReceipt>(), official:new Map<string, OfficialInstallReceipt>()};
  const config = await directoryAt(root, "config");
  if (!config) return receipts;
  const file = join(config, filename);
  const stat = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
  if (!stat) return receipts;
  if (!stat.isFile() || stat.size > maxReceiptBytes) throw Error("社区插件安装记录不是有效的本地文件。");
  const record = JSON.parse(await readFile(file, "utf8"));
  if (record?.format !== 1 || !Array.isArray(record.installs) ||
      (record.officialInstalls !== undefined && !Array.isArray(record.officialInstalls))) throw Error("插件安装记录格式无效。");
  for (const item of [...record.installs, ...(record.officialInstalls ?? [])]) {
    if (!validPluginId(item?.id) || typeof item.name !== "string" || typeof item.version !== "string" ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        (item.hostRange !== undefined && !parseHostRange(item.hostRange)) ||
        (item.transactionId !== undefined && (typeof item.transactionId !== "string" ||
          !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(item.transactionId))) ||
        !Array.isArray(item.dependencies) || !item.dependencies.every(validPluginId) ||
        (item.dependencyVersions !== undefined && (!item.dependencyVersions || typeof item.dependencyVersions !== "object" ||
          Array.isArray(item.dependencyVersions) || Object.keys(item.dependencyVersions).length !== item.dependencies.length ||
          !item.dependencies.every((id: string) => typeof item.dependencyVersions[id] === "string" && /^\d+\.\d+\.\d+$/.test(item.dependencyVersions[id])))))
      throw Error("社区插件安装记录不完整。");
  }
  for (const item of record.installs) {
    if (receipts.community.has(item.id)) throw Error("社区插件安装记录重复。");
    receipts.community.set(item.id,item);
  }
  for (const item of record.officialInstalls ?? []) {
    if (receipts.official.has(item.id) || typeof item.repository !== "string" || !/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(item.repository) ||
        typeof item.platform !== "string" || typeof item.arch !== "string" || !Array.isArray(item.preserve) ||
        !item.preserve.every((p: unknown) => typeof p === "string") || !Array.isArray(item.bundledPluginIds) ||
        !item.bundledPluginIds.every((id: unknown) => validPluginId(id) && id.startsWith(item.id + "/"))) throw Error("官方插件安装记录无效。");
    receipts.official.set(item.id,item);
  }
  return receipts;
}

/** Called inside the host's package transaction, after every newly installed plugin is active. */
export async function recordPackageInstalls(root: string, installs: CommunityInstallReceipt[], official: OfficialInstallReceipt[] = []) {
  if (!installs.length && !official.length) return;
  const current = await readPackageInstalls(root);
  for (const item of installs) current.community.set(item.id, item);
  for (const item of official) current.official.set(item.id, item);
  const content = JSON.stringify({ format: 1, installs: [...current.community.values()], officialInstalls: [...current.official.values()] }, null, 2);
  if (Buffer.byteLength(content) > maxReceiptBytes) throw Error("社区插件安装记录超过大小限制。");
  const config = (await directoryAt(root, "config", true))!;
  await atomic(join(config, filename), content);
}

export { recordPackageInstalls as recordCommunityInstalls };

export async function readCommunityInstalls(root: string) {
  return (await readPackageInstalls(root)).community;
}
