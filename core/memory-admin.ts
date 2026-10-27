import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Memory } from "./memory.ts";
import type { Logger } from "./logger.ts";

type SessionState = {
  root: string;
  locks: Set<string>;
  memoryMaintenance?: boolean;
  config?: { personas?: Record<string, { file?: string }> };
};
type FileEntry = {
  path: string;
  bytes: number;
  updated_at: string;
  mtime: number;
};
type StoredFile = { path: string; bytes: number; sha256: string };
type Manifest = {
  version: 1;
  id: string;
  created_at: string;
  kind: "manual" | "before-restore";
  files: StoredFile[];
  directories: string[];
  bytes: number;
  includes_personas: boolean;
};
export class MemoryAdminError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MemoryAdminError";
    this.status = status;
  }
}
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_FACT_BYTES = 32 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const BACKUP_ID = /^memory-\d{8}T\d{9}Z-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const inside = (base: string, target: string) => {
  const path = relative(resolve(base), resolve(target));
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path))
  );
};
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new MemoryAdminError("记忆记录 ID 无效");
  return value;
}
function page(offset = 0, limit = 100) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 10000000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new MemoryAdminError("offset 需为非负整数，limit 需为 1–200 的整数");
  return { offset, limit };
}
function searchText(value = "") {
  if (typeof value !== "string" || value.length > 200)
    throw new MemoryAdminError("搜索词不能超过 200 字");
  return value.trim().toLocaleLowerCase();
}
function relativeName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes(":")
  )
    throw new MemoryAdminError("记忆文件路径无效");
  if (
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\u0000-\u001f]/.test(part),
      )
  )
    throw new MemoryAdminError("记忆文件路径无效");
  return value;
}
async function directoryChain(path: string, create = false) {
  const absolute = resolve(path),
    anchor = parse(absolute).root;
  let current = anchor;
  for (const part of relative(anchor, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error: any) {
      if (!create || error.code !== "ENOENT") throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new MemoryAdminError(
        "记忆与备份路径不能经过符号链接、目录联接或普通文件",
      );
  }
}
async function regularFile(path: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
    throw new MemoryAdminError("记忆与备份中不允许符号链接、硬链接或特殊文件");
  return info;
}
async function boundedRead(path: string, maximum: number): Promise<Buffer> {
  const info = await regularFile(path);
  if (info.size > maximum)
    throw new MemoryAdminError("文件过大，请在本机查看该文件", 413);
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const current = await file.stat();
    if (
      !current.isFile() ||
      current.ino !== info.ino ||
      current.dev !== info.dev ||
      current.nlink !== 1
    )
      throw new MemoryAdminError("文件在读取期间发生变化，请重试", 409);
    const value = await file.readFile();
    if (value.length > maximum)
      throw new MemoryAdminError("文件过大，请在本机查看该文件", 413);
    return value;
  } finally {
    await file.close();
  }
}
async function inventory(root: string) {
  await directoryChain(root);
  const canonical = await realpath(root);
  const files: FileEntry[] = [],
    directories: string[] = [];
  async function visit(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name),
        path = relativeName(relative(root, full).split(sep).join("/"));
      const info = await lstat(full);
      if (info.isSymbolicLink())
        throw new MemoryAdminError("记忆与备份中不允许符号链接或目录联接");
      if (!inside(canonical, await realpath(full)))
        throw new MemoryAdminError("记忆路径越界");
      if (info.isDirectory()) {
        directories.push(path);
        await visit(full);
      } else if (info.isFile() && info.nlink === 1)
        files.push({
          path,
          bytes: info.size,
          updated_at: info.mtime.toISOString(),
          mtime: info.mtimeMs,
        });
      else throw new MemoryAdminError("记忆与备份中不允许硬链接或特殊文件");
      if (files.length + directories.length > 20000)
        throw new MemoryAdminError("记忆文件数量超过当前管理上限", 413);
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  directories.sort();
  return { files, directories };
}
function aggregate(files: FileEntry[]) {
  return {
    count: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    updated_at: files.length
      ? new Date(Math.max(...files.map((f) => f.mtime))).toISOString()
      : null,
  };
}
function factsCount(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#")).length;
}

