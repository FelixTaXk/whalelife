/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
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
import {
  indexSessionMeta,
  parseSessionIndex,
  atomic,
  Memory,
  type SessionIndex,
} from "./memory.ts";
import type { Logger } from "./logger.ts";
import { MemoryEngine, validateMemoryState } from "./memory-engine.ts";
import { diaryContext, type DiaryContext, type DiaryEntry } from "./memory-diary.ts";
import { contextPolicy, matchingHistory, memoryWindow } from "./session-context.ts";
import { persona } from "./persona.ts";

type SessionState = {
  root: string;
  locks: Set<string>;
  memoryMaintenance?: boolean;
  blockedSessions?: Set<string>;
  channelOperations?: Map<string, number>;
  config?: { personas?: Record<string, { file?: string }>; memory?: Record<string, any>;
    channels?: { web?: { persona?: string } } };
};
type FileEntry = {
  path: string;
  bytes: number;
  updated_at: string;
  mtime: number;
};
type StoredFile = { path: string; bytes: number; sha256: string };
type SummaryView = {
  id: string;
  text: string;
  bytes: number;
  chars: number;
  updated_at: string | null;
  session_id: string | null;
  session_name: string | null;
  mode: string;
  status: string;
  available: boolean;
  status_message: string;
  last_error?: string;
  retry_at?: number;
  diary_id?: string;
  version?: number;
  created_at?: string;
  scope?: string;
  source_ids?: string[];
  source_revision?: string;
  covered_messages?: number;
  time_range?: DiaryEntry["time_range"];
  model?: string;
};
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
const diaryViewId = (owner: string, id: string) => "d_" + digest(owner + ":" + id).slice(0, 40);
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
const summaryFile = (path: string) =>
  /^(?:sessions\/[a-zA-Z0-9_-]{1,100}\/)?summaries\/[a-zA-Z0-9_-]{1,100}\.md$/.test(
    path,
  );
