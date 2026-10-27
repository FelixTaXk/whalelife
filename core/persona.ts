import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveChatModel } from "./model-config.ts";
export async function persona(root: string, config: any, id: string) {
  const item = config.personas[id];
  if (!item) throw Error("人格不存在");
  const provider = resolveChatModel(config, id);
  return {
    ...item,
    id,
    provider,
    prompt: await readFile(resolve(root, item.file), "utf8"),
  };
}
