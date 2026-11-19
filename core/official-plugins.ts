/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspectOfficialFiles, installOfficialFiles, uninstallOfficialFiles } from "./official-package-files.ts";
import type { Runtime } from "./runtime.ts";

type Release = {
  version: string; hostRange: string; platform: string; arch: string; sha256: string;
  dependencies: Record<string, string>; bundledPluginIds?: string[]; recognitionOnly?: boolean;
};
type Entry = { id: string; name: string; repository: string; parentId: string | null; requiredPlugins: string[]; preserve?: string[]; verifiedReleases: Release[] };
type Card = { id: string; description: string; installation: string };
type Step = { action: "install" | "enable" | "reuse" | "uninstall"; id: string; name: string; version: string };
type Item = { entry: Entry; pathId: string; target?: Release; existing?: Release; installedVersion?: string; installed: boolean; reason: string; enabled: boolean; active: boolean };
const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const registry: Entry[] = read("../market/official-releases.json").plugins;
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
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export class OfficialPlugins {
  private runtime: Runtime;
  private entries: Entry[];
  constructor(runtime: Runtime, entries = registry) { this.runtime = runtime; this.entries = entries; }

  private async inspect(entry: Entry): Promise<Item> {
    const runtime = this.runtime;
    const pathId = entry.parentId ? entry.parentId + "/" + entry.id : entry.id;
    const record = runtime.records.get(pathId);
    const releases = entry.verifiedReleases.filter(r => r.platform === process.platform && r.arch === process.arch)
      .sort((a, b) => compare(b.version, a.version));
    const target = releases.find(r => !r.recognitionOnly && matches(hostVersion, r.hostRange));
    const item: Item = { entry, pathId, target, installedVersion: record?.manifest.version, installed: !!record,
      enabled: runtime.pluginState.enabled(pathId), active: record?.status === "active", reason: "" };
    const candidates = record ? releases.filter(r => r.version === item.installedVersion) : target ? [target] : [];
    if (!candidates.length) {
      item.reason = record ? "当前安装版本未匹配已验证的官方发行包，无法确认程序文件归属。"
        : releases.length ? "当前 WhaleLife 没有兼容版本，请先升级 WhaleLife。" : "此平台还没有验证过的发行包。";
      return item;
    }
    for (const candidate of candidates) try {
      const inspection = await inspectOfficialFiles(runtime.root, spec(item, candidate));
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
    const card = cards.find(card => card.id === item.entry.id);
    const add = (part: Item, action: Step["action"], release: Release) =>
      steps.push({ id: part.entry.id, name: part.entry.name, version: release.version, action });
    if (item.installed && item.existing) {
      const used = this.dependents(item);
      if (used.length) reason = "请先卸载依赖它的插件：" + used.join("、") + "。";
      if (!reason) add(item, "uninstall", item.existing);
    } else if (!reason && item.target) {
      const walking = new Set<string>();
      const visit = (part: Item, requirement?: string) => {
        if (walking.has(part.entry.id)) throw Error("发行清单包含循环依赖。");
        const release = part.installed ? part.existing : part.target;
        if (requirement && part.installedVersion && !matches(part.installedVersion, requirement)) {
          upgradeUrl = cards.find(c => c.id === part.entry.id)?.installation ?? part.entry.repository;
          const instruction = compare(part.installedVersion, requirement) < 0 ? "请先升级" + part.entry.name + "至已验证的 " + requirement + " 版本"
            : part.entry.name + "与本插件的已验证组合要求 " + requirement;
          throw Error(instruction + "（当前 " + part.installedVersion + "）。");
        }
        if (part.reason || !release) throw Error(part.entry.name + "：" + (part.reason || "没有兼容的发行包。"));
        if (requirement && !matches(release.version, requirement)) throw Error(part.entry.name + "没有符合依赖要求的已验证版本。");
        if (steps.some(step => step.id === part.entry.id)) return;
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
    const verbs = { install: "安装", uninstall: "卸载", enable: "启用", reuse: "沿用" };
    const label = steps.filter(s => s.action !== "reuse").map(s =>
      verbs[s.action] + (/^[A-Za-z]/.test(s.name) ? " " : "") + s.name + (s.id === "bilibili" ? "插件" : "")).join("并");
    const planKey = action ? createHash("sha256").update(JSON.stringify([item.entry.id, action,
      steps.map(s => { const p = items.get(s.id)!; return [s, p.enabled, p.active, (p.existing ?? p.target)?.sha256]; })])).digest("hex") : "";
    return { id: item.entry.id, name: item.entry.name, description: card?.description, repository: item.entry.repository,
      installation: card?.installation, version: item.target?.version ?? item.installedVersion ?? null,
      installedVersion: item.installedVersion ?? null, installed: item.installed, enabled: item.installed && item.enabled,
      status: this.runtime.records.get(item.pathId)?.status ?? null,
      action, label, steps, reason, upgradeUrl, planKey };
  }

  private async snapshot() {
    await this.runtime.pluginState.load();
    const items = await Promise.all(this.entries.map(entry => this.inspect(entry)));
    return new Map(items.map(item => [item.entry.id, item]));
  }
  async list() {
    return this.runtime.managePackages(async () => {
      const items = await this.snapshot();
      return { plugins: [...items.values()].map(item => this.plan(item, items)) };
    });
  }
  async apply(input: { id?: unknown; action?: unknown; planKey?: unknown }) {
    return this.runtime.managePackages(async () => {
      const runtime = this.runtime, items = await this.snapshot();
      const item = typeof input?.id === "string" && items.get(input.id);
      if (!item) throw Error("请选择官方目录内的插件。");
      const plan = this.plan(item, items);
      if (!plan.action || input.action !== plan.action || input.planKey !== plan.planKey)
        throw Object.assign(Error(plan.reason || "安装状态已变化，请刷新并确认新的操作。"), { status: 409 });
      const undo: Array<{ label: string; run: () => Promise<void> }> = [];
      let stage = "";
      const stop = async (p: Item) => { if (runtime.records.has(p.pathId)) await runtime.stop(p.pathId); };
      const activate = async (p: Item) => {
        const loaded = await runtime.loadPath(p.pathId);
        if (loaded?.status !== "active") throw Error(loaded?.error ?? "插件未能启用");
      };
      const forget = (p: Item, release: Release) => {
        for (const id of [p.pathId, ...(release.bundledPluginIds ?? [])]) runtime.records.delete(id);
      };
      try {
        for (const step of plan.steps) {
          if (step.action === "reuse") continue;
          const p = items.get(step.id)!;
          const release = (p.existing ?? p.target)!;
          const files = spec(p, release);
          stage = step.name + " · " + ({ install: "安装程序文件", enable: "启用依赖", uninstall: "卸载程序文件" }[step.action]);
          if (step.action === "uninstall") {
            if (p.active) undo.push({ label: "恢复启用" + step.name, run: () => activate(p) });
            await stop(p);
            await uninstallOfficialFiles(runtime.root, files);
            forget(p, release);
            continue;
          }
          if (step.action === "install") {
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
          await activate(p);
        }
        if (plan.action === "install") await runtime.resumeBlocked();
        return { ok: true, message: item.entry.name + (plan.action === "install" ? "已安装并启用。" : "已卸载，配置和数据已保留。") };
      } catch (error) {
        const rolledBack: string[] = [], failed: string[] = [];
        for (const change of undo.reverse()) {
          try { await change.run(); rolledBack.push(change.label); }
          catch (failure) { failed.push(change.label + "：" + errorText(failure)); }
        }
        const detail = failed.length ? "。以下改动未能自动撤回：" + failed.join("；") : "";
        throw Object.assign(Error(stage + "失败：" + errorText(error) + detail), { rolledBack });
      }
    });
  }
}
