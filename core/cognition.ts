import { createHash } from "node:crypto";

export type CognitionCandidate = {
  id: string;
  text: string;
  status: string;
  uncertain: boolean;
  revision: string;
};
export type CognitionMaintenance = {
  candidates: CognitionCandidate[];
  evidence: string[];
  reviews?: { id: string; evidence: string[]; reason: string }[];
};
export const cognitionRevision = (record: any) =>
  createHash("sha256").update(JSON.stringify(record)).digest("hex");
const size = (s: string) => Array.from(s).length;
const hasText = (s: any, max: number) =>
  typeof s === "string" && !!s.trim() && size(s) <= max;

// Runs inside MemoryEngine's atomic update. Never mutates facts or raw episodes.
export function applyCognitions(
  records: any[],
  key: string,
  checkpoint: any,
  inputs: any[],
  knownEvidence: Set<string>,
  maintenance?: CognitionMaintenance,
) {
  const allowedEvidence = maintenance
    ? new Set(maintenance.evidence.filter((id) => knownEvidence.has(id)))
    : knownEvidence;
  const evidenceValid = (refs: any) =>
    Array.isArray(refs) && refs.length > 0 && refs.length <= 10 &&
    refs.every((ref) => typeof ref === "string" && allowedEvidence.has(ref));
  const reviews = maintenance?.reviews ?? [];
  if (!Array.isArray(inputs) || inputs.length > 2 || !Array.isArray(reviews) || reviews.length > 2)
    throw Error("每批最多2条认知和2条复核标记");
  const targets = new Set<string>();
  const target = (id: string) => {
    const snapshot = maintenance?.candidates.find((x) => x.id === id);
    const current = records.find((x) => x.id === id);
    if (!snapshot || !current || current.kind !== "cognition" ||
        !["active", "review"].includes(current.status) || current.reverted_at ||
        snapshot.revision !== cognitionRevision(current))
      throw Error("认知已变更或不在本批候选中，稍后重新整理");
    if (targets.has(id)) throw Error("同一批不能重复修订同一认知");
    targets.add(id);
    return current;
  };
  // Validate the entire batch before changing anything, including target snapshots.
  const plans = inputs.map((input, n) => {
    if (!input || !hasText(input.text, 150) || !evidenceValid(input.evidence) ||
        (input.uncertain !== undefined && typeof input.uncertain !== "boolean"))
      throw Error("认知缺少有效来源或超出长度");
    const replaces = input.replaces ?? [];
    if (!Array.isArray(replaces) || replaces.length > 4 ||
        replaces.some((x: any) => typeof x !== "string") ||
        (replaces.length && !hasText(input.reason, 100)))
      throw Error("认知修订需要候选ID和简短依据");
    const rid = createHash("sha256")
      .update(key + ":" + checkpoint.last_id + ":" + checkpoint.last_offset + ":" + n + (checkpoint.input_revision ? ":" + checkpoint.input_revision : ""))
      .digest("hex").slice(0, 32);
    return { input, rid, previous: replaces.map(target) };
  });
  const reviewPlans = reviews.map((input) => {
    if (!input || typeof input.id !== "string" || !hasText(input.reason, 100) ||
        !evidenceValid(input.evidence)) throw Error("复核标记缺少有效来源或依据");
    return { input, previous: target(input.id) };
  });
  const ts = new Date().toISOString();
  for (const { input, rid, previous } of plans) {
    if (records.some((x) => x.id === rid)) continue;
    // Exact duplicate extraction consumes no extra record and no extra prompt space.
    const duplicate = !previous.length && records.find((x) => x.kind === "cognition" && !x.context_excluded &&
        x.status === "active" && x.text.trim() === input.text.trim() &&
        x.persona_revision === (input.persona_revision || null));
    if (duplicate) {
      duplicate.evidence = [...new Set([...duplicate.evidence, ...input.evidence])].slice(-10);
      duplicate.corroborated_at = ts;
      continue;
    }
    const item = {
      id: rid, kind: "cognition", text: input.text.trim(), source: "consolidation",
      ts, status: "active", pinned: previous.some((x) => x.pinned),
      evidence: [...new Set(input.evidence)], persona_revision: input.persona_revision || null,
      uncertain: input.uncertain ?? true,
      ...(checkpoint.mode === "long" ? { format_version: 2 } : {}),
      ...(previous.length ? { supersedes: previous.map((x) => x.id), change_reason: input.reason } : {}),
    };
    records.push(item);
    for (const old of previous) {
      old.status = "superseded";
      old.superseded_by = rid;
      old.changed_at = ts;
    }
  }
  for (const { input, previous } of reviewPlans) {
    previous.status = "review";
    previous.review = { reason: input.reason, evidence: [...new Set(input.evidence)], at: ts };
  }
}

// User-initiated rollback only. Never revive an ancestor while a newer successor is active.
export function undoCognition(records: any[], record: any) {
  if (record.kind !== "cognition" || !record.supersedes?.length ||
      record.superseded_by || record.reverted_at || !["active", "review", "archived"].includes(record.status))
    throw Error("只能撤回尚未被后续修订替代的认知");
  const previous = record.supersedes.map((id: string) => records.find((x) => x.id === id));
  if (previous.some((x: any) => !x || x.superseded_by !== record.id || x.status !== "superseded"))
    throw Error("相关认知状态已变化，不能撤回");
  record.status = "archived";
  record.reverted_at = new Date().toISOString();
  for (const item of previous) {
    item.status = item.review ? "review" : "active";
    delete item.superseded_by;
  }
}
