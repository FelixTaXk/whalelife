import {
  mkdir,
  readFile,
  appendFile,
  writeFile,
  rename,
  readdir,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.ts";
export const safeId = (id: string) => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw Error("会话 ID 无效");
  return id;
};
export type SessionIndex = {
  version?: number;
  sessions: Record<string, any>;
  [key: string]: any;
};
export function parseSessionIndex(raw: string): SessionIndex {
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !value.sessions ||
    typeof value.sessions !== "object" ||
    Array.isArray(value.sessions)
  )
    throw Error("会话索引损坏，请从备份恢复，未覆盖现有索引");
  return value;
}
export function indexSessionMeta(index: SessionIndex, id: string) {
  const value = Object.hasOwn(index.sessions, id) ? index.sessions[id] : null;
  if (
    value !== null &&
    (!value || typeof value !== "object" || Array.isArray(value))
  )
    throw Error("会话索引记录损坏，请从备份恢复");
  return value;
}
export async function atomic(file: string, data: string) {
  const temp = file + ".tmp";
  await writeFile(temp, data, "utf8");
  await rename(temp, file);
}
export class Memory {
  root: string;
  logger: Logger;
  queue: Promise<any> = Promise.resolve();
  constructor(root: string, logger: Logger) {
    this.root = root;
    this.logger = logger;
  }
  async init() {
    for (const dir of ["sessions", "summaries", "personas"])
      await mkdir(join(this.root, dir), { recursive: true });
    try {
      await writeFile(join(this.root, "facts.md"), "# facts\n", { flag: "wx" });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
    try {
      await writeFile(
        join(this.root, "index.json"),
        JSON.stringify({ version: 1, sessions: {} }, null, 2),
        { flag: "wx" },
      );
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
    this.logger.info("记忆就绪", { root: this.root });
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private async sessionIndex(): Promise<SessionIndex> {
    try {
      return parseSessionIndex(
        await readFile(join(this.root, "index.json"), "utf8"),
      );
    } catch (error: any) {
      if (error.code === "ENOENT") return { version: 1, sessions: {} };
      throw error;
    }
  }
  // Atomic index replacement makes this a snapshot read, so callers holding serial can use it too.
  async sessionMeta(id: string) {
    return indexSessionMeta(await this.sessionIndex(), safeId(id));
  }
  saveSessionMeta(id: string, patch: Record<string, unknown>) {
    safeId(id);
    return this.serial(async () => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw Error("会话元数据无效");
      const index = await this.sessionIndex(),
        previous = indexSessionMeta(index, id);
      if (previous?.deleted) throw Error("会话已删除，请新建会话");
      const meta = { ...previous, ...patch };
      index.sessions = { ...index.sessions, [id]: meta };
      await atomic(
        join(this.root, "index.json"),
        JSON.stringify(index, null, 2),
      );
      return meta;
    });
  }
  async readFacts() {
    return (await readFile(join(this.root, "facts.md"), "utf8"))
      .split(/\r?\n/)
      .filter((x) => x.trim() && !x.startsWith("#"));
  }
  writeFacts(lines: string[]) {
    return this.serial(() =>
      atomic(
        join(this.root, "facts.md"),
        "# facts\n" + lines.join("\n") + "\n",
      ),
    );
  }
  addFact(text: string) {
    return this.serial(async () => {
      text = text.replace(/[\r\n]+/g, " ").trim();
      if (!text || text.startsWith("#") || text.length > 2000)
        throw Error("事实不能为空或超过 2000 字");
      await appendFile(join(this.root, "facts.md"), text + "\n");
      this.logger.info("记忆事实追加", { file: "facts.md", count: 1 });
      return "已记下：" + text;
    });
  }
  async readSession(id: string, limit = Infinity) {
    const file = join(this.root, "sessions", safeId(id) + ".jsonl");
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const lines = raw.split("\n");
    const result: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        result.push(JSON.parse(lines[i]));
      } catch {
        if (i !== lines.length - 1) throw Error("JSONL 中间行损坏：" + file);
        this.logger.warn("忽略 JSONL 最后半行", { file });
      }
    }
    return result.slice(-limit);
  }
  appendEvent(line: any) {
    return this.serial(async () => {
      const file = join(this.root, "sessions", safeId(line.session) + ".jsonl");
      const index = await this.sessionIndex(),
        previous = indexSessionMeta(index, line.session);
      if (previous?.deleted) throw Error("会话已删除，请新建会话");
      let raw = "";
      try {
        raw = await readFile(file, "utf8");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      if (raw && !raw.endsWith("\n")) {
        try {
          JSON.parse(raw.slice(raw.lastIndexOf("\n") + 1));
          await appendFile(file, "\n");
        } catch {
          await atomic(file, raw.slice(0, raw.lastIndexOf("\n") + 1));
          this.logger.warn("修复 JSONL 尾部", { file });
        }
      }
      await appendFile(
        file,
        JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n",
      );
      index.sessions = {
        ...index.sessions,
        [line.session]: {
          ...previous,
          file: `sessions/${line.session}.jsonl`,
          updatedAt: new Date().toISOString(),
        },
      };
      await atomic(
        join(this.root, "index.json"),
        JSON.stringify(index, null, 2),
      );
      this.logger.info("记忆写入", { file, count: 1 });
    });
  }
  writeSummary(id: string, md: string) {
    return this.serial(() =>
      atomic(join(this.root, "summaries", safeId(id) + ".md"), md),
    );
  }
  async readSummary(id: string) {
    try {
      return await readFile(
        join(this.root, "summaries", safeId(id) + ".md"),
        "utf8",
      );
    } catch (e: any) {
      if (e.code === "ENOENT") return "";
      throw e;
    }
  }
  async status() {
    const files = await readdir(join(this.root, "sessions"));
    const stats = await Promise.all(
      files.map((f) => stat(join(this.root, "sessions", f))),
    );
    return {
      files: files.length,
      bytes: stats.reduce((n, s) => n + s.size, 0),
      updatedAt: new Date().toISOString(),
    };
  }
}
