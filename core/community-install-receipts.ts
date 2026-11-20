/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomic } from "./memory.ts";
import { directoryAt } from "./official-package-files.ts";
import { validPluginId } from "./plugin-state.ts";

export type CommunityInstallReceipt = { id: string; name: string; version: string; sha256: string; dependencies: string[] };
const filename = "community-installs.json";
const maxReceiptBytes = 4 * 1024 * 1024;

export async function readCommunityInstalls(root: string): Promise<Map<string, CommunityInstallReceipt>> {
  const receipts = new Map<string, CommunityInstallReceipt>();
  const config = await directoryAt(root, "config");
  if (!config) return receipts;
  const file = join(config, filename);
  const stat = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
  if (!stat) return receipts;
  if (!stat.isFile() || stat.size > maxReceiptBytes) throw Error("社区插件安装记录不是有效的本地文件。");
  const record = JSON.parse(await readFile(file, "utf8"));
  if (record?.format !== 1 || !Array.isArray(record.installs)) throw Error("社区插件安装记录格式无效。");
  for (const item of record.installs) {
    if (!validPluginId(item?.id) || receipts.has(item.id) || typeof item.name !== "string" || typeof item.version !== "string" ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Array.isArray(item.dependencies) || !item.dependencies.every(validPluginId)) throw Error("社区插件安装记录不完整。");
    receipts.set(item.id, item);
  }
  return receipts;
}

/** Called inside the host's package transaction, after every newly installed plugin is active. */
export async function recordCommunityInstalls(root: string, installs: CommunityInstallReceipt[]) {
  if (!installs.length) return;
  const current = await readCommunityInstalls(root);
  for (const item of installs) current.set(item.id, item);
  const content = JSON.stringify({ format: 1, installs: [...current.values()] }, null, 2);
  if (Buffer.byteLength(content) > maxReceiptBytes) throw Error("社区插件安装记录超过大小限制。");
  const config = (await directoryAt(root, "config", true))!;
  await atomic(join(config, filename), content);
}
