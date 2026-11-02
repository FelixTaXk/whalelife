/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
/** Host-only state for one model turn; never a global/session-wide switch. */
export type ToolTurn = { transient: boolean };
export const TRANSIENT_REPLY = "本轮使用了临时资料，完整回复不保存；实际动作及结果以已保存的工具回执为准。";

/** Receipts must be bounded JSON snapshots, never live objects or media bytes. */
export function receiptSnapshot(value: unknown): unknown {
  const seen = new Set<object>();
  const visit = (item: any, depth: number): void => {
    if (depth > 20) throw Error("工具回执层级过深");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || seen.has(item) ||
      (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))))
      throw Error("工具回执必须是JSON数据");
    seen.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 65536) throw Error("工具回执不能超过64KiB");
  return JSON.parse(json);
}
