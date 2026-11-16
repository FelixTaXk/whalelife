/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdirSync, appendFileSync, readdirSync, lstatSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { installLogOutputGuards, writeLogOutput } from "./log-output.ts";

const levels = ["debug", "info", "warn", "error"];
const ownedLog = /^whalelife-(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d*))?\.log$/;
const maxFailures = 5;

function positiveBytes(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : fallback;
}

function boundedLine(line: string, bytes: number) {
  if (Buffer.byteLength(line) <= bytes) return line;
  const marker = bytes >= 12 ? " [TRUNCATED]" : "!".repeat(Math.min(bytes, 1));
  const available = bytes - Buffer.byteLength(marker);
  // Slice before encoding so a huge input does not allocate another huge Buffer.
  const prefix = Buffer.from(line.slice(0, available)).subarray(0, available)
    .toString("utf8").replace(/\uFFFD$/, "");
  return prefix + marker;
}

type LogFile = { name: string; size: number; mtime: number; sequence: number };

export class Logger extends EventEmitter {
  lines: string[] = [];
  secrets: string[];
  dir: string;
  options: any;
  private failures = 0;
  private retryAt = 0;
  private dropped = 0;
  private notifying = false;
  private listenerWarning = false;

  constructor(publicDir: string, options: any = {}, secrets: string[] = []) {
    super();
    this.dir = publicDir;
    this.options = options;
    this.secrets = secrets.filter((secret) => typeof secret === "string" && secret.length > 0);
    installLogOutputGuards();
    try {
      mkdirSync(this.dir, { recursive: true });
      this.maintain(this.fileName(), 0);
    } catch (error) {
      this.fileFailure(error);
    }
  }

  /** File failures do not imply business failure; callers can inspect degradation. */
  get fileStatus() {
    return {
      state: this.failures >= maxFailures ? "disabled" : this.failures ? "retrying" : "ready",
      failures: this.failures,
      dropped: this.dropped,
      retryAt: this.retryAt,
    };
  }

  private get maxTotalBytes() {
    return positiveBytes(this.options.max_total_bytes, 100 * 1024 * 1024);
  }

  private get maxFileBytes() {
    return Math.min(positiveBytes(this.options.max_file_bytes, 10 * 1024 * 1024), this.maxTotalBytes);
  }

  private fileName() {
    return `whalelife-${new Date().toLocaleDateString("en-CA")}.log`;
  }

  private format(level: string, message: string, extra?: unknown) {
    let encoded = "";
    if (extra !== undefined) {
      try {
        encoded = " " + JSON.stringify(extra, (_key, value) => {
          if (typeof value === "bigint") return `${value}n`;
          return value instanceof Error ? { message: value.message, stack: value.stack } : value;
        });
      } catch {
        encoded = " [Unserializable log data]";
      }
    }
    let text: string;
    try { text = String(message); } catch { text = "[Unserializable log message]"; }
    let line = `${new Date().toISOString()} [${level.toUpperCase()}] ${text}${encoded}`;
    for (const secret of this.secrets) {
      if (typeof secret === "string" && secret.length) line = line.replaceAll(secret, "[REDACTED]");
    }
    // Bound every sink consistently; the final newline counts toward disk quota.
    return boundedLine(line, Math.min(64 * 1024, this.maxFileBytes) - 1);
  }

  private remember(line: string, notify = true) {
    this.lines.push(line);
    const configuredLines = this.options.max_web_lines;
    const maxLines = typeof configuredLines === "number" && Number.isFinite(configuredLines) && configuredLines >= 0
      ? Math.floor(configuredLines) : 1000;
    if (this.lines.length > maxLines) this.lines.splice(0, this.lines.length - maxLines);
    if (!notify || this.notifying) return;
    this.notifying = true;
    try {
      // rawListeners preserves once semantics. A bad subscriber must not prevent
      // later subscribers, file logging, or business code from continuing.
      for (const listener of this.rawListeners("line")) {
        try {
          const result = listener.call(this, line);
          if (result && typeof result.then === "function")
            void Promise.resolve(result).catch(() => this.listenerFailure());
        } catch {
          this.listenerFailure();
        }
      }
    } finally {
      this.notifying = false;
    }
  }

  private notice(message: string) {
    const line = this.format("warn", message);
    this.remember(line, false);
    writeLogOutput(line, "stderr");
  }

