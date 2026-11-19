/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFile } from "node:fs/promises";
import type { Logger } from "./logger.ts";
import { atomic } from "./memory.ts";
import type { ModelTool } from "./plugin-api.ts";

/** Order of registered tools exposed by this host. Inactive names retain their slots. */
export class RegisteredToolOrder {
  private ranks = new Map<string, number>();
  private saved = 0;
  private pending = Promise.resolve();
  private warned = false;
  private file?: string;
  private logger: Pick<Logger, "warn">;
  private constructor(file: string, logger: Pick<Logger, "warn">) {
    this.file = file;
    this.logger = logger;
  }

  static async open(file: string, logger: Pick<Logger, "warn">) {
    const order = new RegisteredToolOrder(file, logger);
    try {
      const names: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(names) || !names.every(name => typeof name === "string") || new Set(names).size !== names.length)
        throw Error("invalid tool order");
      for (const name of names) order.ranks.set(name, order.ranks.size);
      order.saved = order.ranks.size;
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        order.file = undefined;
        logger.warn("无法读取 config/tool-order.json，本次在内存中维护工具顺序，保留原文件");
      }
    }
    return order;
  }

  async remember(names: Iterable<string>) {
    const additions = [...new Set(names)].filter(name => typeof name === "string" && !this.ranks.has(name)).sort();
    for (const name of additions) this.ranks.set(name, this.ranks.size);
    const file = this.file;
    if (!file || this.saved === this.ranks.size) return;
    // Chats in different sessions can discover more tools while a write is in flight.
    this.pending = this.pending.then(async () => {
      if (this.saved === this.ranks.size) return;
      const snapshot = [...this.ranks.keys()];
      try {
        await atomic(file, JSON.stringify(snapshot) + "\n");
        this.saved = snapshot.length;
        this.warned = false;
      } catch {
        if (!this.warned) this.logger.warn("工具顺序暂未保存，本次继续使用内存顺序，下次使用时重试");
        this.warned = true;
      }
    });
    await this.pending;
  }

  async order(tools: ModelTool[]) {
    await this.remember(tools.map(tool => tool.function.name));
    return tools.toSorted((a, b) => this.ranks.get(a.function.name)! - this.ranks.get(b.function.name)!);
  }
}
