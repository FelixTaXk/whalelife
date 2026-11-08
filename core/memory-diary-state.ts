/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { timestamp } from "./time.ts";

export const DIARY_MAX_CHARS = 32000;
export type DiaryFailure = { reason: string; at: string };
export type DiaryEntry = {
  version: 1;
  id: string;
  session: string;
  scope: string;
  text: string;
  source_ids: string[];
  source_revision: string;
  created_at: string;
  /** Times of the source records, not the date on which the diary was written. */
  time_range: { start?: string; end?: string; incomplete?: boolean };
  model?: string;
};
const chars = (text: string) => Array.from(text).length;
const safe = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export function validateDiaryScope(scope: unknown): asserts scope is string {
  if (scope !== "session" && !(typeof scope === "string" && /^persona:[a-zA-Z0-9_-]{1,100}$/.test(scope)))
    throw Error("日记历史范围无效");
}
export function diaryRowInScope(row: any, session: string, scope: string) {
  return !!row && (row.session === undefined || row.session === session) && row.type === "message" &&
    ["user", "assistant", "tool"].includes(row.role) && typeof row.text === "string" &&
    (scope === "session" || row.persona_revision === scope.slice(8));
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]),
  );
  return value;
}
/** Exact, ordered source snapshots; appending unrelated records does not change this revision. */
export function diarySourceRevision(rows: any[]) {
  return createHash("sha256").update(JSON.stringify(canonical(rows))).digest("hex");
}
export function validateDiaryEntry(entry: any): asserts entry is DiaryEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.version !== 1 ||
      !safe(entry.id) || !safe(entry.session) || typeof entry.text !== "string" || !entry.text.trim() ||
      chars(entry.text) > DIARY_MAX_CHARS || !Array.isArray(entry.source_ids) || !entry.source_ids.length ||
      entry.source_ids.some((id: unknown) => !safe(id)) || new Set(entry.source_ids).size !== entry.source_ids.length ||
      typeof entry.source_revision !== "string" || !/^[a-f0-9]{64}$/.test(entry.source_revision) ||
      timestamp(entry.created_at) === null || (entry.model !== undefined &&
        (typeof entry.model !== "string" || !entry.model.trim() || chars(entry.model) > 300)))
    throw Error("日记正文或来源元数据损坏");
  validateDiaryScope(entry.scope);
  const range = entry.time_range;
  if (!range || typeof range !== "object" || Array.isArray(range) ||
      (range.start !== undefined && timestamp(range.start) === null) ||
      (range.end !== undefined && timestamp(range.end) === null) ||
      (range.incomplete !== undefined && typeof range.incomplete !== "boolean") ||
      ((range.start === undefined) !== (range.end === undefined)) ||
      (range.start && timestamp(range.start)! > timestamp(range.end)!))
    throw Error("日记来源时间范围损坏");
}
/** Membership, source order and source contents must all still match effective history. */
export function validDiarySources(entry: DiaryEntry, session: string, scope: string, rows: any[]) {
  if (entry.session !== session || entry.scope !== scope) return false;
  const ids = new Set(entry.source_ids), selected = rows.filter(row => ids.has(row.id));
  return selected.length === entry.source_ids.length && selected.every((row, index) =>
    row.id === entry.source_ids[index] && diaryRowInScope(row, session, scope)) &&
    diarySourceRevision(selected) === entry.source_revision;
}
export function validateDiaryState(state: any) {
  if (state.diaries !== undefined) {
    if (!Array.isArray(state.diaries)) throw Error("日记列表损坏");
    state.diaries.forEach(validateDiaryEntry);
    if (new Set(state.diaries.map((entry: DiaryEntry) => entry.id)).size !== state.diaries.length)
      throw Error("日记ID重复");
  }
  if (state.diary_failures !== undefined) {
    if (!state.diary_failures || typeof state.diary_failures !== "object" || Array.isArray(state.diary_failures))
      throw Error("日记暂停状态损坏");
    for (const [scope, failure] of Object.entries<any>(state.diary_failures)) {
      validateDiaryScope(scope);
      if (!failure || typeof failure !== "object" || typeof failure.reason !== "string" ||
          !failure.reason.trim() || chars(failure.reason) > 200 || timestamp(failure.at) === null)
        throw Error("日记暂停状态损坏");
    }
  }
}