function sessionEntries(files: FileEntry[], index: SessionIndex) {
  const groups = new Map<string, FileEntry[]>();
  for (const file of files) {
    const id = file.path.match(
      /^sessions\/([a-zA-Z0-9_-]{1,100})(?:\.jsonl$|\/)/,
    )?.[1];
    if (!id || indexSessionMeta(index, id)?.deleted) continue;
    groups.set(id, [...(groups.get(id) || []), file]);
  }
  return [...groups]
    .map(([id, group]) => ({
      path: `sessions/${id}.jsonl`,
      bytes: group.reduce((sum, file) => sum + file.bytes, 0),
      mtime: Math.max(...group.map((file) => file.mtime)),
      updated_at: new Date(
        Math.max(...group.map((file) => file.mtime)),
      ).toISOString(),
    }))
    .sort((a, b) => b.mtime - a.mtime);
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
    this.sessions.blockedSessions ??= new Set<string>();
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
  private async sessionIndex() {
    const raw = await boundedRead(
      await this.file("index.json"),
      MAX_MANIFEST_BYTES,
    );
    return {
      raw,
      index: parseSessionIndex(raw.toString("utf8")),
      revision: digest(raw),
    };
  }
  private async writeSessionIndex(index: SessionIndex, revision: string) {
    const target = await this.file("index.json"),
      temp = join(this.root, `.index-${randomUUID()}.tmp`);
    const content = JSON.stringify(index, null, 2) + "\n";
    try {
      await writeFile(temp, content, { flag: "wx", mode: 0o600 });
      if (digest(await boundedRead(target, MAX_MANIFEST_BYTES)) !== revision)
        throw new MemoryAdminError("会话索引已被外部修改，请刷新后重试", 409);
      await rename(temp, target);
      return digest(content);
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT")
          this.logger.warn("会话索引临时文件清理失败", { code: error.code });
      });
    }
  }
  renameSession(input: { id: string; name: string }) {
    return this.memory.serial(async () => {
      const id = identifier(input?.id);
      if (
        typeof input.name !== "string" ||
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(input.name)
      )
        throw new MemoryAdminError("会话名称须为 1–80 字的单行文本");
      const name = input.name.trim();
      if (!name || [...name].length > 80 || Buffer.byteLength(name) > 320)
        throw new MemoryAdminError("会话名称须为 1–80 字的单行文本");
      if (
        this.sessions.memoryMaintenance ||
        this.sessions.blockedSessions?.has(id)
      )
        throw new MemoryAdminError("会话或记忆正在维护，请稍后重试", 409);
      await this.ensureRoots();
      const { index, revision } = await this.sessionIndex(),
        previous = indexSessionMeta(index, id);
      if (previous?.deleted)
        throw new MemoryAdminError("会话已删除，请新建会话", 409);
      try {
        const paths = await this.memory.episodePaths(id);
        await regularFile(
          await this.file(
            paths.length
              ? relative(this.root, paths[0]).split(sep).join("/")
              : `sessions/${id}/session.json`,
          ),
        );
      } catch (error: any) {
        if (error.code === "ENOENT")
          throw new MemoryAdminError("会话不存在", 404);
        throw error;
      }
      index.sessions = { ...index.sessions, [id]: { ...previous, name } };
      await this.writeSessionIndex(index, revision);
      const folder = this.memory.sessionDir(id);
      await directoryChain(folder, true);
      await atomic(
        join(folder, "session.json"),
        JSON.stringify(index.sessions[id], null, 2),
      );
      this.logger.info("会话已改名", { id });
      return { id, name };
    });
  }
  async deleteSession(input: { id: string }) {
    const id = identifier(input?.id),
      blocked = this.sessions.blockedSessions!;
    if (this.sessions.memoryMaintenance || blocked.has(id))
      throw new MemoryAdminError("会话或记忆正在维护，请稍后重试", 409);
    if (this.sessions.locks.has(id) || this.sessions.channelOperations?.has(id))
      throw new MemoryAdminError("该会话正在回复，请稍候再删除", 409);
    blocked.add(id);
    return this.memory
      .serial(async () => {
        if (this.sessions.memoryMaintenance || this.sessions.locks.has(id) || this.sessions.channelOperations?.has(id))
          throw new MemoryAdminError(
            "该会话正在回复或记忆正在恢复，请稍候再删除",
            409,
          );
        await this.ensureRoots();
        const state = await this.sessionIndex(),
          previous = indexSessionMeta(state.index, id);
        if (previous?.deleted)
          return {
            id,
            deleted: true,
            deleted_at: previous.deleted_at,
            trash_id: previous.trash_id,
            files: previous.deleted_files ?? 0,
          };
        const tree = await inventory(this.root);
        const ownFiles = tree.files.filter(
          (file) =>
            file.path === `sessions/${id}.jsonl` ||
            file.path.startsWith(`sessions/${id}/`),
        );
        if (!ownFiles.length) throw new MemoryAdminError("会话不存在", 404);
        const sessionPath =
          ownFiles.find((file) => file.path.endsWith(".jsonl"))?.path ||
          ownFiles[0].path;
        let raw: Buffer;
        try {
          raw = await boundedRead(
            await this.file(sessionPath),
            MAX_SESSION_BYTES,
          );
        } catch (error: any) {
          if (error.code === "ENOENT")
            throw new MemoryAdminError("会话不存在", 404);
          throw error;
        }
        const paths = new Set<string>([
          ...ownFiles.map((file) => file.path),
          `summaries/${id}.md`,
        ]);
        const episodeRaw = (
          await Promise.all(
            ownFiles
              .filter((file) => file.path.endsWith(".jsonl"))
              .map(async (file) =>
                (
                  await boundedRead(
                    await this.file(file.path),
                    MAX_SESSION_BYTES,
                  )
                ).toString("utf8"),
              ),
          )
        ).join("\n");
        for (const line of episodeRaw.split("\n")) {
          try {
            const record = JSON.parse(line);
            if (
              typeof record?.summary_id === "string" &&
              /^p_[a-f0-9]{40}$/.test(record.summary_id)
            )
              paths.add(`summaries/${record.summary_id}.md`);
            if (typeof record?.persona_revision === "string")
              paths.add(
                `summaries/p_${createHash("sha256")
                  .update(id + ":" + record.persona_revision)
                  .digest("hex")
                  .slice(0, 40)}.md`,
              );
          } catch {
            /* Keep malformed records verbatim in the trash copy. */
          }
        }
        const trashId = `session-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const trashRoot = join(this.root, "trash"),
          trash = join(trashRoot, trashId);
        await directoryChain(trashRoot, true);
        await mkdir(trash);
        await mkdir(join(trash, "sessions"));
        await mkdir(join(trash, "summaries"));
        const files: StoredFile[] = [];
        for (const path of paths) {
          let content: Buffer;
          try {
            content = await boundedRead(
              await this.file(path),
              MAX_SESSION_BYTES,
            );
          } catch (error: any) {
            if (error.code === "ENOENT" && path !== sessionPath) continue;
            throw error;
          }
          if (path === sessionPath && digest(content) !== digest(raw))
            throw new MemoryAdminError(
              "会话文件在删除期间被外部修改，请重试",
              409,
            );
          await directoryChain(dirname(join(trash, ...path.split("/"))), true);
          await writeFile(join(trash, ...path.split("/")), content, {
            flag: "wx",
            mode: 0o600,
          });
          files.push({ path, bytes: content.length, sha256: digest(content) });
        }
        const deletedAt = new Date().toISOString();
        await writeFile(
          join(trash, "manifest.json"),
          JSON.stringify(
            {
              version: 1,
              kind: "session-delete",
              id: trashId,
              session_id: id,
              deleted_at: deletedAt,
              metadata: previous,
              files,
            },
            null,
            2,
          ) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        const tombstone = {
          ...previous,
          deleted: true,
          deleted_at: deletedAt,
          trash_id: trashId,
          deleted_files: files.length,
        };
        const originalIndex = parseSessionIndex(state.raw.toString("utf8"));
        state.index.sessions = { ...state.index.sessions, [id]: tombstone };
        // Persist the tombstone first: even a process crash must not let old tabs recreate this ID.
        const tombstoneRevision = await this.writeSessionIndex(
          state.index,
          state.revision,
        );
        const removed: StoredFile[] = [];
        try {
          for (const file of files) {
            const target = await this.file(file.path);
            if (
              digest(await boundedRead(target, MAX_SESSION_BYTES)) !==
              file.sha256
            )
              throw new MemoryAdminError(
                "会话文件在删除期间被外部修改，请重试",
                409,
              );
            await unlink(target);
            removed.push(file);
          }
        } catch (error) {
          try {
            for (const file of removed) {
              const target = await this.file(file.path),
                content = await boundedRead(
                  join(trash, ...file.path.split("/")),
                  MAX_SESSION_BYTES,
                );
              if (digest(content) !== file.sha256)
                throw Error("垃圾箱副本校验失败");
              await writeFile(target, content, { flag: "wx", mode: 0o600 });
            }
            await this.writeSessionIndex(originalIndex, tombstoneRevision);
          } catch {
            this.logger.error("会话删除回滚未完成，副本已保留", {
              id,
              trash_id: trashId,
            });
            throw new MemoryAdminError(
              "会话删除未完成，原文件副本已保留在记忆垃圾箱，请从副本恢复",
              500,
            );
          }
          throw error;
        }
        this.logger.info("会话已移入记忆垃圾箱", {
          id,
          trash_id: trashId,
          files: files.length,
        });
        return {
          id,
          deleted: true,
          deleted_at: deletedAt,
          trash_id: trashId,
          files: files.length,
        };
      })
      .finally(() => blocked.delete(id));
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
    identifier(id);
    const paths = await this.memory.episodePaths(id),
      items: any[] = [],
      warnings: string[] = [];
    let bytes = 0,
      mtime = 0;
    if (!paths.length) {
      try {
        mtime = (
          await regularFile(await this.file(`sessions/${id}/session.json`))
        ).mtimeMs;
      } catch (error: any) {
        if (error.code === "ENOENT")
          throw new MemoryAdminError("会话不存在", 404);
        throw error;
      }
    }
    for (const path of paths) {
      const target = await this.file(
        relative(this.root, path).split(sep).join("/"),
      );
      const raw = await boundedRead(target, MAX_SESSION_BYTES),
        info = await regularFile(target),
        lines = raw.toString("utf8").split("\n");
      bytes += raw.length;
      mtime = Math.max(mtime, info.mtimeMs);
      if (bytes > MAX_SESSION_BYTES)
        throw new MemoryAdminError("会话过大，请在本机查看", 413);
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
    }
    return {
      items,
      warnings,
      bytes,
      updated_at: new Date(mtime).toISOString(),
    };
  }
  catalog(options: { search?: string; offset?: number; limit?: number } = {}) {
    return this.memory.serial(async () => {
      await this.ensureRoots();
      const { offset, limit } = page(options.offset ?? 0, options.limit ?? 50),
        query = searchText(options.search);
      const { files } = await inventory(this.root),
        fact = await this.readFacts();
      const { index } = await this.sessionIndex();
      const allSessions = sessionEntries(files, index);
      const summaryFiles = files.filter(
        (f) =>
          f.bytes > 0 &&
          summaryFile(f.path) &&
          !(
            f.path.startsWith("summaries/") &&
            index.summaryOwners?.[basename(f.path, ".md")]
          ),
      );
      const diaryFiles: FileEntry[] = [], engine = new MemoryEngine(this.memory);
      for (const [owner, meta] of Object.entries<any>(index.sessions)) {
        if (meta.deleted) continue;
        for (const diary of (await engine.state(owner)).diaries ?? [])
          diaryFiles.push({ path: diaryViewId(owner, diary.id), bytes: Buffer.byteLength(diary.text),
            updated_at: diary.created_at, mtime: Date.parse(diary.created_at) });
      }
      const matched: FileEntry[] = [];
      for (const entry of allSessions) {
        const id = basename(entry.path, ".jsonl");
        const name = indexSessionMeta(index, id)?.name;
        if (
          !query ||
          id.toLocaleLowerCase().includes(query) ||
          (typeof name === "string" && name.toLocaleLowerCase().includes(query))
        ) {
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
      const items = await Promise.all(
        matched.slice(offset, offset + limit).map(async (f) => {
          const id = basename(f.path, ".jsonl"),
            meta = indexSessionMeta(index, id);
          let last: any;
          try {
            const rows = await this.sessionRows(id);
            last = rows.items.findLast(
              (row: any) =>
                row.type === "message" &&
                (typeof row.persona_id === "string" ||
                  typeof row.persona_name === "string"),
            );
          } catch (error) {
            this.logger.warn("读取会话人格失败", { id, error });
          }
          return {
            id,
            name: typeof meta?.name === "string" ? meta.name : null,
            last_persona: last
              ? {
                  id:
                    typeof last.persona_id === "string"
                      ? last.persona_id
                      : null,
                  name:
                    typeof last.persona_name === "string"
                      ? last.persona_name
                      : last.persona_id,
                }
              : null,
            bytes: f.bytes,
            updated_at: f.updated_at,
          };
        }),
      );
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
          items,
        },
        summaries: aggregate([...summaryFiles, ...diaryFiles]),
        busy: this.sessions.locks.size > 0 || !!this.sessions.channelOperations?.size,
        restoring: this.sessions.memoryMaintenance === true,
      };
    });
  }
  session(id: string, offset = 0, limit = 100, search = "") {
    return this.memory.serial(async () => {
      await this.ensureRoots();
      const { index } = await this.sessionIndex(),
        meta = indexSessionMeta(index, identifier(id));
      if (meta?.deleted)
        throw new MemoryAdminError("会话已删除，请新建会话", 410);
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
        name: typeof meta?.name === "string" ? meta.name : null,
        items: matched.slice(offset, offset + limit),
        total: matched.length,
        ...paging,
        bytes: rows.bytes,
        updated_at: rows.updated_at,
        warnings: rows.warnings,
      };
    });
  }
  private async summaryViews(wanted?: string) {
    await this.ensureRoots();
    const { files } = await inventory(this.root), { index } = await this.sessionIndex();
    const engine = new MemoryEngine(this.memory);
    const entries = new Map<string, { owner?: string; file?: FileEntry; checkpoint?: any; stateFile?: FileEntry; diary?: DiaryEntry }>();
    for (const file of files) {
      const id = basename(file.path, ".md"), owner = file.path.startsWith("sessions/")
        ? file.path.split("/")[1] : index.summaryOwners?.[id];
      if ((wanted && id !== wanted) || !file.bytes || !summaryFile(file.path) ||
          (file.path.startsWith("summaries/") && owner) || (owner && indexSessionMeta(index, owner)?.deleted)) continue;
      entries.set(id, { owner, file });
    }
    // Checkpoints are authoritative, including empty failures or a missing projection file.
    for (const [owner, meta] of Object.entries<any>(index.sessions)) {
      if (meta.deleted) continue;
      const state = await engine.state(owner);
      for (const id of Object.keys(state.summaries)) {
        if (wanted && id !== wanted) continue;
        const existing = entries.get(id);
        if (existing?.owner && existing.owner !== owner) throw new MemoryAdminError("摘要归属冲突，请检查记忆索引");
        entries.set(id, { ...existing, owner, checkpoint: await engine.summaryState(owner, id),
          stateFile: files.find(file => file.path === `sessions/${owner}/knowledge/state.json`) });
      }
      for (const diary of state.diaries ?? []) {
        const id = diaryViewId(owner, diary.id);
        if (wanted && id !== wanted) continue;
        if (entries.has(id)) throw new MemoryAdminError("日记归属冲突，请检查记忆索引");
        entries.set(id, { owner, diary });
      }
    }
    const views: SummaryView[] = [];
    const windows = new Map<string, any[]>();
    const diaries = new Map<string, DiaryContext>();
    let selectedRevision: string | undefined;
    const personaId = this.sessions.config?.channels?.web?.persona;
    if (personaId && [...entries.values()].some(entry => entry.owner &&
        contextPolicy(this.sessions.config?.memory ?? {}, indexSessionMeta(index, entry.owner)?.context).history_scope === "persona")) {
      // Match contextStatus without fetching model limits or making a provider request.
      try { selectedRevision = (await persona(this.projectRoot, this.sessions.config, personaId)).revision; }
      catch { /* Historical summaries remain inspectable when current configuration is incomplete. */ }
    }
    for (const [id, entry] of entries) {
      const { owner, checkpoint, file, stateFile } = entry;
      const meta = owner ? indexSessionMeta(index, owner) : null;
      const policy = contextPolicy(this.sessions.config?.memory ?? {}, meta?.context);
      if (entry.diary) {
        const diary = entry.diary, scope = policy.history_scope === "session" ? "session" :
          selectedRevision ? "persona:" + selectedRevision : undefined;
        const currentScope = diary.scope === scope;
        let status = "other_scope", available = false;
        let statusMessage = "其他历史或人格范围的日记，保留供查看，不带入当前范围。";
        if (currentScope) {
          if (!diaries.has(owner!)) diaries.set(owner!, await diaryContext(engine, owner!, scope!,
            matchingHistory(await engine.contextRows(owner!), selectedRevision ?? "", policy.history_scope)));
          const valid = diaries.get(owner!)!.entries.some(value => value.id === diary.id);
          status = valid ? "ready" : "needs_rebuild";
          available = valid && policy.memory_mode !== "legacy" && policy.history_enabled;
          statusMessage = !valid ? "来源已被排除或发生变化，当前不带入；旧日记保留供核对，需从有效原文重建。" :
            available ? "日记来源有效，按当前范围带入上下文；自动生成开关只控制后续新日记。" :
              policy.memory_mode === "legacy" ? "旧版兼容设置不使用日记，已保存内容保留供查看。" :
                "日记来源有效；带入历史已关闭，当前不带入上下文。";
          if (valid && policy.memory_mode === "legacy") status = "archived";
        }
        views.push({ id, diary_id: diary.id, version: diary.version, text: diary.text,
          bytes: Buffer.byteLength(diary.text), chars: Array.from(diary.text).length,
          updated_at: diary.created_at, created_at: diary.created_at,
          session_id: owner!, session_name: meta?.name ?? owner!, mode: "diary", scope: diary.scope,
          source_ids: [...diary.source_ids], source_revision: diary.source_revision,
          covered_messages: diary.source_ids.length, time_range: { ...diary.time_range },
          ...(diary.model ? { model: diary.model } : {}), status, available, status_message: statusMessage });
        continue;
      }
      const mode = checkpoint?.mode ?? (id.startsWith("s_") ? "short" : "long");
      const text = checkpoint !== undefined ? (typeof checkpoint.text === "string" ? checkpoint.text : "")
        : (await boundedRead(await this.file(file!.path), MAX_TEXT_BYTES)).toString("utf8");
      const failed = !!checkpoint && (typeof checkpoint.last_error === "string" || !!checkpoint.retry_at);
      const scope = policy.history_scope === "session" ? "session" : selectedRevision;
      const sessionKey = owner && scope ? digest(owner + ":" + scope).slice(0, 40) : "";
      const currentScope = !!owner && !!scope && id === (mode === "short" ? "s_" : "p_") + sessionKey;
      let available = !!text, status = checkpoint === undefined ? "legacy" : "ready";
      let statusMessage = checkpoint === undefined ? "旧版摘要，缺少范围检查点；保留供查看。" : "已有可用正文；是否带入对话仍受历史开关和上下文预算控制。";
      if (checkpoint !== undefined && !currentScope) {
        available = false; status = "other_scope";
        statusMessage = "其他历史或人格范围的摘要，不代表当前会话范围正在使用的内容。";
      } else if (checkpoint !== undefined) {
        if (mode === "short") {
          if (!windows.has(owner!)) windows.set(owner!, memoryWindow(
            matchingHistory(await engine.contextRows(owner!), selectedRevision ?? "", policy.history_scope), policy).short);
          const rows = windows.get(owner!)!;
          available = !!text && checkpoint.mode === "short" && checkpoint.start_id === rows[0]?.id &&
            rows.some(row => row.id === checkpoint.last_id);
        }
        if (failed) {
          status = available ? "update_failed" : "failed";
          statusMessage = available ? "上次更新失败，当前继续使用上次有效正文。" : "上次整理失败，当前没有可用摘要；保留的旧正文仅供查看。";
        } else if (!available) {
          status = text ? "needs_rebuild" : "pending";
          statusMessage = text ? "覆盖范围已变化，需要重建；以下旧正文不会作为当前短期摘要带入。" : "尚无有效正文，等待满足条件后整理。";
        }
      }
      if (policy.memory_mode !== "legacy") {
        available = false; status = "legacy";
        statusMessage = "旧版摘要，保留供查看；当前记忆机制不带入此内容。";
      }
      views.push({ id, text, bytes: Buffer.byteLength(text), chars: Array.from(text).length,
        updated_at: checkpoint?.updated_at ?? file?.updated_at ?? stateFile?.updated_at ?? null,
        session_id: owner ?? null, session_name: meta?.name ?? owner ?? null, mode, status,
        available, status_message: statusMessage,
        ...(typeof checkpoint?.last_error === "string" ? { last_error: checkpoint.last_error.slice(0, 200) } : {}),
        ...(Number.isFinite(checkpoint?.retry_at) ? { retry_at: checkpoint.retry_at } : {}),
      });
    }
    return views.sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""));
  }
  summaries() {
    return this.memory.serial(async () => ({ items: (await this.summaryViews()).map(({ text: _text, ...item }) => item) }));
  }
  summary(id: string) {
    return this.memory.serial(async () => {
      const item = (await this.summaryViews(identifier(id)))[0];
      if (!item) throw new MemoryAdminError("摘要不存在", 404);
      return item;
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
  private async channelSnapshot(memory: Memory, index: SessionIndex) {
    const object = (value: any) => !!value && typeof value === "object" && !Array.isArray(value);
    const label = (value: any) => typeof value === "string" && value.trim() && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
    if (index.channel_routes !== undefined && !object(index.channel_routes))
      throw new MemoryAdminError("渠道回执索引损坏，不能安全恢复记忆");
    const routes: Record<string, any> = structuredClone(index.channel_routes ?? {});
    const bindings = new Map<string, { id: string; binding: any; meta: any }>();
    for (const id of Object.keys(index.sessions)) {
      const meta = indexSessionMeta(index, id);
      if (meta?.channel_bindings !== undefined && !object(meta.channel_bindings))
        throw new MemoryAdminError("渠道绑定索引损坏，不能安全恢复记忆");
      for (const [key, binding] of Object.entries<any>(meta?.channel_bindings ?? {})) {
        if (!object(binding) || !/^[a-z][a-z0-9-]{0,39}$/.test(binding.channel) ||
            !label(binding.account) || !label(binding.peer) || !label(binding.owner) ||
            key !== digest(JSON.stringify([binding.channel, binding.account, binding.peer])) || bindings.has(key))
          throw new MemoryAdminError("渠道绑定冲突或损坏，不能安全恢复记忆");
        bindings.set(key, { id, binding, meta });
        if (!Object.hasOwn(routes, key)) {
          const receipts: Record<string, any> = {};
          if (!meta.deleted) for (const receipt of await memory.readSession(id)) {
            if (receipt.type === "channel_receipt" && receipt.channel_key === key)
              receipts[digest(JSON.stringify([receipt.external_message_id, receipt.direction]))] = { sessionId: id, receipt };
          }
          routes[key] = { ...binding, sessionId: id, receipts, ...(meta.deleted ? { receiptHistoryIncomplete: true } : {}) };
        }
      }
    }
    for (const [key, route] of Object.entries(routes)) {
      const found = bindings.get(key);
      if (!object(route) || !found || route.sessionId !== found.id ||
          ["channel", "account", "peer", "owner"].some((name) => route[name] !== found.binding[name]) ||
          !object(route.receipts) || (route.receiptHistoryIncomplete !== undefined && typeof route.receiptHistoryIncomplete !== "boolean"))
        throw new MemoryAdminError("渠道绑定与回执索引冲突，不能安全恢复记忆");
      identifier(route.sessionId);
      for (const [messageKey, stored] of Object.entries<any>(route.receipts)) {
        const receipt = stored?.receipt;
        if (!object(stored) || !object(receipt) || receipt.type !== "channel_receipt" || receipt.channel_key !== key ||
            !label(receipt.external_message_id) || !["in", "out"].includes(receipt.direction) ||
            !HASH.test(receipt.fingerprint) || messageKey !== digest(JSON.stringify([receipt.external_message_id, receipt.direction])) ||
            !["pending", "delivering", "sent", "generated", "generation_failed", "delivery_failed", "uncertain"].includes(receipt.status) ||
            (receipt.text !== undefined && typeof receipt.text !== "string") ||
            (receipt.error !== undefined && typeof receipt.error !== "string"))
          throw new MemoryAdminError("渠道消息回执损坏，不能安全恢复记忆");
        identifier(stored.sessionId);
        const member = receipt.group_message_id !== undefined;
        const leaderId = member ? receipt.group_message_id : receipt.external_message_id;
        if ((member && (!label(leaderId) || leaderId === receipt.external_message_id)) ||
            receipt.delivery_id !== "delivery_" + digest(JSON.stringify([key, leaderId, receipt.direction])))
          throw new MemoryAdminError("渠道消息回执损坏，不能安全恢复记忆");
        if (member || receipt.group_id !== undefined) {
          // Group members share one delivery, but retain independent input fingerprints.
          if (receipt.direction !== "in" || receipt.group_id !== "turn_" + digest(JSON.stringify([key, leaderId])) ||
              typeof receipt.input_text !== "string" || !receipt.input_text.trim() || receipt.input_text.length > 16000 ||
              !label(receipt.input_sender) || receipt.fingerprint !== digest(JSON.stringify([receipt.input_sender, receipt.input_text])) ||
              typeof receipt.received_at !== "string" || !Number.isFinite(Date.parse(receipt.received_at)))
            throw new MemoryAdminError("渠道分组回执损坏，不能安全恢复记忆");
          if (member) {
            const leader = route.receipts[digest(JSON.stringify([leaderId, "in"]))];
            if (!object(leader) || !object(leader.receipt) || leader.sessionId !== stored.sessionId ||
                leader.receipt.group_message_id !== undefined || leader.receipt.group_id !== receipt.group_id ||
                leader.receipt.direction !== "in" || leader.receipt.external_message_id !== leaderId ||
                leader.receipt.delivery_id !== receipt.delivery_id || leader.receipt.input_sender !== receipt.input_sender)
              throw new MemoryAdminError("渠道分组回执缺失或冲突，不能安全恢复记忆");
          }
        }
      }
    }
    return routes;
  }
  private async retainChannelReceipts(staged: Memory) {
    const readIndex = async (memory: Memory) => parseSessionIndex(
      (await boundedRead(join(memory.root, "index.json"), MAX_SESSION_BYTES)).toString("utf8"),
    );
    const currentIndex = await readIndex(this.memory), stagedIndex = await readIndex(staged);
    const current = await this.channelSnapshot(this.memory, currentIndex);
    const restored = await this.channelSnapshot(staged, stagedIndex);
    for (const [key, live] of Object.entries(current)) {
      const previous = restored[key];
      if (previous && ["channel", "account", "peer", "owner"].some((name) => live[name] !== previous[name]))
        throw new MemoryAdminError("备份渠道归属与当前绑定冲突，不能安全恢复记忆");
      const receipts = { ...previous?.receipts };
      for (const [messageKey, saved] of Object.entries<any>(live.receipts)) {
        const older = receipts[messageKey];
        if (older && (older.sessionId !== saved.sessionId || older.receipt.fingerprint !== saved.receipt.fingerprint ||
            ["delivery_id", "group_id", "group_message_id"].some(field => older.receipt[field] !== saved.receipt[field])))
          throw new MemoryAdminError("备份渠道消息 ID 与当前回执冲突，不能安全恢复记忆");
        // Restoring conversation history cannot undo an already confirmed external send.
        receipts[messageKey] = older?.receipt.status === "sent" ? older : saved;
      }
      restored[key] = { ...(previous ?? live), receipts, receiptHistoryIncomplete: !!live.receiptHistoryIncomplete };
    }
    if (!Object.keys(restored).length) return;
    const mirrors = new Set<string>();
    for (const [key, route] of Object.entries(restored)) {
      const id = route.sessionId, previous = indexSessionMeta(stagedIndex, id);
      // A route created after the backup keeps its receipts but cannot recreate missing history.
      const meta = previous ?? { deleted: true, deleted_at: new Date().toISOString() };
      stagedIndex.sessions[id] = { ...meta, channel_bindings: { ...meta.channel_bindings,
        [key]: { channel: route.channel, account: route.account, peer: route.peer, owner: route.owner },
      } };
      if (!meta.deleted) mirrors.add(id);
    }
    stagedIndex.channel_routes = restored;
    // Validate the selected sent records and retained members together before committing.
    await this.channelSnapshot(staged, stagedIndex);
    await atomic(join(staged.root, "index.json"), JSON.stringify(stagedIndex, null, 2));
    for (const id of mirrors) {
      await directoryChain(staged.sessionDir(id), true);
      await atomic(join(staged.sessionDir(id), "session.json"), JSON.stringify(stagedIndex.sessions[id], null, 2));
    }
  }
  restore(input: { id: string }) {
    if (this.sessions.memoryMaintenance)
      return Promise.reject(
        new MemoryAdminError("记忆恢复正在进行，请稍后重试", 409),
      );
    if (this.sessions.locks.size || this.sessions.blockedSessions?.size || this.sessions.channelOperations?.size)
      return Promise.reject(
        new MemoryAdminError("对话正在进行，请等待回复完成后再恢复记忆", 409),
      );
    this.sessions.memoryMaintenance = true;
    let recoveryRequired = false;
    return this.memory
      .serial(async () => {
        if (this.sessions.locks.size || this.sessions.channelOperations?.size)
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
          // Upgrade the staged copy before swapping it into the live root. Failure leaves live data untouched.
          const stagedMemory = new Memory(stage, this.logger);
          await stagedMemory.init();
          await this.retainChannelReceipts(stagedMemory);
          for (const entry of copied.files) {
            if (
              !/^sessions\/[a-zA-Z0-9_-]{1,100}\/knowledge\/state\.json$/.test(
                entry.path,
              )
            )
              continue;
            validateMemoryState(
              JSON.parse(
                (
                  await boundedRead(
                    join(stage, ...entry.path.split("/")),
                    MAX_SESSION_BYTES,
                  )
                ).toString("utf8"),
              ),
            );
          }
          await new MemoryEngine(stagedMemory).recoverSummaries();
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
