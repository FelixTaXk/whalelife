/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspectOfficialFiles, installOfficialFiles, uninstallOfficialFiles } from "./official-package-files.ts";
import { ensureOfficialPackage } from "./official-package-download.ts";
import type { Runtime } from "./runtime.ts";
import { readCommunityInstalls, type CommunityInstallReceipt } from "./community-install-receipts.ts";

export type PackageRelease = {
  version: string; hostRange: string; platform: string; arch: string; sha256: string;
  assetUrl?: string; sizeBytes?: number; inventorySha256?: string;
  composition?: Pick<Parameters<typeof import("./official-package-composition.ts").ensureComposedOfficialPackage>[1], "packagePart" | "zipPart"> & { name: string; version: string };
  dependencies: Record<string, string>; bundledPluginIds?: string[]; recognitionOnly?: boolean;
};
type Release = PackageRelease;
export type PackageEntry = { id: string; name: string; repository: string; parentId: string | null; requiredPlugins: string[]; preserve?: string[]; verifiedReleases: Release[];
  community?: boolean };
type Entry = PackageEntry;
type InstalledBuild = { runtimeId: string; version: string; platform: string; arch: string; sha256: string; sourceCommit: string };
type Card = { id: string; description: string; installation: string };
type CommunityPolicy = {
  available(root: string, id: string): Promise<void>;
  verify(root: string, entry: Entry, release: Release): Promise<void>;
  installed(root: string, packages: Array<{entry: Entry; release: Release}>): Promise<void>;
};
type Step = { action: "install" | "enable" | "reuse" | "uninstall"; id: string; name: string; version: string };
type Item = { entry: Entry; pathId: string; eligible: Release[]; target?: Release; existing?: Release; installedVersion?: string; installed: boolean; reason: string; enabled: boolean; active: boolean };
const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const registry: { plugins: Entry[]; installedBuilds?: InstalledBuild[] } = read("../market/official-releases.json");
const cards: Card[] = read("../market/catalog.json").official;
const hostVersion: string = read("../package.json").version;
const compare = (left: string, right: string) => {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};
/** The release registry pins the host and dependency versions exercised together. */
const matches = (version: string, verifiedVersion: string) => version === verifiedVersion;
const spec = (item: Item, release: Release) => ({ directory: "plugins/" + item.pathId.split("/").join("/sub/"),
  sha256: release.sha256, recognitionOnly: release.recognitionOnly, preserve: item.entry.preserve });
