import { readFile, mkdir, lstat } from "node:fs/promises";
import { join, relative, resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomic, safeId, type Memory } from "./memory.ts";
import { applyCognitions, cognitionRevision, undoCognition, type CognitionMaintenance } from "./cognition.ts";

export const charCount = (text: string) => Array.from(text).length;
export function estimateTokens(text: string) {
  const ascii = (text.match(/[\x00-\x7f]/g) || []).length;
  return Math.ceil(ascii / 3 + (charCount(text) - ascii) * 1.5);
}
const cut = (text: string, n: number) => Array.from(text).slice(0, n).join("");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
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
      s.settings.daily_memory_tokens > 200000)
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
    safeId(key);
    if (
      !object(value) ||
      !count(value.covered) ||
      (value.last_id !== undefined && typeof value.last_id !== "string") ||
      (value.last_offset !== undefined && !count(value.last_offset)) ||
      (value.retry_at !== undefined && !count(value.retry_at)) ||
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
  types = new Map<string, { owner: string; version: number }>();
  maintenance: (id?: string) => boolean = () => false;
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
      const result = await fn(s);
      validateMemoryState(s);
      const file = await this.file(id);
      await mkdir(dirname(file), { recursive: true });
      await atomic(file, JSON.stringify(s, null, 2));
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
        s.records.map((x) => [x.id, x.status, x.pinned, x.text, x.uncertain]),
        Object.entries(s.summaries).map(([key, x]) => [key, x.text, x.mode]),
        await this.memory.readFacts(),
      ]),
    );
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
    if (!Number.isInteger(daily) || daily < 0 || daily > 200000)
      throw Error("每日整理预算需为0–200000");
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
  async record(id: string, input: any) {
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
        ts: new Date().toISOString(),
        status: "active",
        pinned: false,
        evidence,
        persona_revision: input.persona_revision || null,
        outcome: input.outcome || null,
      };
      s.records.push(item);
      return item;
    });
  }
  async experience(id: string, source: string, input: any) {
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
    });
  }
  private async candidates(id: string) {
    const s = await this.state(id),
      rows = await this.memory.readSession(id);
    const items = [...s.records];
    const muted = new Map(
      s.records.filter((x) => x.kind === "event-state").map((x) => [x.id, x]),
    );
    for (const row of rows) {
      if (row.type !== "message" || !row.text) continue;
      const rid = row.id || hash(JSON.stringify(row)).slice(0, 32);
      items.push({
        id: rid,
        kind: "episode",
        text: row.text,
        source: row.role === "user" ? "user" : "assistant",
        ts: row.ts,
        status: muted.get(rid)?.status || "active",
        pinned: muted.get(rid)?.pinned || false,
        evidence: [rid],
        persona_revision: row.persona_revision,
        session: id,
      });
    }
    return items
      .filter((x) => x.kind !== "event-state")
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
      terms: words(item.text),
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
        ts: item.ts,
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
    if (!opts.manual)
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
          .reverse()
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
  async reserveConsolidation(id: string, tokens: number) {
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw Error("整理预留预算必须是非负整数");
    return this.update(id, (s) => {
      const day = new Date().toISOString().slice(0, 10);
      if (s.daily?.day !== day) s.daily = { day, reserved: 0 };
      const budget = s.settings.daily_memory_tokens ?? 20000;
      if (s.daily.reserved + tokens > budget) return false;
      s.daily.reserved += tokens;
      return true;
    });
  }
  async summaryState(id: string, key: string, value?: any) {
    safeId(key);
    if (value !== undefined)
      await this.update(id, (s) => {
        s.summaries = { ...s.summaries, [key]: value };
      });
    const summaries = (await this.state(id)).summaries;
    return Object.hasOwn(summaries, key) ? summaries[key] : { covered: 0 };
  }
  async readSummary(id: string, key: string) {
    const checkpoint = await this.summaryState(id, key);
    return typeof checkpoint.text === "string"
      ? checkpoint.text
      : this.memory.readSummary(key);
  }
  async cognitionCandidates(id: string, text: string, revision?: string) {
    const terms = new Set(words(text));
    const state = await this.state(id);
    const ranked = state.records
      .filter((x) => x.kind === "cognition" && ["active", "review"].includes(x.status) &&
        !x.reverted_at && (!revision || !x.persona_revision || x.persona_revision === revision))
      .map((x) => ({ record: x, score: words(x.text).filter((t) => terms.has(t)).length }))
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const result = [];
    let used = 0;
    for (const { record } of ranked) {
      const candidate = { id: record.id, text: record.text, status: record.status,
        uncertain: record.uncertain ?? true, revision: cognitionRevision(record) };
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
    const known = new Set(
      (await this.memory.readSession(id)).map((x: any) => x.id),
    );
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
      const existing = s.summaries[key];
      if (value.last_id && existing?.last_id === value.last_id &&
          existing.last_offset === value.last_offset && existing.text === value.text &&
          existing.mode === value.mode && existing.start_id === value.start_id &&
          existing.covered === value.covered) return;
      applyCognitions(s.records, key, value, cognitions, known, maintenance);
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
      for (const [key, checkpoint] of Object.entries<any>(state.summaries))
        if (
          typeof checkpoint.text === "string" &&
          (await this.memory.readSummary(key)) !== checkpoint.text
        )
          await this.memory.writeSummary(key, checkpoint.text, id);
    }
  }
  plugin(owner: string, cleanup: (dispose: () => void) => void) {
    const namespace = "plugin:" + owner + ":";
    let alive = true;
    cleanup(() => {
      alive = false;
    });
    const check = () => {
      if (!alive) throw Error("插件已停用");
    };
    return Object.freeze({
      readSession: async (id: string, limit = 100) => {
        check();
        await this.valid(id);
        return this.memory.readSession(id, Math.min(100, Math.max(0, limit)));
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
        return this.experience(id, owner, input);
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
        this.types.set(kind, { owner, version });
        const dispose = () => {
          this.types.delete(kind);
        };
        cleanup(dispose);
        return { kind, dispose };
      },
      saveExtension: async (id: string, input: any) => {
        check();
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
