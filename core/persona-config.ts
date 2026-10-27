import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export class PersonaFiles {
  root: string;
  config: any;
  constructor(root: string, config: any, _logger?: any) {
    this.root = root;
    this.config = config;
  }
  async get(id: string) {
    if (typeof id !== "string" || !Object.hasOwn(this.config.personas, id))
      throw Error("人格不存在");
    const prompt = await readFile(
      resolve(this.root, this.config.personas[id].file),
      "utf8",
    );
    return {
      id,
      prompt,
      revision: createHash("sha256").update(prompt).digest("hex"),
    };
  }
}