  private listenerFailure() {
    if (this.listenerWarning) return;
    this.listenerWarning = true;
    this.notice("日志订阅回调失败，后续同类警告已抑制；其他日志输出继续。");
  }

  private fileFailure(error: unknown) {
    this.failures++;
    this.retryAt = this.failures >= maxFailures ? 0 : Date.now() + 1000 * 2 ** (this.failures - 1);
    if (this.failures === 1 || this.failures === maxFailures) {
      // Never echo arbitrary error messages, which may contain credentials.
      const rawCode = (error as NodeJS.ErrnoException | null)?.code;
      const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,32}$/.test(rawCode) ? rawCode : "IO_ERROR";
      this.notice(this.failures >= maxFailures
        ? `文件日志连续失败 ${maxFailures} 次（${code}），已停用，重启后重试；内存日志继续。`
        : `文件日志暂不可用（${code}），将退避重试，最多 ${maxFailures} 次；内存日志继续。`);
    }
  }

  private maintain(activeName: string, incomingBytes: number) {
    const now = Date.now();
    const configuredDays = this.options.keep_days;
    const keepDays = typeof configuredDays === "number" && Number.isFinite(configuredDays) && configuredDays >= 0
      ? configuredDays : 14;
    const files: LogFile[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      const match = ownedLog.exec(entry.name);
      // Never recurse or follow links: executions, diagnostics and other files
      // are outside the logger's ownership.
      if (!match || !entry.isFile()) continue;
      const date = new Date(`${match[1]}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) continue;
      if (!Number.isSafeInteger(Number(match[2] ?? 0))) continue;
      const stat = lstatSync(join(this.dir, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (now - stat.mtimeMs > keepDays * 86400000) {
        unlinkSync(join(this.dir, entry.name));
      } else {
        files.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs, sequence: Number(match[2] ?? 0) });
      }
    }

    const active = files.find((file) => file.name === activeName);
    if (active && active.size + incomingBytes > this.maxFileBytes) {
      const stem = activeName.slice(0, -4);
      const sequence = files.reduce((max, file) => file.name.startsWith(stem + ".") ? Math.max(max, file.sequence) : max, 0) + 1;
      const rotatedName = `${stem}.${sequence}.log`;
      // The scan ignores links/directories; explicitly reject such a collision.
      try {
        lstatSync(join(this.dir, rotatedName));
        throw Object.assign(new Error("Log rotation destination exists"), { code: "EEXIST" });
      } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      renameSync(join(this.dir, active.name), join(this.dir, rotatedName));
      active.name = rotatedName;
      active.sequence = sequence;
    }

    // Legacy oversized files are rotated then removed without loading their
    // contents. Prune before append, including on startup and recovery.
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((a, b) => a.mtime - b.mtime || a.sequence - b.sequence || a.name.localeCompare(b.name));
    for (const file of files) {
      if (file.size > this.maxFileBytes || (total + incomingBytes > this.maxTotalBytes && file.name !== activeName)) {
        unlinkSync(join(this.dir, file.name));
        total -= file.size;
      }
    }
    // Do not let append follow an active log name replaced by a link/directory.
    try {
      if (!lstatSync(join(this.dir, activeName)).isFile())
        throw Object.assign(new Error("Log destination is not a regular file"), { code: "EINVAL" });
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }

  log(level: string, message: string, extra?: unknown) {
    if (levels.indexOf(level) < levels.indexOf(this.options.level ?? "info")) return;
    const line = this.format(level, message, extra);
    writeLogOutput(line);
    if (this.failures >= maxFailures || (this.failures && Date.now() < this.retryAt)) {
      this.dropped++;
    } else {
      try {
        mkdirSync(this.dir, { recursive: true });
        const file = this.fileName();
        this.maintain(file, Buffer.byteLength(line) + 1);
        appendFileSync(join(this.dir, file), line + "\n");
        if (this.failures) {
          this.notice(`文件日志已恢复；此前 ${this.dropped} 条日志未确认写入磁盘。`);
          this.failures = 0;
          this.retryAt = 0;
          this.dropped = 0;
        }
      } catch (error) {
        this.dropped++;
        this.fileFailure(error);
      }
    }
    // Keep the original successful-write-before-event ordering.
    this.remember(line);
  }

  debug(m: string, e?: unknown) { this.log("debug", m, e); }
  info(m: string, e?: unknown) { this.log("info", m, e); }
  warn(m: string, e?: unknown) { this.log("warn", m, e); }
  error(m: string, e?: unknown) { this.log("error", m, e); }
}
