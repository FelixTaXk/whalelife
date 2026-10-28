import {
  mkdir,
  readFile,
  appendFile,
  writeFile,
  rename,
  readdir,
  stat,
  lstat,
  unlink,
} from "node:fs/promises";
import { join, dirname, relative, resolve, sep, parse } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Windows readers can briefly hold a handle without delete sharing. Keep the
    // old file and the complete temp intact while retrying the atomic replace.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, file);
        break;
      } catch (error: any) {
        if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(error.code))
          throw error;
        await delay((attempt + 1) * 10);
      }
    }
  } finally {
    await unlink(temp).catch((error: any) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
async function directory(path: string) {
  const absolute = resolve(path),
    anchor = parse(absolute).root;
  let current = anchor;
  for (const part of relative(anchor, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw Error("记忆路径不能经过链接或普通文件");
  }
}
async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error: any) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function regularTree(folder: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name),
      info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
    )
      throw Error("记忆中不允许链接或特殊文件");
    if (info.isDirectory()) result.push(...(await regularTree(path)));
    else result.push(path);
  }
  return result;
}
export class Memory {
  root: string;
  logger: Logger;
  queue: Promise<any> = Promise.resolve();
  constructor(root: string, logger: Logger) {
    this.root = root;
    this.logger = logger;
  }
  sessionDir(id: string) {
    return join(this.root, "sessions", safeId(id));
  }
  async episodePaths(id: string) {
    const directory = join(this.sessionDir(id), "episodes");
    if (await exists(directory)) {
      const parent = await lstat(this.sessionDir(id));
      if (parent.isSymbolicLink() || !parent.isDirectory())
        throw Error("记忆目录不能为链接");
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw Error("记忆目录不能为链接");
      return (await readdir(directory))
        .filter(
          (name) =>
            /^\d{4}-\d{2}\.jsonl$/.test(name) || name === "legacy.jsonl",
        )
        .sort((a, b) =>
          a === "legacy.jsonl"
            ? -1
            : b === "legacy.jsonl"
              ? 1
              : a.localeCompare(b),
        )
        .map((name) => join(directory, name));
    }
    const legacy = join(this.root, "sessions", safeId(id) + ".jsonl");
    return (await exists(legacy)) ? [legacy] : [];
  }
  async summaryPath(id: string) {
    safeId(id);
    const index = await this.sessionIndex(),
      owner = index.summaryOwners?.[id];
    if (typeof owner === "string")
      return join(this.sessionDir(owner), "summaries", id + ".md");
    return join(this.root, "summaries", id + ".md");
  }
  async init() {
    for (const dir of ["sessions", "summaries", "personas"])
      await directory(join(this.root, dir));
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
    await this.migrate();
    this.logger.info("记忆就绪", { root: this.root });
  }
  // Startup/restore only, before requests can write. Every legacy source survives in a verified backup.
  async migrate() {
    const index = await this.sessionIndex();
    const legacy = (await readdir(join(this.root, "sessions"))).filter(
      (name) =>
        /^[a-zA-Z0-9_-]{1,100}\.jsonl$/.test(name) &&
        !indexSessionMeta(index, name.slice(0, -6))?.deleted,
    );
    if (legacy.length) {
      const files = await regularTree(this.root);
      const backup = join(
        dirname(resolve(this.root)),
        "backups",
        "memory-migration",
        randomUUID(),
      );
      if (resolve(backup).startsWith(resolve(this.root) + sep))
        throw Error("迁移备份不能放在记忆目录内");
      await directory(join(backup, "data"));
      const manifest: any[] = [];
      for (const file of files) {
        const path = relative(this.root, file),
          value = await readFile(file);
        const target = join(backup, "data", path);
        await directory(dirname(target));
        await writeFile(target, value, { flag: "wx" });
        const sha256 = createHash("sha256").update(value).digest("hex");
        if (
          createHash("sha256")
            .update(await readFile(target))
            .digest("hex") !== sha256
        )
          throw Error("迁移备份校验失败");
        manifest.push({
          path: path.split(sep).join("/"),
          bytes: value.length,
          sha256,
        });
      }
      await writeFile(
        join(backup, "manifest.json"),
        JSON.stringify(
          {
            version: 1,
            kind: "before-memory-v2",
            created_at: new Date().toISOString(),
            files: manifest,
          },
          null,
          2,
        ),
      );
      for (const name of legacy) {
        const id = name.slice(0, -6),
          source = join(this.root, "sessions", name);
        if (indexSessionMeta(index, id)?.deleted) continue;
        const folder = this.sessionDir(id),
          target = join(folder, "episodes", "legacy.jsonl");
        await directory(dirname(target));
        const raw = await readFile(source, "utf8");
        const rows: any[] = [];
        const lines = raw.split("\n");
        for (let n = 0; n < lines.length; n++) {
          if (!lines[n].trim()) continue;
          try {
            const row = JSON.parse(lines[n]);
            if (!row || typeof row !== "object" || Array.isArray(row))
              throw Error("无效记录");
            row.id ??=
              "legacy_" +
              createHash("sha256")
                .update(id + ":" + n + ":" + lines[n])
                .digest("hex")
                .slice(0, 32);
            rows.push(row);
          } catch {
            if (n !== lines.length - 1)
              throw Error("迁移中止：JSONL 中间行损坏，原件和备份均保留");
            this.logger.warn("迁移时忽略最后半行，原件保存在备份", { id });
          }
        }
        const content =
          rows.map((row) => JSON.stringify(row)).join("\n") +
          (rows.length ? "\n" : "");
        if (await exists(target)) {
          if ((await readFile(target, "utf8")) !== content)
            throw Error("迁移目标与旧档案不一致，未覆盖");
        } else await atomic(target, content);
        index.summaryOwners ??= {};
        const migratedSummaries = new Set<string>();
        for (const summary of [
          id,
          ...rows
            .map((row) => row.summary_id)
            .filter(
              (value) =>
                typeof value === "string" &&
                /^[a-zA-Z0-9_-]{1,100}$/.test(value),
            ),
          ...rows.flatMap((row) =>
            typeof row.persona_revision === "string"
              ? ["", ":session"].map(
                  (scope) =>
                    "p_" +
                    createHash("sha256")
                      .update(id + ":" + row.persona_revision + scope)
                      .digest("hex")
                      .slice(0, 40),
                )
              : [],
          ),
        ]) {
          const old = join(this.root, "summaries", summary + ".md");
          if (!(await exists(old))) continue;
          const dest = join(folder, "summaries", summary + ".md");
          await directory(dirname(dest));
          if (!(await exists(dest)))
            await atomic(dest, await readFile(old, "utf8"));
          index.summaryOwners = { ...index.summaryOwners, [summary]: id };
          migratedSummaries.add(old);
        }
        const meta = {
          ...indexSessionMeta(index, id),
          file: `sessions/${id}/episodes/legacy.jsonl`,
          format: 2,
        };
        index.sessions = { ...index.sessions, [id]: meta };
        await atomic(
          join(folder, "session.json"),
          JSON.stringify(meta, null, 2),
        );
        index.version = 2;
        await atomic(
          join(this.root, "index.json"),
          JSON.stringify(index, null, 2),
        );
        // Owner mapping is durable before removing legacy copies; interrupted migration can resume.
        for (const old of migratedSummaries) await unlink(old);
        await unlink(source);
      }
      this.logger.info("旧记忆迁移完成", { sessions: legacy.length, backup });
    }
    index.version = 2;
    await atomic(join(this.root, "index.json"), JSON.stringify(index, null, 2));
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
  // Includes deletion tombstones so channel bindings cannot silently resurrect them.
  async listSessionMeta() {
    return this.serial(async () => {
      const index = await this.sessionIndex();
      return Object.fromEntries(
        Object.keys(index.sessions).map((id) => [id, indexSessionMeta(index, id)]),
      );
    });
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
      await directory(this.sessionDir(id));
      await atomic(
        join(this.sessionDir(id), "session.json"),
        JSON.stringify(meta, null, 2),
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
    const result: any[] = [];
    for (const file of await this.episodePaths(id)) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw Error("记忆文件不能为链接");
      const lines = (await readFile(file, "utf8")).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          result.push(JSON.parse(lines[i]));
        } catch {
          if (i !== lines.length - 1) throw Error("JSONL 中间行损坏：" + file);
          this.logger.warn("忽略 JSONL 最后半行", { file });
        }
      }
    }
    return result.slice(-limit);
  }
  appendEvent(line: any) {
    return this.serial(async () => {
      const file = join(
        this.sessionDir(line.session),
        "episodes",
        new Date().toISOString().slice(0, 7) + ".jsonl",
      );
      const index = await this.sessionIndex(),
        previous = indexSessionMeta(index, line.session);
      if (previous?.deleted) throw Error("会话已删除，请新建会话");
      await directory(dirname(file));
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
        JSON.stringify({
          ts: new Date().toISOString(),
          ...line,
          id: line.id || randomUUID(),
        }) + "\n",
      );
      index.sessions = {
        ...index.sessions,
        [line.session]: {
          ...previous,
          file: relative(this.root, file).split(sep).join("/"),
          format: 2,
          updatedAt: new Date().toISOString(),
        },
      };
      await atomic(
        join(this.root, "index.json"),
        JSON.stringify(index, null, 2),
      );
      await atomic(
        join(this.sessionDir(line.session), "session.json"),
        JSON.stringify(index.sessions[line.session], null, 2),
      );
      this.logger.info("记忆写入", { file, count: 1 });
    });
  }
  writeSummary(id: string, md: string, sessionId?: string) {
    return this.serial(async () => {
      safeId(id);
      const index = await this.sessionIndex();
      const owner =
        sessionId ||
        index.summaryOwners?.[id] ||
        (indexSessionMeta(index, id) ? id : null);
      if (
        sessionId &&
        typeof index.summaryOwners?.[id] === "string" &&
        index.summaryOwners[id] !== sessionId
      )
        throw Error("摘要已属于其他会话，不能更改归属");
      let file = join(this.root, "summaries", id + ".md");
      if (owner) {
        if (indexSessionMeta(index, safeId(owner))?.deleted)
          throw Error("会话已删除");
        file = join(this.sessionDir(owner), "summaries", id + ".md");
        index.summaryOwners = { ...index.summaryOwners, [id]: owner };
        await atomic(
          join(this.root, "index.json"),
          JSON.stringify(index, null, 2),
        );
      }
      await directory(dirname(file));
      await atomic(file, md);
    });
  }
  async readSummary(id: string) {
    try {
      return await readFile(await this.summaryPath(id), "utf8");
    } catch (e: any) {
      if (e.code === "ENOENT") return "";
      throw e;
    }
  }
  async status() {
    const files = await regularTree(join(this.root, "sessions"));
    const stats = await Promise.all(files.map((f) => stat(f)));
    return {
      files: new Set(
        files.map((file) =>
          relative(join(this.root, "sessions"), file)
            .split(sep)[0]
            .replace(/\.jsonl$/, ""),
        ),
      ).size,
      bytes: stats.reduce((n, s) => n + s.size, 0),
      updatedAt: new Date().toISOString(),
    };
  }
}
