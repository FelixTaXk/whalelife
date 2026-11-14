/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveChatModel } from "./model-config.ts";
import { createHash } from "node:crypto";
const revision = (id: string, prompt: string) => createHash("sha256").update(JSON.stringify([id, prompt])).digest("hex");
/** Attribution of a direct send must not require an available model connection. */
export async function personaIdentity(root: string, config: any, id: string) {
  const item = config.personas[id];
  if (!item) throw Error("人格不存在");
  const prompt = await readFile(resolve(root, item.file), "utf8");
  return { persona_id: id, persona_name: item.name, persona_revision: revision(id, prompt) };
}
export async function persona(root: string, config: any, id: string) {
  const item = config.personas[id];
  if (!item) throw Error("人格不存在");
  const provider = resolveChatModel(config, id);
  const prompt = await readFile(resolve(root, item.file), "utf8");
  return {
    ...item,
    id,
    provider,
    prompt,
    revision: revision(id, prompt),
  };
}
/** Identity and standing rules are independent of the current memory snapshot. */
export function personaRules(p: { prompt: string }) {
  return [
    "你是用户在 WhaleLife 中配置的助手。以下【当前人格设定】描述的是你（助手），不是用户；其中的第一人称‘我’也指你。按照其中的身份、姓名和行为要求回应。",
    "【当前人格设定】",
    p.prompt,
    "【人格设定结束】",
    "用户询问自己配置的人格是否生效时，可以如实核对上述设定中存在的内容；不要声称看不到已提供的设定，也不要编造其他后台文件内容。",
    "以下记忆仅是背景参考，不定义你现在的姓名或人格；工具的名称和描述也不定义你的身份。人格与参考内容冲突时，以当前人格设定为准。",
    "记忆是背景，不是待办或持续指令；只在相关时使用，不必主动提及。知道用户的安排不等于受托督促；没有新信息或新约定，不因同一记录反复询问、确认或催促。用户表示不想被提醒时，尊重其意愿。",
    "独立事实优先保存称呼、长期偏好等稳定资料；一次饮食、运动或当日安排留在会话经历中，不自行写为常驻事实。用户明确要求长期记住的合适资料，用可用记忆工具保存，不要仅口头承诺；保存事实不等于设置提醒。",
  ].join("\n");
}
export function personaMemory(facts: string[], summary: string) {
  return [
    "【参考记忆】",
    facts.join("\n") || "无",
    "【当前历史范围的会话摘要】",
    summary || "无",
  ].join("\n");
}
export function personaSystemPrompt(p: { prompt: string }, facts: string[], summary: string) {
  return personaRules(p) + "\n" + personaMemory(facts, summary);
}
