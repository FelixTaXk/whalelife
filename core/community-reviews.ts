/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFileSync } from "node:fs";
import { validPluginId } from "./plugin-state.ts";
import { parseHostRange } from "./package-host-range.ts";
import type { ReviewedCommunityEntry, ReviewedCommunityRelease } from "./community-packages.ts";

const publishedCatalog = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json";
const official = JSON.parse(readFileSync(new URL("../market/official-releases.json", import.meta.url), "utf8"));
const reservedIds = new Set<string>();
for (const entry of official.plugins) {
  reservedIds.add(entry.id);
  reservedIds.add(entry.parentId ? entry.parentId + "/" + entry.id : entry.id);
  for (const release of entry.verifiedReleases) for (const id of release.bundledPluginIds ?? []) reservedIds.add(id);
}
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const platforms = new Set(["any", "aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32", "android", "netbsd"]);
const arches = new Set(["any", "arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64"]);
const githubRepo = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function version(value: unknown): value is string {
  return typeof value === "string" && versionPattern.test(value);
}
function pluginId(value: unknown): value is string {
  return validPluginId(value) && value.length <= 200;
}
function idList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(pluginId) && new Set(value).size === value.length;
}
function invalid(context: string, detail: string): never {
  throw Error("社区发行包审核记录无效（" + context + "）：" + detail);
}

function reviewedRelease(value: unknown, id: string, repository: string, required: string[]): ReviewedCommunityRelease {
  if (!record(value) || !version(value.version) || typeof value.hostRange !== "string" || !parseHostRange(value.hostRange) ||
      typeof value.platform !== "string" || !platforms.has(value.platform) ||
      typeof value.arch !== "string" || !arches.has(value.arch))
    return invalid(id, "缺少经过验证的插件版本、宿主版本或运行平台");
  const prefix = repository.replace(/\/$/, "") + "/releases/download/v" + value.version + "/";
  if (typeof value.assetUrl !== "string" || !value.assetUrl.startsWith(prefix) ||
      !/^[A-Za-z0-9_-][A-Za-z0-9._+-]{0,180}\.wlpkg\.gz$/.test(value.assetUrl.slice(prefix.length)) ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 2 * 1024 ** 3)
    return invalid(id, "附件须固定到原仓库对应正式版本，并填写确切大小和 SHA-256");
  const deps = value.dependencies;
  if (!record(deps) || Object.keys(deps).length !== required.length ||
      !required.every(key => Object.hasOwn(deps, key) && version(deps[key])))
    return invalid(id, "每项必需插件都要登记已验证的版本");
  const children = value.bundledPluginIds ?? [];
  if (!idList(children) || children.some(child => !child.startsWith(id + "/")))
    return invalid(id, "包内子插件必须使用归属本插件的完整 ID");
  return { version: value.version, hostRange: value.hostRange, platform: value.platform, arch: value.arch,
    assetUrl: value.assetUrl, sha256: value.sha256, sizeBytes: value.sizeBytes,
    dependencies: Object.fromEntries(required.map(key => [key, deps[key] as string])), bundledPluginIds: children };
}

/** Only the maintainer-published catalog supplies executable package references. */
export function reviewedCommunityEntries(catalog: unknown): ReviewedCommunityEntry[] {
  if (!record(catalog) || !Array.isArray(catalog.community) || !Array.isArray(catalog.official))
    return invalid("catalog", "目录结构不完整");
  const owners = new Map<string, string>();
  for (const id of reservedIds) owners.set(id, "official");
  for (const entry of catalog.official) {
    if (!record(entry) || !pluginId(entry.id)) return invalid("official", "无效的官方条目");
    owners.set(entry.id, "official");
  }
  for (const entry of catalog.community) {
    if (!record(entry) || !pluginId(entry.id) || owners.has(entry.id)) return invalid("catalog", "插件 ID 无效或重名");
    owners.set(entry.id, entry.id);
  }
  const reviewed: ReviewedCommunityEntry[] = [];
  for (const entry of catalog.community) {
    if (entry.verifiedReleases === undefined) continue;
    const id: string = entry.id;
    const repo = typeof entry.repository === "string" && githubRepo.exec(entry.repository);
    if (!repo || [".", ".."].includes(repo[2]) || typeof entry.name !== "string" || !entry.name.trim() ||
        typeof entry.installation !== "string" || typeof entry.description !== "string" ||
        !idList(entry.dependencies) || entry.dependencies.includes(id) ||
        !Array.isArray(entry.verifiedReleases) || entry.verifiedReleases.length > 256)
      return invalid(id, "仓库、依赖或发行版本列表不完整");
    if (id.includes("/") && !entry.dependencies.includes(id.slice(0, id.lastIndexOf("/"))))
      return invalid(id, "子插件需要登记直接父插件依赖");
    const releases: ReviewedCommunityRelease[] = [];
    for (const value of entry.verifiedReleases) {
      const release = reviewedRelease(value, id, entry.repository, entry.dependencies);
      const minimumHost = parseHostRange(release.hostRange)!.minimum;
      const overlaps = (a: string, b: string) => a === b || a === "any" || b === "any";
      if (releases.some(prev => prev.version === release.version && parseHostRange(prev.hostRange)!.minimum === minimumHost &&
        overlaps(prev.platform, release.platform) && overlaps(prev.arch, release.arch))) return invalid(id, "同版本的平台匹配重复");
      for (const child of release.bundledPluginIds ?? []) {
        const owner = owners.get(child);
        if (owner && owner !== id) return invalid(id, "包内子插件 ID 已被占用：" + child);
        owners.set(child, id);
      }
      releases.push(release);
    }
    if (releases.length) reviewed.push({ id, repository: entry.repository, name: entry.name, description: entry.description,
      installation: entry.installation, dependencies: entry.dependencies, verifiedReleases: releases });
  }
  return reviewed;
}

export async function readPublishedCommunityReviews(shutdown: AbortSignal, request = fetch) {
  const response = await request(publishedCatalog, { cache: "no-store", redirect: "error", credentials: "omit",
    referrerPolicy: "no-referrer", signal: AbortSignal.any([shutdown, AbortSignal.timeout(8_000)]) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error("暂时无法核对主仓的社区发行包审核记录。");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw Error("社区插件目录过大。"); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return reviewedCommunityEntries(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