export class MemoryAdmin {
  memory: Memory;
  sessions: SessionState;
  logger: Logger;
  root: string;
  projectRoot: string;
  backupRoot: string;
  constructor(memory: Memory, sessions: SessionState, logger: Logger) {
    this.memory = memory;
    this.sessions = sessions;
    this.logger = logger;
    this.root = resolve(memory.root);
    this.projectRoot = resolve(sessions.root);
    this.backupRoot = join(this.projectRoot, "backups", "memory");
    const config = join(this.projectRoot, "config");
    if (
      this.root === parse(this.root).root ||
      inside(this.root, this.projectRoot) ||
      inside(this.root, config) ||
      inside(config, this.root) ||
      inside(this.root, this.backupRoot) ||
      inside(this.backupRoot, this.root)
    )
      throw new MemoryAdminError("记忆根目录不能覆盖项目、配置或备份目录");
  }
  private async ensureRoots(backups = false) {
    await directoryChain(this.projectRoot);
    await directoryChain(this.root);
    if (backups) await directoryChain(this.backupRoot, true);
  }
  private async file(path: string) {
    relativeName(path);
    const target = join(this.root, ...path.split("/"));
    if (!inside(this.root, target)) throw new MemoryAdminError("记忆路径越界");
    await directoryChain(dirname(target));
    return target;
  }
  private async readFacts() {
    await this.ensureRoots();
    const file = await this.file("facts.md");
    const raw = await boundedRead(file, MAX_TEXT_BYTES),
      info = await regularFile(file),
      text = raw.toString("utf8");
    return {
      text,
      revision: digest(raw),
      count: factsCount(text),
      bytes: raw.length,
      updated_at: info.mtime.toISOString(),
    };
  }
  facts() {
    return this.memory.serial(() => this.readFacts());
  }
  saveFacts(input: { text: string; revision: string }) {
    return this.memory.serial(async () => {
      if (
        !input ||
        typeof input.text !== "string" ||
        typeof input.revision !== "string" ||
        !HASH.test(input.revision)
      )
        throw new MemoryAdminError("事实内容或 revision 无效");
      if (Buffer.byteLength(input.text, "utf8") > MAX_FACT_BYTES)
        throw new MemoryAdminError("事实文件不能超过 32 KiB", 413);
      const normalized = input.text
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n");
      if (/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/.test(normalized))
        throw new MemoryAdminError(
          "事实必须一行一条，不可含控制字符或隐藏换行",
        );
      const lines = normalized.split("\n").map((line) => line.trim());
      if (lines.some((line) => line.length > 2000))
        throw new MemoryAdminError("每行事实或注释不能超过 2000 字");
      if (factsCount(normalized) > 10000)
        throw new MemoryAdminError("事实条数不能超过 10000 条");
      const before = await this.readFacts();
      if (before.revision !== input.revision)
        throw new MemoryAdminError(
          "事实已被对话工具或其他编辑修改，请刷新后重试",
          409,
        );
      const content = lines.join("\n").replace(/\n*$/, "") + "\n";
      if (Buffer.byteLength(content, "utf8") > MAX_FACT_BYTES)
        throw new MemoryAdminError("事实文件不能超过 32 KiB", 413);
      const target = await this.file("facts.md"),
        temp = join(this.root, `.facts-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        if (
          digest(await boundedRead(target, MAX_TEXT_BYTES)) !== input.revision
        )
          throw new MemoryAdminError(
            "保存期间事实已被外部修改，请刷新后重试",
            409,
          );
        await rename(temp, target);
      } finally {
        await unlink(temp).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT")
            this.logger.warn("事实临时文件清理失败", { code: e.code });
        });
      }
      this.logger.info("共享事实已保存", { count: factsCount(content) });
      return this.readFacts();
    });
  }
  private async sessionRows(id: string) {
    const target = await this.file(`sessions/${identifier(id)}.jsonl`);
    let raw: Buffer;
    try {
      raw = await boundedRead(target, MAX_SESSION_BYTES);
    } catch (error: any) {
      if (error.code === "ENOENT")
        throw new MemoryAdminError("会话不存在", 404);
      throw error;
    }
    const info = await regularFile(target),
      lines = raw.toString("utf8").split("\n"),
      items: any[] = [],
      warnings: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      try {
        const value = JSON.parse(lines[index]);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error();
        items.push(value);
      } catch {
        warnings.push(
          index === lines.length - 1
            ? "已忽略最后一行未完成的记录"
            : `第 ${index + 1} 行记录损坏，已跳过`,
        );
      }
      if (warnings.length > 100) {
        warnings.push("损坏记录过多，已停止读取");
        break;
      }
    }
    return {
      items,
      warnings,
      bytes: raw.length,
      updated_at: info.mtime.toISOString(),
    };
  }
  catalog(options: { search?: string; offset?: number; limit?: number } = {}) {
    return this.memory.serial(async () => {
      await this.ensureRoots();
      const { offset, limit } = page(options.offset ?? 0, options.limit ?? 50),
        query = searchText(options.search);
      const { files } = await inventory(this.root),
        fact = await this.readFacts();
      const allSessions = files
        .filter((f) => /^sessions\/[a-zA-Z0-9_-]{1,100}\.jsonl$/.test(f.path))
        .sort((a, b) => b.mtime - a.mtime);
      const summaryFiles = files.filter(
        (f) =>
          f.bytes > 0 && /^summaries\/[a-zA-Z0-9_-]{1,100}\.md$/.test(f.path),
      );
      const matched: FileEntry[] = [];
      for (const entry of allSessions) {
        const id = basename(entry.path, ".jsonl");
        if (!query || id.toLocaleLowerCase().includes(query)) {
          matched.push(entry);
          continue;
        }
        const rows = await this.sessionRows(id);
        if (
          rows.items.some((row) =>
            JSON.stringify(row).toLocaleLowerCase().includes(query),
          )
        )
          matched.push(entry);
      }
      const total = aggregate(files);
      return {
        root: this.root,
        files: total.count,
        bytes: total.bytes,
        updated_at: total.updated_at,
        facts: {
          count: fact.count,
          bytes: fact.bytes,
          updated_at: fact.updated_at,
        },
        sessions: {
          ...aggregate(allSessions),
          total: matched.length,
          offset,
          limit,
          items: matched.slice(offset, offset + limit).map((f) => ({
            id: basename(f.path, ".jsonl"),
            bytes: f.bytes,
            updated_at: f.updated_at,
          })),
        },
        summaries: aggregate(summaryFiles),
        busy: this.sessions.locks.size > 0,
        restoring: this.sessions.memoryMaintenance === true,
      };
    });
  }
  session(id: string, offset = 0, limit = 100, search = "") {
    return this.memory.serial(async () => {
      await this.ensureRoots();
      const paging = page(offset, limit),
        query = searchText(search),
        rows = await this.sessionRows(id);
      const matched = query
        ? rows.items.filter((row) =>
            JSON.stringify(row).toLocaleLowerCase().includes(query),
          )
        : rows.items;
      return {
        id,
        items: matched.slice(offset, offset + limit),
        total: matched.length,
        ...paging,
        bytes: rows.bytes,
        updated_at: rows.updated_at,
        warnings: rows.warnings,
      };
    });
  }
  summaries() {
    return this.memory.serial(async () => {
      await this.ensureRoots();
      const { files } = await inventory(this.root);
      return {
        items: files
          .filter(
            (f) =>
              f.bytes > 0 &&
              /^summaries\/[a-zA-Z0-9_-]{1,100}\.md$/.test(f.path),
          )
          .sort((a, b) => b.mtime - a.mtime)
          .map((f) => ({
            id: basename(f.path, ".md"),
            bytes: f.bytes,
            updated_at: f.updated_at,
          })),
      };
    });
  }
  summary(id: string) {
    return this.memory.serial(async () => {
      await this.ensureRoots();
      const target = await this.file(`summaries/${identifier(id)}.md`);
      try {
        const raw = await boundedRead(target, MAX_TEXT_BYTES),
          info = await regularFile(target);
        return {
          id,
          text: raw.toString("utf8"),
          bytes: raw.length,
          updated_at: info.mtime.toISOString(),
        };
      } catch (error: any) {
        if (error.code === "ENOENT")
          throw new MemoryAdminError("摘要不存在", 404);
        throw error;
      }
    });
  }
  private async copyTree(source: string, target: string) {
    const tree = await inventory(source);
    await mkdir(target);
    for (const folder of tree.directories.sort(
      (a, b) => a.split("/").length - b.split("/").length,
    ))
      await mkdir(join(target, ...folder.split("/")));
    const files: StoredFile[] = [];
    for (const entry of tree.files) {
      const from = join(source, ...entry.path.split("/")),
        to = join(target, ...entry.path.split("/"));
      await directoryChain(dirname(from));
      const initial = await regularFile(from);
      if (initial.size !== entry.bytes || initial.mtimeMs !== entry.mtime)
        throw new MemoryAdminError("记忆目录在复制期间发生变化，请重试", 409);
      const input = await open(
        from,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let output;
      try {
        const before = await input.stat();
        if (
          before.ino !== initial.ino ||
          before.dev !== initial.dev ||
          before.nlink !== 1 ||
          !before.isFile()
        )
          throw new MemoryAdminError("备份源在复制期间发生变化，请重试", 409);
        output = await open(to, "wx", 0o600);
        const hash = createHash("sha256"),
          buffer = Buffer.alloc(128 * 1024);
        let bytes = 0;
        while (true) {
          const read = await input.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          const chunk = buffer.subarray(0, read.bytesRead);
          hash.update(chunk);
          await output.writeFile(chunk);
          bytes += read.bytesRead;
        }
        const after = await input.stat(),
          current = await regularFile(from);
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          current.ino !== initial.ino ||
          current.dev !== initial.dev ||
          bytes !== before.size
        )
          throw new MemoryAdminError("记忆文件在复制期间发生变化，请重试", 409);
        await output.sync();
        files.push({ path: entry.path, bytes, sha256: hash.digest("hex") });
      } finally {
        await input.close();
        await output?.close();
      }
      await utimes(to, initial.atime, initial.mtime);
    }
    const final = await inventory(source);
    if (
      JSON.stringify(final.files) !== JSON.stringify(tree.files) ||
      JSON.stringify(final.directories) !==
        JSON.stringify([...tree.directories].sort())
    )
      throw new MemoryAdminError("记忆目录在复制期间发生变化，请重试", 409);
    return { files, directories: tree.directories.sort() };
  }
  private info(manifest: Manifest) {
    return {
      id: manifest.id,
      created_at: manifest.created_at,
      kind: manifest.kind,
      files: manifest.files.length,
      bytes: manifest.bytes,
      includes_personas: manifest.includes_personas,
      valid: true,
    };
  }
  private async cleanup(folder: string, parent: string) {
    const target = resolve(folder),
      base = resolve(parent);
    if (
      target === base ||
      !inside(base, target) ||
      !basename(target).match(
        /^(\.pending-|\.whalelife-memory-(restore|rollback)-)/,
      )
    )
      throw new MemoryAdminError("临时目录清理路径无效");
    await directoryChain(base);
    await rm(target, { recursive: true, force: true });
  }
  private async createBackup(kind: Manifest["kind"]) {
    await this.ensureRoots(true);
    const id = `memory-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const folder = join(this.backupRoot, id),
      temp = join(this.backupRoot, `.pending-${randomUUID()}`);
    await mkdir(temp);
    try {
      const copied = await this.copyTree(this.root, join(temp, "data"));
      const manifest: Manifest = {
        version: 1,
        id,
        created_at: new Date().toISOString(),
        kind,
        ...copied,
        bytes: copied.files.reduce((sum, file) => sum + file.bytes, 0),
        includes_personas: copied.files.some((f) =>
          f.path.startsWith("personas/"),
        ),
      };
      await writeFile(
        join(temp, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      await rename(temp, folder);
      this.logger.info("记忆备份完成", {
        id,
        files: manifest.files.length,
        bytes: manifest.bytes,
        kind,
      });
      return this.info(manifest);
    } finally {
      await this.cleanup(temp, this.backupRoot).catch((error) =>
        this.logger.warn("备份临时目录清理失败", { error }),
      );
    }
  }
  backup() {
    return this.memory.serial(() => this.createBackup("manual"));
  }
  private async manifest(id: string) {
    if (typeof id !== "string" || !BACKUP_ID.test(id))
      throw new MemoryAdminError("备份 ID 无效");
    const folder = join(this.backupRoot, id);
    await directoryChain(folder);
    let value: any;
    try {
      value = JSON.parse(
        (
          await boundedRead(join(folder, "manifest.json"), MAX_MANIFEST_BYTES)
        ).toString("utf8"),
      );
    } catch (error) {
      if (error instanceof MemoryAdminError) throw error;
      throw new MemoryAdminError("备份清单损坏或缺失");
    }
    if (
      value?.version !== 1 ||
      value.id !== id ||
      !Array.isArray(value.files) ||
      !Array.isArray(value.directories) ||
      typeof value.created_at !== "string" ||
      !Number.isFinite(Date.parse(value.created_at)) ||
      !["manual", "before-restore"].includes(value.kind) ||
      value.files.length + value.directories.length > 20000
    )
      throw new MemoryAdminError("备份清单格式无效");
    const seen = new Set<string>();
    for (const file of value.files) {
      const path = relativeName(file.path);
      if (
        seen.has(path) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !HASH.test(file.sha256)
      )
        throw new MemoryAdminError("备份文件清单无效");
      seen.add(path);
    }
    const directories = new Set<string>();
    for (const directory of value.directories) {
      relativeName(directory);
      if (directories.has(directory) || seen.has(directory))
        throw new MemoryAdminError("备份目录清单无效");
      directories.add(directory);
    }
    if (
      value.bytes !==
      value.files.reduce((sum: number, file: StoredFile) => sum + file.bytes, 0)
    )
      throw new MemoryAdminError("备份大小校验失败");
    value.includes_personas = value.files.some((f: StoredFile) =>
      f.path.startsWith("personas/"),
    );
    return value as Manifest;
  }
  backups() {
    return this.memory.serial(async () => {
      await this.ensureRoots(true);
      const items: any[] = [];
      for (const entry of await readdir(this.backupRoot, {
        withFileTypes: true,
      })) {
        if (!BACKUP_ID.test(entry.name)) continue;
        try {
          items.push(this.info(await this.manifest(entry.name)));
        } catch (error: any) {
          items.push({
            id: entry.name,
            valid: false,
            error:
              error instanceof MemoryAdminError
                ? error.message
                : "备份无法读取",
          });
        }
      }
      return {
        directory: this.backupRoot,
        items: items.sort((a, b) => b.id.localeCompare(a.id)),
      };
    });
  }
  restore(input: { id: string }) {
    if (this.sessions.memoryMaintenance)
      return Promise.reject(
        new MemoryAdminError("记忆恢复正在进行，请稍后重试", 409),
      );
    if (this.sessions.locks.size)
      return Promise.reject(
        new MemoryAdminError("对话正在进行，请等待回复完成后再恢复记忆", 409),
      );
    this.sessions.memoryMaintenance = true;
    let recoveryRequired = false;
    return this.memory
      .serial(async () => {
        if (this.sessions.locks.size)
          throw new MemoryAdminError(
            "对话正在进行，请等待回复完成后再恢复记忆",
            409,
          );
        await this.ensureRoots(true);
        const manifest = await this.manifest(input?.id);
        const stage = join(
            dirname(this.root),
            `.whalelife-memory-restore-${randomUUID()}`,
          ),
          rollback = join(
            dirname(this.root),
            `.whalelife-memory-rollback-${randomUUID()}`,
          );
        let moved = false,
          installed = false;
        try {
          const copied = await this.copyTree(
            join(this.backupRoot, manifest.id, "data"),
            stage,
          );
          const fingerprint = (files: StoredFile[]) =>
            JSON.stringify(
              [...files].sort((a, b) => a.path.localeCompare(b.path)),
            );
          if (
            fingerprint(copied.files) !== fingerprint(manifest.files) ||
            JSON.stringify([...copied.directories].sort()) !==
              JSON.stringify([...manifest.directories].sort())
          )
            throw new MemoryAdminError("备份内容校验失败，当前记忆未改变");
          for (const persona of Object.values(
            this.sessions.config?.personas ?? {},
          )) {
            if (typeof persona?.file !== "string") continue;
            const current = resolve(this.projectRoot, persona.file);
            if (!inside(this.root, current)) continue;
            const restored = resolve(stage, relative(this.root, current));
            try {
              await directoryChain(dirname(restored));
              await regularFile(restored);
            } catch {
              throw new MemoryAdminError(
                "此备份缺少当前配置使用的人格文件，无法恢复",
                409,
              );
            }
          }
          const safety = await this.createBackup("before-restore");
          await rename(this.root, rollback);
          moved = true;
          try {
            await rename(stage, this.root);
            installed = true;
          } catch (error) {
            try {
              await rename(rollback, this.root);
              moved = false;
            } catch (rollbackError) {
              recoveryRequired = true;
              this.logger.error("记忆恢复回滚失败，保留原目录", {
                rollback,
                rollbackError,
              });
              throw new MemoryAdminError(
                "恢复及回滚未完成，原记忆目录已保留，请查看日志进行人工恢复",
                500,
              );
            }
            throw error;
          }
          this.logger.info("记忆恢复完成", {
            id: manifest.id,
            safety_backup: safety.id,
            personas_restored: manifest.includes_personas,
          });
          return {
            ok: true,
            restored_from: manifest.id,
            safety_backup: safety,
            personas_restored: manifest.includes_personas,
          };
        } finally {
          if (!recoveryRequired)
            await this.cleanup(stage, dirname(this.root)).catch((error) =>
              this.logger.warn("恢复临时目录清理失败", { error }),
            );
          if (moved && installed)
            await this.cleanup(rollback, dirname(this.root)).catch((error) =>
              this.logger.warn("旧记忆临时目录清理失败，自动备份仍保留", {
                error,
              }),
            );
        }
      })
      .finally(() => {
        if (!recoveryRequired) this.sessions.memoryMaintenance = false;
      });
  }
}