function inventorySpec(item: Item, release: Release) {
  const files = spec(item, release);
  return release.inventorySha256 ? { ...files, sha256: release.inventorySha256, recognitionOnly: true } : files;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const releaseFor = (part: Item, version: string) => part.existing ?? part.eligible.find(r => r.version === version)!;

export class PluginPackages {
  private communityReceipts = new Map<string, CommunityInstallReceipt>();
  private receiptError = "";
  private runtime: Runtime;
  private entries: Entry[];
  private installedBuilds: InstalledBuild[];
  private cards: Card[];
  private community?: CommunityPolicy;
  constructor(runtime: Runtime, entries = registry.plugins, installedBuilds = registry.installedBuilds ?? [],
    catalogCards = cards, community?: CommunityPolicy) {
    this.runtime = runtime;
    this.entries = entries;
    this.installedBuilds = installedBuilds;
    this.cards = catalogCards;
    this.community = community;
  }

  private async inspect(entry: Entry): Promise<Item> {
    const runtime = this.runtime;
    const pathId = entry.parentId ? entry.parentId + "/" + entry.id : entry.id;
    const record = runtime.records.get(pathId);
    const releases = entry.verifiedReleases.filter(r => (r.platform === process.platform || (entry.community && r.platform === "any")) &&
      (r.arch === process.arch || (entry.community && r.arch === "any")))
      .sort((a, b) => compare(b.version, a.version));
    const eligible = releases.filter(r => !r.recognitionOnly && matches(hostVersion, r.hostRange));
    const target = eligible[0];
    const item: Item = { entry, pathId, eligible, target, installedVersion: record?.manifest.version, installed: !!record,
      enabled: runtime.pluginState.enabled(pathId), active: record?.status === "active", reason: "" };
    const candidates = record ? releases.filter(r => r.version === item.installedVersion) : target ? [target] : [];
    if (!candidates.length) {
      item.reason = record ? "当前安装版本未匹配已验证的发行包，无法确认程序文件归属。"
        : releases.length ? "当前 WhaleLife 没有兼容版本，请先升级 WhaleLife。" : "此平台还没有验证过的发行包。";
      return item;
    }
    if (entry.community && !record) {
      try { await this.community!.available(runtime.root, pathId); }
      catch (error) { item.reason = errorText(error); }
      return item;
    }
    for (const candidate of candidates) try {
      const inspection = await inspectOfficialFiles(runtime.root, inventorySpec(item, candidate));
      if (inspection.state === "installed") {
        item.installed = true;
        item.installedVersion = candidate.version;
        item.existing = candidate;
        item.reason = "";
        break;
      } else if (inspection.state === "blocked") item.reason = inspection.reason || "无法确认发行包的程序文件。";
      else if (record) item.reason = "运行中的记录与磁盘文件不一致，请重新扫描后再操作。";
    } catch (error) { item.reason = errorText(error); }
    return item;
  }

  private dependents(item: Item) {
    const runtime = this.runtime, owned = new Set([item.pathId, ...(item.existing?.bundledPluginIds ?? [])]);
    const services = new Set([item.entry.id]);
    if (!item.pathId.includes("/"))
      for (const name of runtime.records.get(item.pathId)?.provided ?? []) services.add(name);
    const result = new Set<string>();
    for (const record of runtime.records.values()) {
      if (record.manifest.builtin || owned.has(record.id)) continue;
      const receipt = this.communityReceipts.get(record.id);
      if (receipt?.dependencies.includes(item.pathId)) {
        result.add(receipt.name);
        continue;
      }
      const declared = this.entries.find(e => (e.parentId ? e.parentId + "/" + e.id : e.id) === record.id);
      if (record.id.startsWith(item.pathId + "/") || declared?.requiredPlugins.includes(item.entry.id) ||
          [...(record.manifest.depends ?? []), ...(record.dependencies ?? [])].some(n => services.has(n)))
        result.add(declared?.name ?? record.manifest.name ?? record.id);
    }
    return [...result];
  }

  private plan(item: Item, items: Map<string, Item>) {
    const steps: Step[] = [];
    let reason = item.reason, upgradeUrl = "";
    const card = this.cards.find(card => card.id === item.entry.id);
    const add = (part: Item, action: Step["action"], release: Release) =>
      steps.push({ id: part.entry.id, name: part.entry.name, version: release.version, action });
    if (item.installed && item.existing) {
      const used = this.dependents(item);
      if (this.receiptError) reason = this.receiptError;
      else if (used.length) reason = "请先卸载依赖它的插件：" + used.join("、") + "。";
      if (!reason) add(item, "uninstall", item.existing);
    } else if (!reason && item.target) {
      const walking = new Set<string>();
      const visit = (part: Item, requirement?: string) => {
        if (walking.has(part.entry.id)) throw Error("发行清单包含循环依赖。");
        const release = part.installed ? part.existing : requirement ? part.eligible.find(r => r.version === requirement) : part.target;
        if (requirement && part.installedVersion && !matches(part.installedVersion, requirement)) {
          upgradeUrl = this.cards.find(c => c.id === part.entry.id)?.installation ?? part.entry.repository;
          const instruction = compare(part.installedVersion, requirement) < 0 ? "请先升级" + part.entry.name + "至已验证的 " + requirement + " 版本"
            : part.entry.name + "与本插件的已验证组合要求 " + requirement;
          throw Error(instruction + "（当前 " + part.installedVersion + "）。");
        }
        if (part.reason || !release) throw Error(part.entry.name + "：" + (part.reason || "没有兼容的发行包。"));
        if (requirement && !matches(release.version, requirement)) throw Error(part.entry.name + "没有符合依赖要求的已验证版本。");
        const previous = steps.find(step => step.id === part.entry.id);
        if (previous && previous.version !== release.version) throw Error(part.entry.name + "存在互不兼容的依赖版本要求。");
        if (previous) return;
        walking.add(part.entry.id);
        for (const id of part.entry.requiredPlugins) {
          const dependency = items.get(id);
          if (!dependency || !release.dependencies[id]) throw Error("发行清单缺少依赖版本：" + id);
          visit(dependency, release.dependencies[id]);
        }
        walking.delete(part.entry.id);
        if (part.installed && part.enabled && !part.active) throw Error("请先在插件管理中恢复" + part.entry.name + "，再重试。");
        add(part, !part.installed ? "install" : part.enabled ? "reuse" : "enable", release);
      };
      try { visit(item); } catch (error) { reason = errorText(error); steps.length = 0; }
    }
    const action = reason || !steps.length ? null : item.installed ? "uninstall" : "install";
    const components = steps.flatMap(step => {
      const parts = step.action === "install" && releaseFor(items.get(step.id)!, step.version).composition;
      return parts ? [{ name: parts.name, version: parts.version, repository: parts.zipPart.repository }] : [];
    });
    const verbs = { install: "安装", uninstall: "卸载", enable: "启用", reuse: "沿用" };
    const label = steps.filter(s => s.action !== "reuse").map(s =>
      verbs[s.action] + (/^[A-Za-z]/.test(s.name) ? " " : "") + s.name + (s.id === "bilibili" ? "插件" : "")).join("并");
    const planKey = action ? createHash("sha256").update(JSON.stringify([item.entry.id, action,
      steps.map(s => { const p = items.get(s.id)!, r = releaseFor(p, s.version); return [s, p.enabled, p.active, r?.sha256,
        ...(p.entry.community ? [p.entry.repository, r?.assetUrl, r?.sizeBytes, r?.bundledPluginIds ?? [], r?.dependencies] : [])]; })])).digest("hex") : "";
    return { id: item.entry.id, runtimeId: item.pathId, name: item.entry.name, description: card?.description, repository: item.entry.repository,
      installation: card?.installation, version: item.target?.version ?? item.installedVersion ?? null,
      installedVersion: item.installedVersion ?? null, installed: item.installed, recognized: Boolean(item.existing),
      enabled: item.installed && item.enabled,
      status: this.runtime.records.get(item.pathId)?.status ?? null,
      action, label, steps, components, reason, upgradeUrl, planKey };
  }

  private async snapshot() {
    await this.runtime.pluginState.load();
    try {
      this.communityReceipts = await readCommunityInstalls(this.runtime.root);
      this.receiptError = "";
    } catch {
      this.communityReceipts.clear();
      this.receiptError = "无法读取社区插件的安装记录，确认依赖关系后才能卸载。";
    }
    const items = await Promise.all(this.entries.map(entry => this.inspect(entry)));
    return new Map(items.map(item => [item.entry.id, item]));
  }

  async compatibleUpdateVersions(ids: ReadonlySet<string>) {
    return this.runtime.managePackages(async () => {
      const items = await this.snapshot();
      const versions = new Map<string, string>();
      for (const id of ids) {
        const current = items.get(id);
        if (!current?.entry.community || !current.installed) continue;
        // Preview the replacement using the install planner's host, platform and dependency checks.
        // This plan stays local to the query and never authorizes replacing the installed files.
        const replacement = { ...current, installed: false, installedVersion: undefined, existing: undefined, reason: "" };
        const preview = new Map(items).set(id, replacement);
        for (const target of current.eligible) {
          replacement.eligible = [target];
          replacement.target = target;
          if (this.plan(replacement, preview).action === "install") {
            versions.set(id, target.version);
            break;
          }
        }
      }
      return versions;
    });
  }

  async list() {
    return this.runtime.managePackages(async () => {
      const items = await this.snapshot();
      const plugins = [...items.values()].map(item => this.plan(item, items));
      const recognized = new Set(plugins.filter(p => p.installed && p.recognized).map(p => p.runtimeId));
      // Manually distributed builds can prove authorship without supplying a package management plan.
      for (const build of this.installedBuilds) {
        const record = this.runtime.records.get(build.runtimeId);
        if (!record || record.manifest.version !== build.version || build.platform !== process.platform ||
          build.arch !== process.arch || recognized.has(build.runtimeId)) continue;
        const files = await inspectOfficialFiles(this.runtime.root, {
          directory: "plugins/" + build.runtimeId.split("/").join("/sub/"), sha256: build.sha256, recognitionOnly: true,
        });
        if (files.state === "installed") recognized.add(build.runtimeId);
      }
      return { plugins, recognizedRuntimeIds: [...recognized] };
    });
  }
  async apply(input: { id?: unknown; action?: unknown; planKey?: unknown }) {
    return this.runtime.managePackages(async () => {
      const signal = this.runtime.packageSignal;
      signal.throwIfAborted();
      const runtime = this.runtime, items = await this.snapshot();
      const item = typeof input?.id === "string" && items.get(input.id);
      if (!item) throw Error("请选择官方目录内的插件。");
      const plan = this.plan(item, items);
      if (!plan.action || input.action !== plan.action || input.planKey !== plan.planKey)
        throw Object.assign(Error(plan.reason || "安装状态已变化，请刷新并确认新的操作。"), { status: 409 });
      const undo: Array<{ label: string; run: () => Promise<void> }> = [];
      let stage = "";
      let finishCommit: (() => void) | undefined;
      const stop = async (p: Item) => { if (runtime.records.has(p.pathId)) await runtime.stop(p.pathId); };
      const activate = async (p: Item) => {
        const loaded = await runtime.loadPath(p.pathId);
        if (loaded?.status !== "active") throw Error(loaded?.error ?? "插件未能启用");
      };
      const forget = (p: Item, release: Release) => {
        for (const id of [p.pathId, ...(release.bundledPluginIds ?? [])]) runtime.records.delete(id);
      };
      try {
        // Acquire all missing packages before enabling dependencies or touching the plugin directories.
        for (const step of plan.steps) {
          if (step.action !== "install") continue;
          const p = items.get(step.id)!;
          const target = releaseFor(p, step.version);
          if (target.composition) {
            stage = step.name + " · 下载并校验发行包和 " + target.composition.name;
            if (!target.sizeBytes || !target.inventorySha256 || !/^[a-f0-9]{64}$/.test(target.inventorySha256))
              throw Error("发行清单缺少完整安装包的校验信息。");
            const inventory = readFileSync(new URL("../market/inventories/" + target.inventorySha256 + ".json", import.meta.url));
            if (createHash("sha256").update(inventory).digest("hex") !== target.inventorySha256) throw Error("发行文件清单校验失败。");
            const { ensureComposedOfficialPackage } = await import("./official-package-composition.ts");
            await ensureComposedOfficialPackage(runtime.root, { ...target.composition, inventory, sha256: target.sha256, sizeBytes: target.sizeBytes }, signal);
          } else if (target.assetUrl) {
            stage = step.name + " · 下载并校验发行包";
            if (!target.sizeBytes) throw Error("发行清单缺少安装包大小。");
            await ensureOfficialPackage(runtime.root, { repository: p.entry.repository, assetUrl: target.assetUrl,
              sha256: target.sha256, sizeBytes: target.sizeBytes }, signal);
          }
          if (p.entry.community) await this.community!.verify(runtime.root, p.entry, target);
        }
        // Downloads may take minutes. Recheck the files of dependencies before enabling or relying on them.
        for (const step of plan.steps) {
          if (step.action !== "enable" && step.action !== "reuse") continue;
          const part = items.get(step.id)!, release = releaseFor(part, step.version);
          stage = step.name + " · 核对已安装依赖";
          const state = await inspectOfficialFiles(runtime.root, inventorySpec(part, release));
          if (state.state !== "installed") throw Error(state.reason || "已安装文件发生变化，请重新确认。");
          if (part.entry.community) await this.community!.verify(runtime.root, part.entry, release);
        }
        signal.throwIfAborted();
        finishCommit = runtime.beginPackageCommit();
        for (const step of plan.steps) {
          signal.throwIfAborted();
          if (step.action === "reuse") continue;
          const p = items.get(step.id)!;
          const release = releaseFor(p, step.version);
          const files = spec(p, release);
          stage = step.name + " · " + ({ install: "安装程序文件", enable: "启用依赖", uninstall: "卸载程序文件" }[step.action]);
          if (step.action === "uninstall") {
            if (p.active) undo.push({ label: "恢复启用" + step.name, run: () => activate(p) });
            await stop(p);
            await uninstallOfficialFiles(runtime.root, inventorySpec(p, release));
            forget(p, release);
            continue;
          }
          if (step.action === "install") {
            if (p.entry.community) {
              await this.community!.available(runtime.root, p.pathId);
              const slash = p.pathId.lastIndexOf("/");
              if (slash >= 0) {
                const parent = runtime.records.get(p.pathId.slice(0, slash)), leaf = p.pathId.slice(slash + 1);
                if (parent?.status !== "active" || (Array.isArray(parent.manifest.sub) && !parent.manifest.sub.includes(leaf)))
                  throw Error("父插件尚未启用或没有声明可加载这个子插件。");
              }
            }
            await installOfficialFiles(runtime.root, files);
            undo.push({ label: "撤回新装的" + step.name, run: async () => {
              const used = this.dependents({ ...p, existing: release });
              if (used.length) throw Error("仍有插件依赖：" + used.join("、"));
              await stop(p);
              await uninstallOfficialFiles(runtime.root, files);
              forget(p, release);
            } });
          }
          if (!p.enabled) {
            await runtime.pluginState.setEnabled(p.pathId, true);
            undo.push({ label: "恢复" + step.name + "的停用状态", run: async () => {
              await runtime.pluginState.setEnabled(p.pathId, false);
              await stop(p);
              if (p.installed) await runtime.loadPath(p.pathId);
            } });
          }
          stage = step.name + " · 启用插件";
          signal.throwIfAborted();
          await activate(p);
          if (p.entry.community) for (const id of release.bundledPluginIds ?? []) {
            const child = runtime.records.get(id);
            if (!child || (runtime.pluginState.enabled(id) && child.status !== "active"))
              throw Error(`子插件 ${id} 未就绪：${child?.error || "未能加载"}`);
          }
          signal.throwIfAborted();
        }
        if (plan.action === "install") {
          await runtime.resumeBlocked();
          const communityInstalls = plan.steps.filter(s => s.action === "install" && items.get(s.id)!.entry.community)
            .map(s => ({ entry: items.get(s.id)!.entry, release: releaseFor(items.get(s.id)!, s.version) }));
          if (communityInstalls.length) await this.community!.installed(runtime.root, communityInstalls);
        }
        return { ok: true, message: item.entry.name + (plan.action === "install" ? "已安装并启用。" : "已卸载，配置和数据已保留。") };
      } catch (error) {
        const rolledBack: string[] = [], failed: string[] = [];
        for (const change of undo.reverse()) {
          try { await change.run(); rolledBack.push(change.label); }
          catch (failure) { failed.push(change.label + "：" + errorText(failure)); }
        }
        const detail = failed.length ? "。以下改动未能自动撤回：" + failed.join("；") : "";
        throw Object.assign(Error(stage + "失败：" + errorText(error) + detail), { rolledBack });
      } finally {
        finishCommit?.();
      }
    });
  }
}

export class OfficialPlugins extends PluginPackages {}
