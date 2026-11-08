/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFile, mkdir, lstat } from "node:fs/promises";
import { join, relative, resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomic, safeId, type Memory } from "./memory.ts";
import { occurrence, collectTimes, timestamp } from "./time.ts";
import { applyCognitions, cognitionRevision, undoCognition, type CognitionMaintenance } from "./cognition.ts";
import { attribution, collectOrigins, originOf, pluginOrigin, validateAttribution, validateOrigin } from "./provenance.ts";
import type { DocumentWrite, SessionDocument } from "./plugin-api.ts";
import { TRANSIENT_REPLY } from "./tool-retention.ts";
import { diaryRowInScope, validateDiaryEntry, validateDiaryScope, validateDiaryState, validDiarySources,
  type DiaryEntry, type DiaryFailure } from "./memory-diary-state.ts";

export const charCount = (text: string) => Array.from(text).length;
export const MAX_DAILY_MEMORY_TOKENS = 10000000;
export type MemoryReservation = Readonly<{ id: string; day: string; reserved: number }>;
export function estimateTokens(text: string) {
  const ascii = (text.match(/[\x00-\x7f]/g) || []).length;
  return Math.ceil(ascii / 3 + (charCount(text) - ascii) * 1.5);
}
const cut = (text: string, n: number) => Array.from(text).slice(0, n).join("");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const temporaryPlaceholder = (row: any) => row.type === "message" && row.role === "assistant" &&
  row.transient === true && row.text === TRANSIENT_REPLY;
const excludedInputs = (state: { records: any[] }) => new Set<string>(
  state.records.filter(x => x.kind === "event-state" && x.context_excluded === true).map(x => x.id));
