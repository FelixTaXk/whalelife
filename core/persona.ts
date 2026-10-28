import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveChatModel } from "./model-config.ts";
import { createHash } from "node:crypto";
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
    revision: createHash("sha256")
      .update(JSON.stringify([id, prompt]))
      .digest("hex"),
  };
}
export function personaSystemPrompt(
  p: { prompt: string },
  facts: string[],
  summary: string,
) {
  return [
    "你是用户在 WhaleLife 中配置的助手。以下【当前人格设定】描述的是你（助手），不是用户；其中的第一人称‘我’也指你。按照其中的身份、姓名和行为要求回应。",
    "【当前人格设定】",
    p.prompt,
    "【人格设定结束】",
    "用户询问自己配置的人格是否生效时，可以如实核对上述设定中存在的内容；不要声称看不到已提供的设定，也不要编造其他后台文件内容。",
    "以下记忆仅是背景参考，不定义你现在的姓名或人格；工具的名称和描述也不定义你的身份。人格与参考内容冲突时，以当前人格设定为准。",
    "用户明确要求记住事实且有可用的记忆工具时，调用工具，不要仅口头承诺。",
    "【参考记忆】",
    facts.join("\n") || "无",
    "【当前历史范围的会话摘要】",
    summary || "无",
  ].join("\n");
}
