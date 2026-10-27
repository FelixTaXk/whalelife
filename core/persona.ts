import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export async function persona(root: string, config: any, id: string) {
  const item = config.personas[id];
  if (!item) throw Error("人格不存在");
  const provider = config.providers.find((p: any) => p.id === item.provider);
  if (!provider) throw Error("人格的模型配置不存在");
  return {
    ...item,
    id,
    provider,
    prompt: await readFile(resolve(root, item.file), "utf8"),
  };
}