const inputRevision = (state: { records: any[] }) => {
  const ids = [...excludedInputs(state)].sort();
  return ids.length ? hash(JSON.stringify(ids)) : undefined;
};
const initial = () => ({
  version: 1,
  facts: { text: "", revision: hash(""), updated_by: "user", updated_at: "" },
  history: [] as any[],
  records: [] as any[],
  memberships: [] as string[],
  settings: {
    enabled: true,
    half_life_days: 30,
    recall_tokens: 800,
    daily_memory_tokens: 20000,
  },
  daily: { day: "", reserved: 0 },
  usage: {
    chat: {
      input_tokens: 0,
      output_tokens: 0,
      requests: 0,
      unknown_requests: 0,
    },
    memory: {
      input_tokens: 0,
      output_tokens: 0,
      requests: 0,
      unknown_requests: 0,
    },
  },
  summaries: {} as Record<string, any>,
  diaries: [] as DiaryEntry[],
  diary_failures: {} as Record<string, DiaryFailure>,
  trace: { query: "", selected: [], estimated_tokens: 0 } as any,
});
export function validateMemoryState(s: any) {
  const object = (x: any) =>
    x !== null && typeof x === "object" && !Array.isArray(x);
  const count = (x: any) => Number.isSafeInteger(x) && x >= 0;
  if (
    s?.version !== 1 ||
    !Array.isArray(s.records) ||
    !Array.isArray(s.memberships) ||
    !Array.isArray(s.history) ||
    typeof s.facts?.text !== "string" ||
    charCount(s.facts.text) > 100 ||
    s.history.some(
      (x: any) => typeof x.text !== "string" || charCount(x.text) > 100,
    )
  )
    throw Error("独立记忆损坏或超过100字符，未覆盖原文件");
  validateDiaryState(s);
  if (
    !s.settings ||
    typeof s.settings.enabled !== "boolean" ||
    !Number.isInteger(s.settings.recall_tokens) ||
    s.settings.recall_tokens < 0 ||
    s.settings.recall_tokens > 4000 ||
    !Number.isInteger(s.settings.half_life_days) ||
    s.settings.half_life_days < 1 ||
    s.settings.half_life_days > 3650 ||
    !object(s.summaries)
  )
    throw Error("记忆设置或摘要进度损坏");
  if (
    s.settings.daily_memory_tokens !== undefined &&
    (!count(s.settings.daily_memory_tokens) ||
      s.settings.daily_memory_tokens > MAX_DAILY_MEMORY_TOKENS)
  )
    throw Error("整理预算损坏");
  if (
    s.memberships.some(
      (x: any) => typeof x !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(x),
    )
  )
    throw Error("共享范围损坏");
  for (const record of s.records)
    if (
      !object(record) ||
      typeof record.id !== "string" ||
      typeof record.kind !== "string" ||
      !["active", "archived", "superseded", "review"].includes(record.status) ||
      typeof record.pinned !== "boolean" ||
      (record.kind !== "event-state" &&
        (typeof record.text !== "string" ||
          charCount(record.text) > 500 ||
          !Array.isArray(record.evidence)))
    )
      throw Error("记忆记录损坏");
  const byId = new Map(s.records.map((x: any) => [x.id, x]));
  if (byId.size !== s.records.length) throw Error("记忆ID重复");
  for (const record of s.records) {
    validateAttribution(record);
    if (record.context_excluded !== undefined && typeof record.context_excluded !== "boolean")
      throw Error("上下文排除标记损坏");
    if (record.kind === "cognition" && record.format_version === 2 && charCount(record.text) > 80)
      throw Error("新版长期认知每条不能超过80字符");
    if (record.uncertain !== undefined && typeof record.uncertain !== "boolean")
      throw Error("认知不确定性标记损坏");
    if (record.supersedes !== undefined && (!Array.isArray(record.supersedes) ||
        record.supersedes.length > 4 || record.supersedes.some((id: any) =>
          id === record.id || (byId.get(id) as any)?.kind !== "cognition")))
      throw Error("认知替代来源损坏");
    if (record.superseded_by !== undefined &&
        (record.status !== "superseded" || !(byId.get(record.superseded_by) as any)?.supersedes?.includes(record.id)))
      throw Error("认知替代关系损坏");
    if (record.status === "superseded" && !record.superseded_by)
      throw Error("认知缺少替代记录");
    if (record.review !== undefined && (typeof record.review.reason !== "string" ||
        charCount(record.review.reason) > 100 || !Array.isArray(record.review.evidence)))
      throw Error("认知复核依据损坏");
  }
  for (const [key, value] of Object.entries<any>(s.summaries)) {
    if (value?.input_revision !== undefined &&
        (typeof value.input_revision !== "string" || !/^[a-f0-9]{64}$/.test(value.input_revision)))
      throw Error("摘要来源版本损坏");
    if (value && typeof value === "object") validateAttribution(value);
    safeId(key);
    if (
      !object(value) ||
      !count(value.covered) ||
      (value.last_id !== undefined && typeof value.last_id !== "string") ||
      (value.last_offset !== undefined && !count(value.last_offset)) ||
      (value.retry_at !== undefined && !count(value.retry_at)) ||
      ["attempt_sequence", "failure_count", "last_attempt_at"].some(name => value[name] !== undefined && !count(value[name])) ||
      (value.retry_start_id !== undefined && typeof value.retry_start_id !== "string") ||
      (value.last_error !== undefined && (typeof value.last_error !== "string" || !value.last_error.trim() || charCount(value.last_error) > 200)) ||
      (value.updated_at !== undefined && (typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at)))) ||
      (value.text !== undefined &&
        (typeof value.text !== "string" || charCount(value.text) > 500))
    )
      throw Error("摘要游标损坏");
    if (value.mode !== undefined && (!["short", "long"].includes(value.mode) ||
        (value.text !== undefined && charCount(value.text) > 200) ||
        (value.mode === "short" && typeof value.start_id !== "string")))
      throw Error("短期摘要与长期概要各最多200字符，且需有正确范围");
  }
  for (const bucket of [s.usage?.chat, s.usage?.memory])
    if (
      !object(bucket) ||
      [
        bucket.input_tokens,
        bucket.output_tokens,
        bucket.requests,
        bucket.unknown_requests,
      ].some((x) => !count(x))
    )
      throw Error("用量统计损坏");
  if (
    s.daily &&
    (!object(s.daily) ||
      typeof s.daily.day !== "string" ||
      !count(s.daily.reserved))
  )
    throw Error("每日整理额度损坏");
}
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const stop = new Set(
  "的 了 是 我 你 它 他 她 我们 你们 这 那 什么 怎么 吗 呢 啊 在 有 和 就 都 一下 你好 哈哈 嗯 记得 记忆 告诉 请 之前 以前 曾经 还 现在".split(
    " ",
  ),
);
const aliases: Record<string, string> = {
  偏好: "喜欢",
  爱好: "喜欢",
  喜爱: "喜欢",
  诞辰: "生日",
  番茄: "西红柿",
  哔哩哔哩: "b站",
};
const tokenCache = new Map<string, string[]>();
function words(text: string) {
  const key = hash(text),
    cached = tokenCache.get(key);
  if (cached) return cached;
  const tokens = [
    ...new Set(
      Array.from(
        segmenter.segment(text.toLowerCase().normalize("NFKC")),
        (x) => (x.isWordLike ? aliases[x.segment] || x.segment : ""),
      ).filter((x) => x && !stop.has(x)),
    ),
  ];
  if (tokenCache.size >= 5000)
    tokenCache.delete(tokenCache.keys().next().value!);
  tokenCache.set(key, tokens);
  return tokens;
}
export class MemoryEngine {
  memory: Memory;
  // Reservations are charged durably first. A crash retains that conservative charge.
  private memoryReservations = new Map<string, {
    sessionId: string; ticket: MemoryReservation; settlement?: Promise<void>;
  }>();
  types = new Map<string, { owner: string; version: number }>();
  maintenance: (id?: string) => boolean = () => false;
  inputEditGuard: (id: string) => (() => void) = () => () => {};
  constructor(memory: Memory) {
    this.memory = memory;
  }
  // Every managed path rejects links, including the root and existing target.
  private async path(...parts: string[]) {
    const target = resolve(this.memory.root, ...parts);
    const rel = relative(resolve(this.memory.root), target);
    if (rel.startsWith("..") || rel.includes(":")) throw Error("记忆路径越界");
    const checks = [resolve(this.memory.root)];
    for (const part of rel.split(/[\\/]/).filter(Boolean))
      checks.push(join(checks.at(-1)!, part));
    for (const p of checks)
      try {
        if ((await lstat(p)).isSymbolicLink())
          throw Error("记忆路径不能是链接");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    return target;
  }
  private async json(file: string, fallback: any) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (e: any) {
      if (e.code === "ENOENT") return fallback;
      throw e;
    }
  }
  private async file(id: string) {
    return this.path("sessions", safeId(id), "knowledge", "state.json");
  }
  private async valid(id: string) {
    safeId(id);
    if (this.maintenance(id)) throw Error("记忆维护中，请稍后重试");
    if ((await this.memory.sessionMeta(id))?.deleted) throw Error("会话已删除");
  }
  private async documentFile(id: string, owner: string, key: string) {
    await this.valid(id);
    if (!(await this.memory.sessionMeta(id))) throw Error("会话不存在，请先创建会话");
    if (typeof key !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(key))
      throw Error("文档 key 需要1–64个小写字母、数字、下划线或连字符，以字母开头");
    return this.path("sessions", id, "extensions", hash(owner).slice(0, 20), "documents", key + ".json");
  }
  private async document<Data>(file: string, owner: string, key: string): Promise<SessionDocument<Data>> {
    let raw: string;
    try { raw = await readFile(file, "utf8"); }
    catch (error: any) {
      if (error.code === "ENOENT") return { revision: null, data: null };
      throw error;
    }
    if (Buffer.byteLength(raw) > 256 * 1024 + 2048) throw Error("会话文档损坏或过大，未覆盖原文件");
    const value = JSON.parse(raw);
    if (value?.version !== 1 || value.owner !== owner || value.key !== key ||
        typeof value.revision !== "string" || !/^[a-f0-9-]{36}$/.test(value.revision) ||
        !Object.hasOwn(value, "data")) throw Error("会话文档损坏或归属不符，未覆盖原文件");
    return { revision: value.revision, data: value.data };
  }
  private readDocument<Data>(id: string, owner: string, key: string, check: () => void) {
    return this.memory.serial(async () => {
      check();
      const file = await this.documentFile(id, owner, key);
      check();
      return this.document<Data>(file, owner, key);
    });
  }
  private async saveDocument<Data>(id: string, owner: string, input: DocumentWrite<Data>, check: () => void): Promise<SessionDocument<Data>> {
    check();
    const { key, revision } = input;
    if (revision !== null && (typeof revision !== "string" || !/^[a-f0-9-]{36}$/.test(revision)))
      throw Error("保存文档必须携带读取时的 revision，新文档使用 null");
    const encoded = JSON.stringify(input.data, (_key, value) => {
      if (["undefined", "function", "symbol", "bigint"].includes(typeof value) ||
          (typeof value === "number" && !Number.isFinite(value))) throw Error("文档内容必须是有效 JSON 数据");
      return value;
    });
    if (Buffer.byteLength(encoded) > 256 * 1024) throw Error("单份文档最多256 KiB");
    const data = JSON.parse(encoded);
    return this.memory.serial(async () => {
      check();
      const file = await this.documentFile(id, owner, key);
      const previous = await this.document(file, owner, key);
      if (revision !== previous.revision) throw Error("文档已变更，请重新读取后保存");
      const next = { revision: randomUUID(), data };
      await mkdir(dirname(file), { recursive: true });
      check();
      await atomic(file, JSON.stringify({ version: 1, owner, key, ...next }));
      return next;
    });
  }
  async state(id: string) {
    await this.valid(id);
    const s = await this.json(await this.file(id), initial());
    validateMemoryState(s);
    return s as ReturnType<typeof initial>;
  }
  private async update(
    id: string,
    fn: (state: ReturnType<typeof initial>) => any,
  ) {
    await this.valid(id);
    // Create session metadata before entering the shared write queue.
    if (!(await this.memory.sessionMeta(id)))
      await this.memory.saveSessionMeta(id, {});
    return this.memory.serial(async () => {
      const s = await this.state(id);
      const before = JSON.stringify([s.facts, s.records, s.summaries, s.diaries, s.diary_failures]);
      const result = await fn(s);
      validateMemoryState(s);
      const file = await this.file(id);
      await mkdir(dirname(file), { recursive: true });
      await atomic(file, JSON.stringify(s, null, 2));
      if (before !== JSON.stringify([s.facts, s.records, s.summaries, s.diaries, s.diary_failures]))
        this.memory.notify("memory/updated", { session: id });
      return result;
    });
  }
  async localFacts(id: string) {
    const s = await this.state(id);
    return {
      ...s.facts,
      chars: charCount(s.facts.text),
      max: 100,
      history: s.history,
    };
  }
  async contextRevision(id: string) {
    const s = await this.state(id);
    return hash(
      JSON.stringify([
        s.facts.revision,
        s.settings,
        s.memberships,
        s.records.map((x) => [x.id, x.status, x.pinned, x.text, x.uncertain, attribution(x), x.context_excluded]),
        Object.entries(s.summaries).map(([key, x]) => [key, x.text, x.mode, attribution(x)]),
        s.diaries, s.diary_failures,
        await this.memory.readFacts(),
      ]),
    );
  }
  async contextRows(id: string, rows?: any[]) {
    const excluded = excludedInputs(await this.state(id));
    return (rows ?? await this.memory.readSession(id)).filter((row: any) => !excluded.has(row.id) && !temporaryPlaceholder(row));
  }
  private async excludeInputs(id: string, owner: string, messageIds: string[], check: () => void) {
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 100 ||
        messageIds.some(x => typeof x !== "string" || !x || x.length > 200)) throw Error("每次需要1–100个明确的消息ID");
    const ids = [...new Set(messageIds)];
    if (!(await this.memory.sessionMeta(safeId(id)))) throw Error("会话不存在");
    check();
    const release = this.inputEditGuard(id);
    try { return await this.update(id, async s => {
      check();
      const rows = new Map((await this.memory.readSession(id)).map((x: any) => [x.id, x]));
      for (const rid of ids) {
        const row: any = rows.get(rid);
        if (!row || row.type !== "message" || row.role !== "user" || row.channel !== "plugin" ||
            row.account !== owner || row.origin?.plugin !== owner)
          throw Error("只能排除本插件通过会话接口写入的明确输入消息，不能排除真人或其他来源记录");
      }
      check();
      const at = new Date().toISOString();
      let excluded = 0;
      for (const rid of ids) {
        let item = s.records.find(x => x.id === rid);
        if (item?.context_excluded) continue;
        if (!item) { item = { id: rid, kind: "event-state", status: "active", pinned: false }; s.records.push(item); }
        if (item.kind !== "event-state") throw Error("消息ID与其他记忆记录冲突");
        Object.assign(item, { context_excluded: true, excluded_by: owner, excluded_at: at });
        excluded++;
      }
      if (excluded) {
        // Derived prose cannot be reliably edited by removing substrings. Retain it for audit,
        // suppress it from context, and regenerate from eligible source rows on later turns.
        for (const item of s.records)
          if (item.kind === "cognition" && (item.source === "consolidation" || item.evidence?.some((ref: string) => ids.includes(ref))))
            Object.assign(item, { context_excluded: true, excluded_by: owner, excluded_at: at });
        s.trace = { query: "", selected: [], estimated_tokens: 0 };
      }
      return { excluded };
    }); } finally { release(); }
  }
  async saveLocalFacts(
    id: string,
    text: unknown,
    revision?: string,
    append = false,
    actor: "user" | "assistant" = "user",
  ) {
    if (typeof text !== "string") throw Error("事实必须是文字");
    await this.update(id, (s) => {
      if (revision !== undefined && revision !== s.facts.revision)
        throw Object.assign(Error("事实已变更，请重新读取后编辑"), {
          status: 409,
        });
      const next = append && s.facts.text ? s.facts.text + "\n" + text : text;
      if (append && s.facts.text.split("\n").includes(text)) return;
      if (charCount(next) > 100)
        throw Error("独立事实合计不能超过100个字符，请精简已有内容后再保存");
      if (next === s.facts.text) return;
      s.history = [
        { ...s.facts, at: new Date().toISOString() },
        ...s.history,
      ].slice(0, 20);
      s.facts = {
        text: next,
        revision: randomUUID(),
        updated_by: actor,
        updated_at: new Date().toISOString(),
      };
    });
    return this.localFacts(id);
  }
  private async spaceData() {
    return this.json(await this.path("shared", "spaces.json"), {
      version: 1,
      spaces: [],
    });
  }
  async spaces(id: string) {
    const s = await this.state(id),
      data = await this.spaceData();
    return data.spaces.map((x: any) => ({
      id: x.id,
      name: x.name,
      joined: s.memberships.includes(x.id),
    }));
  }
  async createSpace(name: unknown) {
    if (typeof name !== "string" || !name.trim() || charCount(name) > 60)
      throw Error("空间名称需为1–60字符");
    return this.memory.serial(async () => {
      if (this.maintenance()) throw Error("记忆维护中");
      const data = await this.spaceData(),
        item = {
          id: "space_" + randomUUID().replaceAll("-", ""),
          name: name.trim(),
          refs: [],
        };
      data.spaces.push(item);
      const file = await this.path("shared", "spaces.json");
      await mkdir(dirname(file), { recursive: true });
      await atomic(file, JSON.stringify(data, null, 2));
      return { id: item.id, name: item.name };
    });
  }
  async settings(id: string, settings: any, memberships: any) {
    if (
      !settings ||
      typeof settings.enabled !== "boolean" ||
      !Number.isInteger(settings.half_life_days) ||
      settings.half_life_days < 1 ||
      settings.half_life_days > 3650 ||
      !Number.isInteger(settings.recall_tokens) ||
      settings.recall_tokens < 0 ||
      settings.recall_tokens > 4000 ||
      !Array.isArray(memberships) ||
      memberships.some((x) => typeof x !== "string")
    )
      throw Error("记忆设置无效");
    const available = (await this.spaceData()).spaces.map((x: any) => x.id);
    const daily = settings.daily_memory_tokens ?? 20000;
    if (!Number.isInteger(daily) || daily < 0 || daily > MAX_DAILY_MEMORY_TOKENS)
      throw Error(`每日整理预算需为0–${MAX_DAILY_MEMORY_TOKENS}`);
    if (memberships.some((x) => !available.includes(x)))
      throw Error("共享空间不存在");
    await this.update(id, (s) => {
      s.settings = {
        enabled: settings.enabled,
        half_life_days: settings.half_life_days,
        recall_tokens: settings.recall_tokens,
        daily_memory_tokens: daily,
      };
      s.memberships = [...new Set<string>(memberships)];
    });
    return this.inspect(id);
  }
  async record(id: string, input: any, options: { toolTrace?: boolean } = {}) {
    const occurredAt = occurrence(input.occurred_at);
    const origin = input.origin === undefined ? undefined : validateOrigin(input.origin);
    const kind = input.kind;
    if (!["episode", "cognition"].includes(kind) && !this.types.has(kind))
      throw Error("记忆类型未注册或已停用");
    if (
      typeof input.text !== "string" ||
      !input.text.trim() ||
      charCount(input.text) > 500
    )
      throw Error("记忆内容需为1–500字符");
    if (
      kind === "cognition" &&
      (!Array.isArray(input.evidence) || !input.evidence.length)
    )
      throw Error("认知必须引用已有经历");
    const known = new Set(
      (await this.memory.readSession(id)).map((x: any) => x.id).filter(Boolean),
    );
    const evidence = Array.isArray(input.evidence)
      ? input.evidence
          .filter((x: any) => typeof x === "string" && known.has(x))
          .slice(0, 10)
      : [];
    if (kind === "cognition" && !evidence.length) throw Error("认知来源不存在");
    return this.update(id, (s) => {
      const key =
        typeof input.event_id === "string" ? input.event_id : randomUUID();
      const recordId = hash((input.source || "core") + ":" + key).slice(0, 32);
      const existing = s.records.find((x) => x.id === recordId);
      if (existing) return existing;
      const item = {
        id: recordId,
        kind,
        text: input.text,
        source: String(input.source || "core"),
        ...(origin ? { origin } : {}),
        ts: new Date().toISOString(),
        ...(occurredAt ? { occurred_at: occurredAt } : {}),
        status: "active",
        pinned: false,
        evidence,
        persona_revision: input.persona_revision || null,
        outcome: input.outcome || null,
        ...(kind === "episode" ? { tool_trace: options.toolTrace === true } : {}),
      };
      s.records.push(item);
      return item;
    });
  }
  async experience(id: string, source: string, input: any, options: { toolTrace?: boolean } = {}) {
    if (
      typeof input.event_id !== "string" ||
      !input.event_id ||
      input.event_id.length > 200 ||
      !["pending", "succeeded", "failed", "denied"].includes(input.outcome)
    )
      throw Error("插件经历需要稳定event_id及明确结果");
    if (typeof input.text !== "string" || charCount(input.text) > 500)
      throw Error("经历描述最多500字符");
    // Each transition has its own identity. Retrying a completion never duplicates it.
    return this.record(id, {
      ...input,
      kind: "episode",
      source,
      event_id: input.event_id + ":" + input.outcome,
    }, options);
  }
  private async candidates(id: string) {
    const s = await this.state(id),
      rows = await this.memory.readSession(id);
    // Match legacy automatic projections against actual archived tool events, not loose text patterns.
    // Preserve the files for audit; only change their eligibility for conversational recall.
    const traceKey = (source: unknown, origin: any, outcome: unknown, text: string) => JSON.stringify([
      source, origin?.plugin, origin?.platform, origin?.action ?? "工具调用", outcome, text,
    ]);
    const legacyTraces = new Set(rows.filter((row: any) => row.type === "tool" && row.origin?.plugin).map((row: any) =>
      traceKey(row.origin.plugin, row.origin, row.ok ? "succeeded" : "failed",
        `工具 ${row.name} ${row.ok ? "调用完成" : "调用失败"}：${String(JSON.stringify(row.result)).slice(0, 350)}`)));
    const items = s.records.filter((item: any) => !item.tool_trace && !(item.kind === "episode" && item.tool_trace === undefined &&
      legacyTraces.has(traceKey(item.source, item.origin, item.outcome, item.text))));
    const muted = new Map(
      s.records.filter((x) => x.kind === "event-state").map((x) => [x.id, x]),
    );
    for (const row of rows) {
      if (row.type !== "message" || !row.text || muted.get(row.id)?.context_excluded || temporaryPlaceholder(row)) continue;
      const rid = row.id || hash(JSON.stringify(row)).slice(0, 32);
      items.push({
        id: rid,
        kind: "episode",
        text: row.text,
        source: row.role === "user" ? "user" : "assistant",
        ...(originOf(row) ? { origin: originOf(row) } : {}),
        ts: row.ts,
        ...(row.timezone ? { timezone: row.timezone } : {}),
        status: muted.get(rid)?.status || "active",
        pinned: muted.get(rid)?.pinned || false,
        evidence: [rid],
        persona_revision: row.persona_revision,
        session: id,
      });
    }
    return items
      .filter((x) => x.kind !== "event-state" && !x.context_excluded)
      .map((x) => ({ ...x, session: id }));
  }
  private async visible(id: string) {
    const s = await this.state(id),
      items = await this.candidates(id),
      data = await this.spaceData();
    const seen = new Set(items.map((x) => x.session + ":" + x.id));
    const sources = new Map<string, any[]>();
    for (const space of data.spaces.filter((x: any) =>
      s.memberships.includes(x.id),
    )) {
      for (const ref of space.refs) {
        if ((await this.memory.sessionMeta(ref.session))?.deleted) continue;
        const key = ref.session + ":" + ref.record;
        if (seen.has(key)) continue;
        if (!sources.has(ref.session))
          sources.set(ref.session, await this.candidates(ref.session));
        const item = sources.get(ref.session)!.find((x) => x.id === ref.record);
        if (item) {
          items.push({ ...item, shared_space: space.name });
          seen.add(key);
        }
      }
    }
    return items;
  }
  private freshness(item: any, halfLife: number) {
    if (item.pinned) return 1;
    const age = Math.max(0, Date.now() - (Date.parse(item.ts) || Date.now()));
    return Math.pow(0.5, age / (86400000 * halfLife));
  }
  async search(
    id: string,
    query: string,
    opts: {
      manual?: boolean;
      budget?: number;
      exclude?: string[];
      revision?: string;
      archived?: boolean;
      persistTrace?: boolean;
    } = {},
  ) {
    if (typeof query !== "string" || query.length > 16000)
      throw Error("检索文字无效");
    const s = await this.state(id),
      terms = words(query),
      all = await this.visible(id);
    if (!opts.manual && !s.settings.enabled)
      return {
        items: [],
        trace: {
          query: cut(query, 200),
          selected: [],
          estimated_tokens: 0,
          candidates: 0,
          omitted: 0,
        },
      };
    const historical =
      opts.manual || /以前|过去|当时|去年|上个月|曾经|\d{4}[-年]/.test(query);
    const candidates = all.filter(
      (x) =>
        (x.status === "active" || (opts.manual && opts.archived)) &&
        (x.kind === "episode" ||
          x.kind === "cognition" ||
          this.types.has(x.kind) ||
          (opts.manual && opts.archived)) &&
        (!opts.revision ||
          x.shared_space ||
          !x.persona_revision ||
          x.persona_revision === opts.revision) &&
        !(opts.exclude || []).some((text) => text === x.text),
    );
    const indexed = candidates.map((item) => ({
      item,
      terms: words(item.text + " " + JSON.stringify(attribution(item))),
    }));
    const frequency = new Map<string, number>();
    for (const entry of indexed)
      for (const term of entry.terms)
        frequency.set(term, (frequency.get(term) || 0) + 1);
    const scored = indexed
      .map(({ item, terms: tokens }) => {
        const hits = terms.filter((t) => tokens.includes(t));
        const fresh = this.freshness(item, s.settings.half_life_days);
        const relevance =
          hits.reduce(
            (sum, t) =>
              sum +
              Math.log(
                1 + (indexed.length + 1) / ((frequency.get(t) || 0) + 0.5),
              ),
            0,
          ) / Math.sqrt(1 + tokens.length / 40);
        const score =
          relevance *
          (historical ? 1 : 0.2 + 0.8 * fresh) *
          (item.pinned ? 1.3 : 1);
        return {
          ...item,
          freshness: fresh,
          score,
          reason: hits.length
            ? "命中：" +
              hits.join("、") +
              (historical ? "；历史查询" : "；按鲜活度排序")
            : "无相关证据",
        };
      })
      .filter((x) => terms.length && x.score > 0)
      .sort((a, b) => b.score - a.score);
    let budget = Math.min(opts.budget ?? s.settings.recall_tokens, 4000),
      used = 0;
    const selected: any[] = [];
    for (const item of scored) {
      if (selected.length >= 6) break;
      const positions = terms
        .map((term) => item.text.toLowerCase().indexOf(term))
        .filter((pos) => pos >= 0);
      const offset = positions.length
        ? Math.max(0, Math.min(...positions) - 100)
        : 0;
      const snippet = {
        id: item.id,
        kind: item.kind,
        source: item.source,
        ...attribution(item),
        ts: item.ts,
        ...(item.occurred_at ? { occurred_at: item.occurred_at } : {}),
        ...(item.time_range ? { time_range: item.time_range } : {}),
        text: (offset ? "…" : "") + cut(item.text.slice(offset), 500),
        outcome: item.outcome || undefined,
        ...(item.kind === "cognition" ? { uncertain: item.uncertain ?? true } : {}),
      };
      const size = estimateTokens(JSON.stringify(snippet));
      if (used + size > budget) continue;
      selected.push({ ...item, text: snippet.text });
      used += size;
    }
    const trace = {
      query: cut(query, 200),
      selected: selected.map((x) => ({
        id: x.id,
        reason: x.reason,
        score: x.score,
      })),
      estimated_tokens: used,
      candidates: candidates.length,
      omitted: scored.length - selected.length,
    };
    if (!opts.manual && opts.persistTrace !== false)
      await this.update(id, (state) => {
        state.trace = trace;
      });
    return { items: selected, trace };
  }
  async inspect(id: string, query = "", archived = false) {
    const s = await this.state(id);
    const items = query
      ? (await this.search(id, query, { manual: true, budget: 4000, archived }))
          .items
      : (await this.visible(id))
          .filter((x) => archived || x.status === "active")
          .sort((a, b) => {
            const at = timestamp(a.ts) ?? -Infinity, bt = timestamp(b.ts) ?? -Infinity;
            return at === bt ? (a.session.localeCompare(b.session) || a.id.localeCompare(b.id)) : at > bt ? -1 : 1;
          })
          .slice(0, 100)
          .map((x) => ({
            ...x,
            freshness: this.freshness(x, s.settings.half_life_days),
          }));
    return {
      items: items.map((x) => ({ ...x, text: cut(x.text, 1500) })),
      trace: s.trace,
      usage: s.usage,
      settings: s.settings,
      spaces: await this.spaces(id),
      memberships: s.memberships,
    };
  }
  async change(id: string, recordId: string, action: string, spaceId?: string) {
    if (!["pin", "unpin", "archive", "restore", "share", "undo"].includes(action))
      throw Error("记忆操作无效");
    const record = (await this.candidates(id)).find((x) => x.id === recordId);
    if (!record) throw Error("记录不属于当前会话");
    if (action === "share")
      return this.memory.serial(async () => {
        await this.valid(id);
        const s = await this.state(id),
          data = await this.spaceData();
        const space = data.spaces.find(
          (x: any) => x.id === spaceId && s.memberships.includes(x.id),
        );
        if (!space) throw Error("请先加入共享空间");
        if (
          !space.refs.some(
            (x: any) => x.session === id && x.record === recordId,
          )
        )
          space.refs.push({ session: id, record: recordId });
        await atomic(
          await this.path("shared", "spaces.json"),
          JSON.stringify(data, null, 2),
        );
        return { ok: true };
      });
    await this.update(id, (s) => {
      let item = s.records.find((x) => x.id === recordId);
      if (!item) {
        item = {
          id: recordId,
          kind: "event-state",
          status: "active",
          pinned: false,
        };
        s.records.push(item);
      }
      if (action === "undo") {
        undoCognition(s.records, item);
        return;
      }
      if (["archive", "restore"].includes(action) && item.superseded_by)
        throw Error("该认知已被替代；请在新认知上撤回修订");
      if (action === "restore" && item.reverted_at)
        throw Error("已撤回的修订不能直接恢复，请根据新证据重新整理");
      if (action === "pin" || action === "unpin")
        item.pinned = action === "pin";
      else {
        item.status = action === "archive" ? "archived" : "active";
        if (action === "restore" && item.review) {
          item.review_resolved = { ...item.review, at: new Date().toISOString(), by: "user" };
          delete item.review;
        }
      }
    });
    return { ok: true };
  }
  async usage(id: string, category: "chat" | "memory", raw: any) {
    await this.update(id, (s) => {
      const bucket = s.usage[category];
      bucket.requests++;
      if (
        Number.isSafeInteger(raw?.prompt_tokens) &&
        raw.prompt_tokens >= 0 &&
        Number.isSafeInteger(raw?.completion_tokens) &&
        raw.completion_tokens >= 0
      ) {
        bucket.input_tokens += raw.prompt_tokens;
        bucket.output_tokens += raw.completion_tokens;
      } else bucket.unknown_requests++;
    });
  }
  async reserveConsolidation(id: string, tokens: number, onReserved?: (day: string) => void) {
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw Error("整理预留预算必须是非负整数");
    let reservedDay = "";
    const accepted = await this.update(id, (s) => {
      const day = new Date().toISOString().slice(0, 10);
      if (s.daily?.day !== day) s.daily = { day, reserved: 0 };
      const budget = s.settings.daily_memory_tokens ?? 20000;
      if (s.daily.reserved + tokens > budget) return false;
      s.daily.reserved += tokens;
      reservedDay = day;
      return true;
    });
    if (accepted) onReserved?.(reservedDay);
    return accepted;
  }
  /** Core memory requests only; the legacy reservation API remains estimate-based. */
  async reserveMemoryRequest(id: string, tokens: number): Promise<MemoryReservation | null> {
    let day = new Date().toISOString().slice(0, 10);
    if (!(await this.reserveConsolidation(id, tokens, value => { day = value; }))) return null;
    const ticket = Object.freeze({ id: randomUUID(), day, reserved: tokens });
    this.memoryReservations.set(ticket.id, { sessionId: id, ticket });
    return ticket;
  }
  async settleMemoryRequest(id: string, ticket: MemoryReservation, usage?: any, options: { notSent?: boolean } = {}): Promise<void> {
    const entry = this.memoryReservations.get(ticket.id);
    if (!entry) return; // Settled, foreign, or from a prior process: never refund again.
    if (entry.sessionId !== id || entry.ticket.day !== ticket.day || entry.ticket.reserved !== ticket.reserved)
      throw Error("整理预算凭据不匹配");
    if (entry.settlement) return entry.settlement;
    const valid = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
    const actual = options.notSent ? 0
      : valid(usage?.prompt_tokens) && valid(usage?.completion_tokens) && valid(usage.prompt_tokens + usage.completion_tokens)
        ? usage.prompt_tokens + usage.completion_tokens : ticket.reserved;
    entry.settlement = this.update(id, s => {
      // A request crossing midnight must never subtract from the new day's work.
      if (s.daily.day !== ticket.day || ticket.day !== new Date().toISOString().slice(0, 10)) return;
      s.daily.reserved = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, s.daily.reserved + actual - ticket.reserved));
    }).finally(() => { this.memoryReservations.delete(ticket.id); });
    return entry.settlement;
  }
  /** Text, exact source coverage and source version are committed as one atomic state write. */
  async commitDiary(id: string, value: DiaryEntry, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const entry = structuredClone(value);
    validateDiaryEntry(entry);
    if (entry.session !== id) throw Error("日记不属于当前会话");
    return this.update(id, async s => {
      signal?.throwIfAborted();
      const excluded = excludedInputs(s);
      const rows = (await this.memory.readSession(id)).filter(row =>
        !excluded.has(row.id) && !temporaryPlaceholder(row) && diaryRowInScope(row, id, entry.scope));
      if (!validDiarySources(entry, id, entry.scope, rows)) throw Error("日记来源已变更，请重新读取原文");
      const sources = new Set(entry.source_ids);
      const expectedTimes = collectTimes(undefined, rows.filter(row => sources.has(row.id))).time_range;
      if (["start", "end", "incomplete"].some(key =>
          expectedTimes[key as keyof typeof expectedTimes] !== entry.time_range[key as keyof typeof entry.time_range]))
        throw Error("日记来源时间范围不匹配");
      const diaries = s.diaries ?? [];
      const duplicate = diaries.find(item => item.id === entry.id);
      if (duplicate) {
        if (JSON.stringify(duplicate) === JSON.stringify(entry)) return duplicate;
        throw Error("日记ID已存在，不能覆盖旧日记");
      }
      if (diaries.some(item => validDiarySources(item, id, entry.scope, rows) &&
          item.source_ids.some(source => sources.has(source))))
        throw Error("日记来源范围与已有有效日记重叠");
      signal?.throwIfAborted();
      s.diaries = [...diaries, entry];
      return entry;
    });
  }
  async pauseDiary(id: string, scope: string, reason: string) {
    validateDiaryScope(scope);
    if (typeof reason !== "string" || !reason.trim() || charCount(reason) > 200)
      throw Error("日记暂停原因需要1–200字符");
    return this.update(id, s => {
      // Keep the first failure and its date until an explicit reset.
      s.diary_failures ??= {};
      return s.diary_failures[scope] ??= { reason: reason.trim(), at: new Date().toISOString() };
    });
  }
  async retryDiary(id: string, scope: string) {
    validateDiaryScope(scope);
    return this.update(id, s => {
      const paused = !!s.diary_failures?.[scope];
      if (s.diary_failures) delete s.diary_failures[scope];
      return { reset: paused };
    });
  }
  async summaryState(id: string, key: string, value?: any) {
    safeId(key);
    if (value !== undefined)
      await this.update(id, (s) => {
        const revision = inputRevision(s);
        if (revision && value.input_revision !== revision && !(value.text === "" && value.covered === 0)) return;
        s.summaries = { ...s.summaries, [key]: { ...value, ...(revision ? { input_revision: revision } : {}) } };
      });
    const state = await this.state(id), revision = inputRevision(state);
    const saved = Object.hasOwn(state.summaries, key) ? state.summaries[key] : { covered: 0 };
    return revision && saved.input_revision !== revision ? { covered: 0, input_revision: revision } : saved;
  }
  async readSummary(id: string, key: string) {
    const checkpoint = await this.summaryState(id, key);
    return typeof checkpoint.text === "string"
      ? checkpoint.text
      : checkpoint.input_revision ? "" : this.memory.readSummary(key);
  }
  async cognitionCandidates(id: string, text: string, revision?: string) {
    const terms = new Set(words(text));
    const state = await this.state(id);
    const ranked = state.records
      .filter((x) => x.kind === "cognition" && !x.context_excluded && ["active", "review"].includes(x.status) &&
        !x.reverted_at && (!revision || !x.persona_revision || x.persona_revision === revision))
      .map((x) => ({ record: x, score: words(x.text).filter((t) => terms.has(t)).length }))
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const result = [];
    let used = 0;
    for (const { record } of ranked) {
      const candidate = { id: record.id, text: record.text, status: record.status,
        ts: record.ts, ...(record.time_range ? { time_range: record.time_range } : {}),
        uncertain: record.uncertain ?? true, revision: cognitionRevision(record), ...attribution(record) };
      const size = estimateTokens(JSON.stringify(candidate));
      if (used + size > 800) continue;
      result.push(candidate);
      used += size;
      if (result.length === 4) break;
    }
    return result;
  }
  async commitSummary(
    id: string,
    key: string,
    value: any,
    cognitions: any[] = [],
    maintenance?: CognitionMaintenance,
  ) {
    safeId(key);
    if (value.mode === "short" && (cognitions.length || maintenance?.reviews?.length))
      throw Error("短期压缩不能产生或修订长期认知");
    if (value.mode === "long" && cognitions.some((x) => typeof x?.text !== "string" || charCount(x.text) > 80))
      throw Error("长期认知每条不能超过80字符");
    const evidenceRows = await this.memory.readSession(id);
    const byEvidence = new Map(evidenceRows.map((x: any) => [x.id, x]));
    const known = new Set(evidenceRows.map((x: any) => x.id));
    if (
      !Array.isArray(cognitions) ||
      cognitions.length > 2 ||
      cognitions.some(
        (x) =>
          typeof x.text !== "string" ||
          charCount(x.text) > 150 ||
          !Array.isArray(x.evidence) ||
          !x.evidence.length ||
          x.evidence.some((ref: any) => !known.has(ref)),
      )
    )
      throw Error("认知缺少有效来源或超出长度");
    await this.update(id, (s) => {
      if (inputRevision(s) !== value.input_revision) throw Error("摘要来源范围已变更，请重新整理");
      const existing = s.summaries[key];
      if (value.last_id && existing?.last_id === value.last_id &&
          existing.last_offset === value.last_offset && existing.text === value.text &&
          existing.mode === value.mode && existing.start_id === value.start_id &&
          existing.covered === value.covered) return;
      applyCognitions(s.records, key, value, cognitions, known, maintenance);
      for (const record of s.records) {
        if (record.kind !== "cognition" || !record.evidence?.some((id: string) => cognitions.some((x) => x.evidence.includes(id)))) continue;
        Object.assign(record, collectOrigins(undefined, record.evidence.map((id: string) => byEvidence.get(id))));
        Object.assign(record, collectTimes(undefined, record.evidence.map((id: string) => byEvidence.get(id))));
      }
      s.summaries = { ...s.summaries, [key]: value };
    });
  }
  async recoverSummaries() {
    const index = await this.json(await this.path("index.json"), {
      sessions: {},
    });
    for (const [id, meta] of Object.entries<any>(index.sessions)) {
      if (meta.deleted) continue;
      const state = await this.state(id);
      for (const key of Object.keys(state.summaries)) {
        const checkpoint = await this.summaryState(id, key);
        if (
          (checkpoint.text !== undefined || checkpoint.input_revision) &&
          (await this.memory.readSummary(key)) !== (checkpoint.text ?? "")
        )
          await this.memory.writeSummary(key, checkpoint.text ?? "", id);
      }
    }
  }
  plugin(owner: string, cleanup: (dispose: () => void) => unknown) {
    const namespace = "plugin:" + owner + ":";
    let alive = true;
    cleanup(() => {
      alive = false;
    });
    const check = () => {
      if (!alive) throw Error("插件已停用");
    };
    return Object.freeze({
      readDocument: <Data = unknown>(id: string, key: string) => {
        check();
        return this.readDocument<Data>(id, owner, key, check);
      },
      saveDocument: <Data = unknown>(id: string, input: DocumentWrite<Data>) => {
        check();
        return this.saveDocument(id, owner, input, check);
      },
      readSession: async (id: string, limit = 100, beforeId?: string) => {
        check();
        await this.valid(id);
        const count = Math.min(100, Math.max(0, limit));
        if (beforeId === undefined) return this.memory.readSession(id, count);
        const rows = await this.memory.readSession(id), before = rows.findIndex((row: any) => row.id === beforeId);
        if (typeof beforeId !== "string" || before < 0) throw Error("历史分页消息ID不存在");
        return count ? rows.slice(Math.max(0, before - count), before) : [];
      },
      excludeInputs: async (id: string, messageIds: string[]) => {
        check();
        return this.excludeInputs(id, owner, messageIds, check);
      },
      readFacts: async () => {
        check();
        return this.memory.readFacts();
      },
      localFacts: async (id: string) => {
        check();
        return this.localFacts(id);
      },
      search: async (id: string, query: string) => {
        check();
        return this.search(id, query, { manual: true });
      },
      recordExperience: async (id: string, input: any) => {
        check();
        return this.experience(id, owner, { ...input, origin: pluginOrigin(owner, input.origin) });
      },
      registerType: (name: string, version = 1) => {
        check();
        if (
          !/^[a-z][a-z0-9_-]{0,39}$/.test(name) ||
          !Number.isSafeInteger(version) ||
          version < 1
        )
          throw Error("扩展类型无效");
        const kind = namespace + name;
        if (this.types.has(kind)) throw Error("扩展类型已注册");
        const registration = { owner, version };
        this.types.set(kind, registration);
        const dispose = () => {
          if (this.types.get(kind) === registration) this.types.delete(kind);
        };
        const tracked = cleanup(dispose);
        return { kind, dispose: typeof tracked === "function" ? tracked as () => void : dispose };
      },
      saveExtension: async (id: string, input: any) => {
        check();
        const origin = pluginOrigin(owner, input.origin);
        if (
          !input.kind?.startsWith(namespace) ||
          this.types.get(input.kind)?.owner !== owner
        )
          throw Error("扩展类型不属于当前插件");
        if (
          typeof input.key !== "string" ||
          input.key.length > 100 ||
          typeof input.text !== "string" ||
          charCount(input.text) > 500 ||
          JSON.stringify(input.data ?? null).length > 16384
        )
          throw Error("扩展数据过大或格式无效");
        await this.valid(id);
        const recordId = hash(owner + ":" + input.kind + ":" + input.key).slice(
          0,
          32,
        );
        await this.update(id, async (s) => {
          check();
          const file = await this.path(
            "sessions",
            id,
            "extensions",
            hash(owner).slice(0, 20),
            recordId + ".json",
          );
          await mkdir(dirname(file), { recursive: true });
          await atomic(
            file,
            JSON.stringify({
              owner,
              kind: input.kind,
              key: input.key,
              version: this.types.get(input.kind)!.version,
              data: input.data ?? null,
            }),
          );
          const old = s.records.find((x) => x.id === recordId);
          const item = {
            id: recordId,
            kind: input.kind,
            text: input.text,
            source: owner,
            origin,
            ts: new Date().toISOString(),
            status: input.active === false ? "archived" : "active",
            pinned: false,
            evidence: [],
          };
          if (old) Object.assign(old, item);
          else s.records.push(item);
        });
        return { id: recordId };
      },
      readExtension: async (id: string, kind: string, key: string) => {
        check();
        await this.valid(id);
        if (
          !kind.startsWith(namespace) ||
          this.types.get(kind)?.owner !== owner
        )
          throw Error("扩展类型不可用");
        const rid = hash(owner + ":" + kind + ":" + key).slice(0, 32);
        return this.json(
          await this.path(
            "sessions",
            id,
            "extensions",
            hash(owner).slice(0, 20),
            rid + ".json",
          ),
          null,
        );
      },
    });
  }
}
