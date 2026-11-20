/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { modelUsageDetails } from "./model-usage.ts";

type Target = {
  archiveRoot: string;
  providerId: string;
  modelId: string;
  model: string;
  /** Includes disabled chat configurations when checking the old archive format. */
  uniqueModel: boolean;
  configMtimeMs: number;
  now?: number;
  provider?: { base_url?: string; protocol?: string };
  optimized?: boolean;
  costBaseline?: CacheCostBaseline;
};
type Sample = {
  session: string; at: number; input: number | null; hit: number | null;
  output: number | null; cost: NonNullable<ReturnType<typeof modelUsageDetails>["reported_cost"]> | null;
};
/** Three consecutive first requests in one session. No archive IDs or conversation content. */
export type CacheCostBaseline = {
  session_hash: string; oldest_at: number; currency: string;
  min_input: number; min_output: number; max_cost: number;
};
type Archive = { session: string; name: string };
const day = 24 * 3600_000, windowDays = 7, maxTurns = 12, longInput = 4096;
const maxFolders = 16, maxEntries = 8192, maxFiles = 64, headBytes = 64 * 1024;
const runName = /^\d{17}_[a-f0-9]{32}\.jsonl$/;
const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

const sessionHash = (session: string) => createHash("sha256").update(session).digest("hex");

function hasBill(s: Sample): s is Sample & { input: number; output: number; cost: NonNullable<Sample["cost"]> } {
  return s.input !== null && s.input > 0 && s.output !== null && s.cost !== null;
}

function costBaseline(turns: Sample[]): CacheCostBaseline | undefined {
  if (turns.length !== 3 || !turns.every(hasBill)) return;
  const [first] = turns;
  if (!turns.every(s => s.session === first.session && s.cost.currency === first.cost.currency)) return;
  return { session_hash: sessionHash(first.session), oldest_at: Math.min(...turns.map(s => s.at)),
    currency: first.cost.currency, min_input: Math.min(...turns.map(s => s.input)),
    min_output: Math.min(...turns.map(s => s.output)), max_cost: Math.max(...turns.map(s => s.cost.amount)) };
}

function costReview(samples: Sample[], saved: CacheCostBaseline | undefined, now: number) {
  if (!samples.length) return;
  const session = samples[0].session;
  const turns = samples.filter(s => s.session === session);
  const recent = turns.slice(0, 3);
  if (recent.length !== 3 || !recent.every(hasBill)) return;
  const beforeEnable = saved?.session_hash === sessionHash(session) && Number.isFinite(saved.oldest_at) &&
    saved.oldest_at >= now - windowDays * day && saved.oldest_at < recent[2].at;
  const baseline = beforeEnable ? saved : costBaseline(turns.slice(3, 6));
  if (!baseline || !count(baseline.min_input) || !count(baseline.min_output) ||
      !Number.isFinite(baseline.max_cost) || baseline.max_cost < 0) return;
  if (!recent.every(s => s.input <= baseline.min_input && s.output <= baseline.min_output &&
      s.cost.currency === baseline.currency && s.cost.amount > baseline.max_cost)) return;
  const amounts = recent.map(s => s.cost.amount).reverse().join("、");
  const reference = beforeEnable ? "手动开启前同一会话的三轮" : "当前配置下同一会话紧邻的前三轮";
  return `${reference}聊天首请求最高为 ${baseline.max_cost} ${baseline.currency}。最近连续三轮首请求的输入和输出量均未增加，服务回传费用均更高（${amounts} ${baseline.currency}）。可核对账单后手动关闭缓存优化。开关仍保持开启。`;
}

function summarize(samples: Sample[], limited: boolean, target: Target) {
  const measured = samples.filter(s => s.hit !== null && s.input !== null && s.input > 0);
  const long = samples.filter(s => s.input !== null && s.input >= longInput);
  const input = measured.reduce((sum, s) => sum + s.input!, 0);
  const hits = measured.reduce((sum, s) => sum + s.hit!, 0);
  const observed = {
    window_days: windowDays, max_turns: maxTurns, long_input_tokens: longInput,
    turns: samples.length, measured_turns: measured.length,
    long_turns: long.length, measured_long_turns: long.filter(s => s.hit !== null).length,
    cached_input_percent: input ? Math.round(1000 * hits / input) / 10 : null, limited,
  };
  const result = (code: "healthy" | "insufficient" | "unknown" | "test" | "review_cost", message: string) =>
    ({ observed, advice: { code, message } });
  if (target.optimized && !limited) {
    const message = costReview(samples, target.costBaseline, target.now ?? Date.now());
    if (message) return result("review_cost", message);
  }
  if (!samples.length) return result("insufficient", limited
    ? "可读取的近期档案不足以确认该连接的缓存表现。可以继续正常使用。"
    : "最近一次保存配置后，还没有能归属到该连接和模型的近期聊天首轮记录。可以继续正常使用。");
  if (!measured.length) return result("unknown", "近期聊天首轮缺少可用的缓存计量，命中率未知。可以继续正常使用。");
  const recent = samples.slice(0, 3);
  if (!target.optimized && !limited && recent.length === 3 && recent.every(s => s.session === recent[0].session &&
    s.input !== null && s.input >= longInput && s.hit !== null && s.hit / s.input < 0.2) &&
    recent[0].at - recent[2].at <= 60 * 60_000) {
    return result("test", "同一会话最近三轮在一小时内均使用长输入，首个请求的缓存命中率都低于 20%。如果实际输入费用让你在意，可以考虑付费对比。");
  }
  const latest = samples[0];
  if (latest.input !== null && latest.input >= longInput && latest.hit !== null && latest.hit / latest.input >= 0.5)
    return result("healthy", target.optimized ? "最近一轮长输入已有至少一半命中缓存，命中比例本身无法说明费用变化。"
      : "最近一轮长输入已有至少一半命中缓存，可以沿用当前配置。");
  if (target.optimized) return result("insufficient", "近期记录尚不足以确认相同或更少输入、输出下的持续费用上涨，可以继续观察正常聊天。");
  return result("insufficient", limited
    ? "近期档案只覆盖了部分记录，现有样本不足以建议付费对比。"
    : "近期样本尚未显示同一会话连续多轮长输入都低命中，可以继续观察正常聊天。");
}

