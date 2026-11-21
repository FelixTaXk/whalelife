/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFileSync } from "node:fs";
import { compatibleHostFloor } from "./package-host-range.ts";

type Entry = { id: string; repository: string; verifiedReleases?: Metadata[] };
type Installed = { id: string; version?: string; builtin?: boolean; repository?: unknown };
type Recognition = { plugins: { runtimeId: string; installedVersion: string | null; installed: boolean }[]; recognizedRuntimeIds: string[] };
type Notice = Entry & { runtimeId: string; source: "official" | "community"; installedVersion: string; latestVersion: string; url: string };
type Target = { version: string; url: string };
type Metadata = Record<string, any>;

const market = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/";
const repoPattern = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/?$/;
const idPattern = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const bundled = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));

function repoPath(value: unknown) {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value) return;
  const path = repoPattern.exec(value)?.[1];
  if (path && ![".", ".."].includes(path.split("/")[1])) return path;
}

function parseVersion(value: unknown) {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value) return;
  const match = semver.exec(value);
  if (match && !match[4]?.split(".").some(part => /^0\d+$/.test(part))) {
    return { parts: match.slice(1, 4).map(part => BigInt(part)), prerelease: !!match[4] };
  }
}

// Only stable targets can be advertised. Build metadata has no SemVer precedence.
function newer(target: string, installed: string) {
  const next = parseVersion(target), current = parseVersion(installed);
  if (!next || next.prerelease || !current) return false;
  for (let i = 0; i < next.parts.length; i++) {
    if (next.parts[i] !== current.parts[i]) return next.parts[i] > current.parts[i];
  }
  return current.prerelease;
}

function communityEntries(catalog: Metadata | null): Entry[] | null {
  if (!Array.isArray(catalog?.official) || !Array.isArray(catalog.community)) return null;
  const seen = new Set<string>();
  for (const entry of [...catalog.official, ...catalog.community]) {
    if (!entry || typeof entry.id !== "string" || !idPattern.test(entry.id) || !repoPath(entry.repository) || seen.has(entry.id)) return null;
    seen.add(entry.id);
  }
  return catalog.community;
}

// These metadata reads never forward a browser's Origin, cookies or installed versions.
// Both allowed hosts and all paths are derived from public project catalogs.
async function readJSON(address: string, signal: AbortSignal): Promise<Metadata> {
  const response = await fetch(address, { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error("无法读取公开发行资料");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 ** 2) {
      await reader.cancel();
      throw Error("公开发行资料过大");
    }
    chunks.push(value);
  }
  const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!json || typeof json !== "object" || Array.isArray(json)) throw Error("公开发行资料格式无效");
  return json;
}

function verifiedTarget(entry: Metadata, installed: string, host: string, platform: string, arch: string): Target | undefined {
  let best: Target | undefined;
  for (const release of Array.isArray(entry.verifiedReleases) ? entry.verifiedReleases : []) {
    if (!release || release.recognitionOnly || release.delivery !== "github-release" || release.platform !== platform ||
        release.arch !== arch || !compatibleHostFloor(release.hostRange, host) || !newer(release.version, best?.version ?? installed) ||
        !/^[0-9a-f]{64}$/.test(release.sha256) || !/^[0-9a-f]{64}$/.test(release.inventorySha256) ||
        !Number.isSafeInteger(release.sizeBytes) || release.sizeBytes <= 0) continue;
    const tag = "v" + release.version, asset = release.composition?.packagePart?.assetUrl ?? release.assetUrl;
    const base = entry.repository + "/releases/download/" + tag + "/";
    if (typeof asset !== "string" || !asset.startsWith(base) || !/^[\w.-]+$/.test(asset.slice(base.length))) continue;
    best = { version: release.version, url: entry.repository + "/releases/tag/" + encodeURIComponent(tag) };
  }
  return best;
}

