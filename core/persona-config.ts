import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const revision = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export class PersonaFiles {
  root: string;
  config: any;
  logger: any;
  queue: Promise<unknown> = Promise.resolve();
  constructor(root: string, config: any, logger: any) {
    this.root = root;
    this.config = config;
    this.logger = logger;
  }
  private file(id: string) {
    if (typeof id !== "string" || !Object.hasOwn(this.config.personas, id))
      throw Error("人格不存在");
    return resolve(this.root, this.config.personas[id].file);
  }
  async get(id: string) {
    const prompt = await readFile(this.file(id), "utf8");
    return { id, prompt, revision: revision(prompt) };
  }
  save(input: any) {
    const task = this.queue.then(async () => {
      const file = this.file(input?.id);
      if (
        typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        Buffer.byteLength(input.prompt) > 32768
      )
        throw Error("人格内容不能为空，且不能超过 32 KiB");
      const current = await readFile(file, "utf8");
      const conflict = () =>
        Object.assign(
          Error("人格内容已在其他窗口或文件中修改，请重新读取后编辑"),
          { status: 409 },
        );
      if (revision(current) !== input.revision) throw conflict();
      const temp = file + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temp, input.prompt, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        if (revision(await readFile(file, "utf8")) !== input.revision)
          throw conflict();
        await rename(temp, file);
      } finally {
        await unlink(temp).catch(() => {});
      }
      this.logger.info("人格内容已保存", { persona: input.id });
      return {
        id: input.id,
        prompt: input.prompt,
        revision: revision(input.prompt),
      };
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