// Execution IDs begin with the UTC creation timestamp. Opening only recent heads
// keeps a very long tool chain and its later model requests outside this read.
async function firstRequest(target: Target, archive: Archive, now: number, since: number):
  Promise<(Sample & { limited?: boolean }) | null> {
  const path = join(target.archiveRoot, archive.session, archive.name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error("无效执行档案");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== info.dev || stat.ino !== info.ino)
      throw Error("执行档案已改变");
    const length = Math.min(stat.size, headBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = head.split("\n");
    lines.pop(); // Only a fully committed line may provide evidence.
    if (!lines.length) throw Error("缺少执行档案开头");
    const start = JSON.parse(lines[0]);
    if (start?.kind !== "start") throw Error("缺少执行起点");
    if (start.data?.kind !== "conversation") return null;
    const at = Date.parse(start.ts);
    if (!Number.isFinite(at)) throw Error("缺少执行时间");
    if (at <= target.configMtimeMs || at < since || at > now) return null;
    let matched = false, requested = false;
    for (const line of lines.slice(1)) {
      const row = JSON.parse(line);
      if (row?.kind === "context") {
        const ctx = row.data;
        if (ctx?.provider !== target.providerId || ctx?.model !== target.model || ctx.cache_layout_eligible === false)
          return null;
        if (ctx.model_id === undefined && !target.uniqueModel) throw Error("同名模型的旧档案缺少配置编号");
        if (ctx.model_id !== undefined && ctx.model_id !== target.modelId) return null;
        matched = true;
      }
      if (!matched || row?.data?.round !== 1) continue;
      if (row.kind === "model_start") requested = true;
      if (row.kind !== "model_result") continue;
      const usage = row.data.usage;
      const details = modelUsageDetails(usage, target.provider);
      return { session: archive.session, at, input: count(usage?.prompt_tokens) ? usage.prompt_tokens : null,
        hit: details.cache.hit_tokens,
        output: count(usage?.completion_tokens) ? usage.completion_tokens : null,
        cost: details.reported_cost ?? null };
    }
    if (matched && requested) return { session: archive.session, at, input: null, hit: null, output: null, cost: null,
      limited: stat.size > bytesRead || !head.endsWith("\n") };
    if (stat.size > bytesRead) throw Error("首轮超出档案读取范围");
    return null;
  } finally { await file.close(); }
}

/** Read ordinary conversation executions across sessions using a bounded local sample. */
async function readSamples(target: Target) {
  const now = target.now ?? Date.now(), since = now - windowDays * day;
  if (!Number.isFinite(target.configMtimeMs) || target.configMtimeMs <= 0 ||
      !Number.isFinite(now)) return { samples: [], limited: true };
  const samples: Sample[] = [];
  let limited = false;
  try {
    const root = await lstat(target.archiveRoot);
    if (root.isSymbolicLink() || !root.isDirectory()) return { samples: [], limited: true };
    const folders: { session: string; changed: number }[] = [];
    let entries = 0;
    for await (const entry of await opendir(target.archiveRoot)) {
      if (++entries > 512) { limited = true; break; }
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)) continue;
      const stat = await lstat(join(target.archiveRoot, entry.name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) folders.push({ session: entry.name, changed: stat.mtimeMs });
    }
    folders.sort((a, b) => b.changed - a.changed);
    if (folders.length > maxFolders && folders[maxFolders].changed >= since) limited = true;
    const oldest = new Date(Math.max(since, Math.min(target.configMtimeMs, now))).toISOString().replace(/\D/g, "");
    const candidates: Archive[] = [];
    for (const { session } of folders.slice(0, maxFolders)) {
      const names: string[] = [];
      let seen = 0;
      for await (const entry of await opendir(join(target.archiveRoot, session))) {
        if (++seen > maxEntries) { limited = true; break; }
        if (entry.isFile() && runName.test(entry.name) && entry.name >= oldest) names.push(entry.name);
      }
      names.sort().reverse();
      for (const name of names.slice(0, maxFiles + 1)) candidates.push({ name, session });
    }
    candidates.sort((a, b) => b.name.localeCompare(a.name));
    for (const archive of candidates.slice(0, maxFiles)) {
      try {
        const sample = await firstRequest(target, archive, now, since);
        if (sample) {
          samples.push(sample);
          if (sample.limited) limited = true;
        }
      } catch { limited = true; }
      if (samples.length === maxTurns) break;
    }
    if (samples.length < maxTurns && candidates.length > maxFiles) limited = true;
  } catch (error: any) {
    if (error?.code !== "ENOENT") limited = true;
  }
  return { samples: samples.sort((a, b) => b.at - a.at), limited };
}

/** Capture real usage only while manually enabling this tested connection. */
export async function captureCacheCostBaseline(target: Target) {
  const { samples, limited } = await readSamples(target);
  if (limited || !samples.length) return;
  return costBaseline(samples.filter(s => s.session === samples[0].session).slice(0, 3));
}

export async function readCacheAdvice(target: Target) {
  const { samples, limited } = await readSamples(target);
  return summarize(samples, limited, target);
}