function authorTarget(entry: Entry, release: Metadata | null): Target | undefined {
  if (release?.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") return;
  const tag = release.tag_name, version = tag.replace(/^v/, "");
  const parsed = parseVersion(version);
  if (parsed && !parsed.prerelease) return { version, url: entry.repository.replace(/\/$/, "") + "/releases/tag/" + encodeURIComponent(tag) };
}

export class PluginUpdates {
  private catalog: Metadata;
  private registry: Metadata;
  private host: string = bundled("../package.json").version;
  private cache = new Map<string, { expires: number; value: Promise<Metadata | null> }>();
  private signal: AbortSignal;

  constructor(signal: AbortSignal, catalog = bundled("../market/catalog.json"), registry = bundled("../market/official-releases.json")) {
    this.signal = signal;
    this.catalog = catalog;
    this.registry = registry;
  }

  private read(address: string) {
    const cached = this.cache.get(address);
    if (cached && cached.expires > Date.now()) return cached.value;
    const entry = { expires: Date.now() + 30 * 60_000, value: readJSON(address, this.signal).catch(() => {
      entry.expires = Date.now() + 60_000;
      return null;
    }) };
    this.cache.set(address, entry);
    return entry.value;
  }

  async list(installed: Installed[], recognize: () => Promise<Recognition>) {
    const local = new Map(installed.filter(p => !p.builtin && parseVersion(p.version)).map(p => [p.id, p]));
    if (!local.size) return { updates: [] };
    const [published, publicRegistry] = await Promise.all([this.read(market + "catalog.json"), this.read(market + "official-releases.json")]);
    const community = communityEntries(published) ?? communityEntries(this.catalog) ?? [];
    const updates: Notice[] = [];
    const reserved = new Set<string>();
    const officialCandidates: Notice[] = [];
    for (const entry of this.registry.plugins) {
      const { id, repository } = entry, runtimeId = entry.parentId ? entry.parentId + "/" + id : id;
      reserved.add(id);
      reserved.add(runtimeId);
      const installedVersion = local.get(runtimeId)?.version;
      if (!installedVersion) continue;
      const matches = publicRegistry?.schemaVersion === 1 && Array.isArray(publicRegistry.plugins)
        ? publicRegistry.plugins.filter((other: Metadata) => other?.id === id && other.repository === repository &&
          other.parentId === entry.parentId && other.name === entry.name) : [];
      let target = verifiedTarget(entry, installedVersion, this.host, process.platform, process.arch);
      if (matches.length === 1) target = verifiedTarget(matches[0], target?.version ?? installedVersion, this.host, process.platform, process.arch) ?? target;
      if (target) officialCandidates.push({ id, runtimeId, repository, installedVersion, latestVersion: target.version, url: target.url, source: "official" });
    }
    const official = async () => {
      if (!officialCandidates.length) return;
      const recognition = await recognize().catch(() => null);
      if (!recognition) return;
      for (const item of officialCandidates) {
        if (recognition.recognizedRuntimeIds.includes(item.runtimeId) && recognition.plugins.some(plan =>
          plan.installed && plan.runtimeId === item.runtimeId && plan.installedVersion === item.installedVersion)) updates.push(item);
      }
    };
    // Match full local IDs before requesting metadata. Only the public repository goes to GitHub.
    const authors = async () => {
      const candidates = community.flatMap(entry => {
        const plugin = local.get(entry.id), path = repoPath(entry.repository)!;
        if (!plugin?.version || reserved.has(entry.id) || (plugin.repository != null &&
          repoPath(plugin.repository)?.toLowerCase() !== path.toLowerCase())) return [];
        return [{ entry, path, version: plugin.version }];
      });
      for (let i = 0; i < candidates.length; i += 4) {
        await Promise.all(candidates.slice(i, i + 4).map(async ({ entry, path, version }) => {
          const target = authorTarget(entry, await this.read("https://api.github.com/repos/" + path + "/releases/latest"));
          if (!target || !newer(target.version, version)) return;
          const reviewed = Array.isArray(entry.verifiedReleases) ? entry.verifiedReleases.filter(r => r?.version === target.version) : [];
          if (reviewed.length && !reviewed.some(r => compatibleHostFloor(r.hostRange, this.host) &&
              (r.platform === "any" || r.platform === process.platform) && (r.arch === "any" || r.arch === process.arch))) return;
          updates.push({ id: entry.id, runtimeId: entry.id, repository: entry.repository, installedVersion: version,
            latestVersion: target.version, url: target.url, source: "community" });
        }));
      }
    };
    await Promise.all([official(), authors()]);
    return { updates: updates.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId, "en")) };
  }
}
