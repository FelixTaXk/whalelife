/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { SenderProfile } from "./plugin-api.ts";
export type { SenderProfile } from "./plugin-api.ts";

function displayName(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  // Bound by Unicode code points and keep valid surrogate pairs and emoji joiners.
  const line = value.replace(/(?![\u200C\u200D])\p{Cf}/gu, "")
    .replace(/[\s\p{Cc}\p{Cs}]+/gu, " ").trim();
  return Array.from(line.slice(0, 128)).slice(0, 64).join("").trimEnd() || undefined;
}

export function normalizeSenderProfile(value: unknown): SenderProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const nickname = Object.hasOwn(input, "nickname") ? displayName(input.nickname) : undefined;
  const remark = Object.hasOwn(input, "remark") ? displayName(input.remark) : undefined;
  if (nickname || remark) return { ...(nickname && { nickname }), ...(remark && { remark }) };
}
