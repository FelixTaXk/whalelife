/** Descriptive metadata, never routing, permissions or model instructions. */
export type Origin = { plugin?: string; channel?: string; platform?: string; action?: string };
export type OriginDetails = Pick<Origin, "platform" | "action">;
const limits: Record<string, number> = { plugin: 200, channel: 40, platform: 32, action: 48 };
export function validateOrigin(value: unknown, allowed = Object.keys(limits)): Origin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("来源信息必须是对象");
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (!allowed.includes(key) || typeof text !== "string" || !text.trim() ||
        Array.from(text).length > limits[key] || /[\u0000-\u001f\u007f]/.test(text))
      throw Error("来源字段无效或超长：" + key);
    result[key] = text;
  }
  return Object.fromEntries(Object.keys(limits).filter((key) => Object.hasOwn(result, key)).map((key) => [key, result[key]]));
}
export function pluginOrigin(owner: string, details?: OriginDetails): Origin {
  return { ...validateOrigin({ plugin: owner }), ...(details === undefined ? {} : validateOrigin(details, ["platform", "action"])) };
}
export function originOf(row: any): Origin | undefined {
  if (row?.origin) return validateOrigin(row.origin);
  // Old transcripts retain their actual channel, never guess a platform or owner.
  if (typeof row?.channel === "string") return validateOrigin({ channel: row.channel });
  return undefined;
}
export function validateAttribution(value: any) {
  if (value.origin !== undefined) validateOrigin(value.origin);
  if (value.origins !== undefined) {
    if (!Array.isArray(value.origins) || value.origins.length > 8) throw Error("来源列表无效");
    value.origins.forEach((x: unknown) => validateOrigin(x));
  }
  if (value.origins_incomplete !== undefined && typeof value.origins_incomplete !== "boolean")
    throw Error("来源完整性标记无效");
}
export function collectOrigins(previous: any, rows: any[]) {
  const origins: Origin[] = [], keys = new Set<string>();
  let incomplete = previous?.origins_incomplete === true || (!!previous?.text && !previous?.origins);
  for (const origin of [...(previous?.origins ?? []), ...rows.map(originOf)]) {
    if (!origin || !Object.keys(origin).length) { incomplete = true; continue; }
    const key = JSON.stringify(origin);
    if (keys.has(key)) continue;
    keys.add(key);
    if (origins.length < 8) origins.push(origin); else incomplete = true;
  }
  return { origins, ...(incomplete ? { origins_incomplete: true } : {}) };
}
export function attribution(value: any) {
  return { ...(value.origin ? { origin: value.origin } : {}),
    ...(value.origins ? { origins: value.origins } : {}),
    ...(value.origins_incomplete ? { origins_incomplete: true } : {}) };
}
export function originNote(value: any) {
  return value?.origins?.length
    ? JSON.stringify(attribution(value))
    : "来源未记录";
}
function historyLabel(row: any) {
  const origin = originOf(row);
  // Message roles already identify user vs assistant; don't repeat receive/reply labels.
  if (!origin) return "来源未记录";
  const { action: _action, ...where } = origin;
  return JSON.stringify(where);
}
export function renderHistory(rows: any[]) {
  let previous: string | undefined;
  return rows.map((row) => {
    const label = historyLabel(row), prefix = label !== previous ? `【历史来源 ${label}】\n` : "";
    previous = label;
    return { role: row.role, content: prefix + row.content };
  });
}
/** Linear trimming; the first retained row always regains its source label. */
export function historyTail(rows: any[], capacity: number, estimate: (text: string) => number, keep = 0) {
  const labels = rows.map(historyLabel);
  const prefixes = labels.map((label) => estimate(JSON.stringify(`【历史来源 ${label}】\n`)) + 1);
  const costs = rows.map((row, i) => estimate(JSON.stringify({ role: row.role, content: row.content })) + 1 +
    (i === 0 || labels[i] !== labels[i - 1] ? prefixes[i] : 0));
  let used = costs.reduce((sum, n) => sum + n, 1), start = 0;
  const extra = () => start > 0 && start < rows.length && labels[start] === labels[start - 1] ? prefixes[start] : 0;
  while (used + extra() > capacity && start < rows.length - keep) used -= costs[start++];
  return { rows: rows.slice(start), omitted: start, tokens: used + extra() };
}
