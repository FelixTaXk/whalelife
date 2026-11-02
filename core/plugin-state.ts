/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomic } from "./memory.ts";

export function validPluginId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(id);
}

/** User choices only. Dependency outages and process shutdown never change this file. */
export class PluginState {
  private disabled = new Set<string>();
  private ready?: Promise<void>;
  private root: string;
  constructor(root: string) { this.root = root; }
  async load() {
    this.ready ??= (async () => {
      let text;
      try { text = await readFile(join(this.root, "config", "plugins.json"), "utf8"); }
      catch (error: any) { if (error.code === "ENOENT") return; throw error; }
      try {
        const data = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (data?.version !== 1 || !Array.isArray(data.disabled) || !data.disabled.every(validPluginId))
          throw Error("invalid plugin state");
        this.disabled = new Set(data.disabled);
      } catch { throw Error("插件启停配置 config/plugins.json 损坏，请修复后重启；未自动启用插件"); }
    })();
    return this.ready;
  }
  enabled(id: string) { return !this.disabled.has(id); }
  async setEnabled(id: string, enabled: boolean) {
    if (!validPluginId(id)) throw Error("插件 ID 无效");
    await this.load();
    const next = new Set(this.disabled);
    if (enabled) next.delete(id); else next.add(id);
    await mkdir(join(this.root, "config"), { recursive: true });
    await atomic(join(this.root, "config", "plugins.json"), JSON.stringify({ version: 1, disabled: [...next].sort() }, null, 2));
    this.disabled = next;
  }
}
