/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type DiagnosticContext = {
  session_id?: string; execution_id?: string; task_id?: string;
  parent_execution_id?: string; relation_verified?: boolean; request_id?: string;
  plugin_id?: string; purpose?: string; tool_call_id?: string;
};
type Attachment = { bytes: Buffer; sha256: string };
type Job = { sequence: number; line: string; bytes: number; attachments: Attachment[] };
type Gap = { first_sequence: number; last_sequence: number; dropped_events: number;
  uncertain_events: number; reasons: Record<string, number> };
const hidden = "[REDACTED]";
const contextKeys = ["session_id", "execution_id", "task_id", "parent_execution_id", "request_id", "plugin_id", "purpose", "tool_call_id"] as const;
const normalized = (key: string) => key.toLowerCase().replace(/[-_\s]/g, "");
const credentialKeys = new Set(["authorization", "proxyauthorization", "cookie", "cookies", "setcookie", "apikey", "secret", "clientsecret", "password", "passwd", "accesstoken", "refreshtoken", "idtoken", "credential", "credentials"]);
const credentialKey = (key: string, value: unknown) => credentialKeys.has(normalized(key)) ||
  (normalized(key) === "token" && typeof value === "string");
const queryKey = (key: string) => credentialKeys.has(normalized(key)) ||
  /^(?:token|key|sig|signature|auth|authkey|securitytoken|xamz(?:signature|credential|securitytoken)|xgoog(?:signature|credential)|wssecret|wssign|upsig)$/i.test(normalized(key));
const urls = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const localPath = (value: unknown): value is string => typeof value === "string" && !!value.trim() &&
  isAbsolute(value) && !/^(?:\\\\|\/\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(value) && !value.includes("\0");
const samePath = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const inside = (child: string, parent: string) => {
  const a = samePath(resolve(child)), b = samePath(resolve(parent));
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const integer = (value: unknown, fallback: number) => value === undefined ? fallback :
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : (() => { throw Error("invalid_limit"); })();
class SnapshotError extends Error {}

/** Resolve nonexistent suffixes without creating any directory. */
async function canonical(path: string): Promise<string> {
  let cursor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try { return resolve(await realpath(cursor), ...suffix.reverse()); }
    catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(relative(parent, cursor)); cursor = parent;
    }
  }
}
/** Reject junctions and symlinks at every component, including existing parents. */
async function ordinaryDirectory(path: string, create = false) {
  const absolute = resolve(path), anchor = parse(absolute).root;
  let cursor = anchor;
  for (const part of relative(anchor, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try { stat = await lstat(cursor); }
    catch (error: any) {
      if (!create || error.code !== "ENOENT") throw error;
      try { await mkdir(cursor, { mode: 0o700 }); }
      catch (mkdirError: any) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      stat = await lstat(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe_directory");
  }
}

/** Opt-in private diagnostic output. It neither participates in memory nor retries business work. */
export class Diagnostics {
  private readonly root: string;
  private readonly options: any;
  private readonly logger: any;
  private readonly secretSource?: () => string[];
  private readonly scope = new AsyncLocalStorage<DiagnosticContext>();
  private readonly instance = randomUUID();
  private readonly secrets = new Set<string>();
  private secretBytes = 0;
  private secretOverflow = false;
  private readonly warned = new Set<string>();
  private active = false;
  private initialized = false;
  private closing = false;
  private closed = false;
  private initialization?: Promise<void>;
  private closingPromise?: Promise<void>;
  private directory = "";
  private file = "";
  private segment = 0;
  private sequence = 0;
  private maxEvent = 64 * 1024 * 1024;
  private maxQueue = 128 * 1024 * 1024;
  private drainTimeout = 2000;
  private queue: Job[] = [];
  private queuedBytes = 0;
  private inFlight?: Job;
  private pumping?: Promise<void>;
  private gap?: Gap;
  private dropped = 0;
  private uncertain = 0;
  private written = 0;
  private failure?: string;
  constructor(root: string, options: any, logger: any, secrets?: () => string[]) {
    this.root = root; this.options = options ?? {}; this.logger = logger; this.secretSource = secrets;
  }
  get enabled() { return this.active && !this.closing; }
  initialize(): Promise<void> {
    return this.initialization ??= this.initializeOnce();
  }
  private async initializeOnce() {
    try {
      // This branch intentionally precedes all filesystem access and secret discovery.
      if (this.options.enabled !== true || this.closing) return;
      if (!localPath(this.options.directory)) throw Error("invalid_directory");
      this.maxEvent = integer(this.options.max_event_bytes, this.maxEvent);
      this.maxQueue = integer(this.options.max_queue_bytes, this.maxQueue);
      this.drainTimeout = Math.min(60000, integer(this.options.flush_timeout_ms, this.drainTimeout));
      const directory = resolve(this.options.directory);
      const exclusions = [resolve(this.root)];
      if (this.options.excluded_directories !== undefined) {
        if (!Array.isArray(this.options.excluded_directories) || this.options.excluded_directories.some((x: unknown) => !localPath(x)))
          throw Error("invalid_exclusions");
        exclusions.push(...this.options.excluded_directories.map((x: string) => resolve(x)));
      }
      if (exclusions.some(path => overlaps(directory, path))) throw Error("business_directory");
      const actual = await canonical(directory);
      for (const path of exclusions) if (overlaps(actual, await canonical(path))) throw Error("business_directory");
      await ordinaryDirectory(directory, true);
      await ordinaryDirectory(join(directory, "attachments"), true);
      this.directory = directory;
      await this.newFile();
      if (!this.closing) this.active = true;
    } catch {
      this.failure = "initialization_failed";
      this.warn("initialization_failed");
    } finally { this.initialized = true; }
  }
  private async newFile() {
    this.file = join(this.directory, `whalelife-${this.instance}-${String(this.segment++).padStart(6, "0")}.jsonl`);
    const handle = await open(this.file, "wx", 0o600);
    await handle.close();
  }
  current(): DiagnosticContext { return { ...(this.scope.getStore() ?? {}) }; }
  run<T>(context: DiagnosticContext, fn: () => T): T {
    return this.scope.run(Object.freeze({ ...this.current(), ...context }), fn);
  }
  registerSecret(secret: string): void {
    try {
      if (typeof secret !== "string" || !secret || this.secrets.has(secret)) return;
      const bytes = Buffer.byteLength(secret);
      if (this.secrets.size >= 4096 || this.secretBytes + bytes > 1024 * 1024) {
        this.secretOverflow = true; this.warn("secret_capacity"); return;
      }
      this.secrets.add(secret); this.secretBytes += bytes;
    } catch { this.secretOverflow = true; }
  }
  private learn(value: unknown, seen = new Set<object>(), depth = 0) {
    if (depth > 100) throw new SnapshotError("invalid_value");
    if (value && typeof value === "object") {
      if (seen.has(value)) throw new SnapshotError("invalid_value");
      seen.add(value);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue;
        if (!Object.hasOwn(descriptor, "value")) throw new SnapshotError("invalid_value");
        this.learn(descriptor.value, seen, depth + 1);
      }
      seen.delete(value); return;
    }
    if (typeof value !== "string" || !value) return;
    this.registerSecret(value);
    const bearer = value.match(/^\s*(?:Bearer|Basic)\s+(.+?)\s*$/i);
    if (bearer) this.registerSecret(bearer[1]);
    for (const cookie of value.split(";")) {
      const match = cookie.match(/^\s*[^=\s]+=([^;]+)\s*$/);
      if (match) this.registerSecret(match[1].trim());
    }
  }
  private urlText(text: string) {
    return text.replace(urls, raw => {
      try {
        const url = new URL(raw);
        let changed = false;
        if (url.username || url.password) {
          for (const part of [url.username, url.password]) {
            this.learn(part);
            try { this.learn(decodeURIComponent(part)); } catch { /* Keep encoded value. */ }
          }
          url.username = ""; url.password = ""; changed = true;
        }
        for (const key of [...url.searchParams.keys()]) if (queryKey(key)) {
          for (const value of url.searchParams.getAll(key)) this.learn(value);
          url.searchParams.set(key, hidden); changed = true;
        }
        // Preserve ordinary URLs byte-for-byte. URL parsing is only for credentials.
        return changed ? url.href : raw;
      } catch {
        // Prompts legitimately contain examples such as https://host:port/path.
        // Keep those strings intact, but remove identifiable credentials even
        // when an invalid port/escape prevents the URL parser from accepting them.
        const learnEncoded = (value: string) => {
          this.learn(value);
          try { this.learn(decodeURIComponent(value)); } catch { /* Preserve only the encoded credential in the registry. */ }
        };
        const safe = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)/i, (_all, scheme, userinfo) => {
          const credentials = userinfo.slice(0, -1);
          learnEncoded(credentials);
          for (const part of credentials.split(":")) learnEncoded(part);
          return scheme;
        });
        return safe.replace(/([?&])([^=&#]+)=([^&#]*)/g, (all, separator, name, value) => {
          let key = name;
          try { key = decodeURIComponent(name); } catch { /* Match the original key if its encoding is invalid. */ }
          if (!queryKey(key)) return all;
          learnEncoded(value);
          return separator + name + "=" + encodeURIComponent(hidden);
        });
      }
    });
  }
  private snapshot(value: any) {
    const attachments = new Map<string, Attachment>(), stack = new Set<object>();
    const generatedAttachments = new WeakSet<object>();
    let measured = 0;
    const count = (bytes: number) => {
      measured += bytes;
      if (measured > this.maxEvent) throw new SnapshotError("event_too_large");
    };
    const media = (input: Uint8Array, mime: string) => {
      count(input.byteLength);
      const bytes = Buffer.from(input), sha256 = createHash("sha256").update(bytes).digest("hex");
      if (!attachments.has(sha256)) attachments.set(sha256, { bytes, sha256 });
      const reference = { $attachment: { path: "attachments/" + sha256, mime, sha256 } };
      generatedAttachments.add(reference);
      return reference;
    };
    const text = (input: string) => {
      if (/^data:/i.test(input)) {
        const comma = input.indexOf(",");
        if (comma < 0) throw new SnapshotError("invalid_media");
        const metadata = input.slice(5, comma), body = input.slice(comma + 1);
        const mime = metadata.split(";")[0] || "text/plain";
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new SnapshotError("invalid_media");
        if (/;base64$/i.test(metadata)) {
          if (body.length > Math.ceil(this.maxEvent * 4 / 3) + 4 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body))
            throw new SnapshotError(body.length > this.maxEvent * 4 / 3 + 4 ? "event_too_large" : "invalid_media");
          return media(Buffer.from(body, "base64"), mime);
        }
        // Size and validate before allocating; dense %xx media must not allocate
        // one Buffer per byte. Unescaped text retains its ordinary UTF-8 encoding.
        if (body.length > this.maxEvent * 3) throw new SnapshotError("event_too_large");
        const hex = (value: number) => value >= 48 && value <= 57 ? value - 48
          : value >= 65 && value <= 70 ? value - 55 : value >= 97 && value <= 102 ? value - 87 : -1;
        const octet = (index: number) => {
          const high = hex(body.charCodeAt(index + 1)), low = hex(body.charCodeAt(index + 2));
          if (high < 0 || low < 0) throw new SnapshotError("invalid_media");
          return high * 16 + low;
        };
        let size = 0, start = 0;
        for (let i = 0; i < body.length; i++) if (body[i] === "%") {
          octet(i);
          size += Buffer.byteLength(body.slice(start, i)) + 1;
          if (size > this.maxEvent) throw new SnapshotError("event_too_large");
          i += 2; start = i + 1;
        }
        size += Buffer.byteLength(body.slice(start));
        if (size > this.maxEvent) throw new SnapshotError("event_too_large");
        const bytes = Buffer.allocUnsafe(size);
        let offset = 0; start = 0;
        for (let i = 0; i < body.length; i++) if (body[i] === "%") {
          if (i > start) offset += bytes.write(body.slice(start, i), offset, "utf8");
          bytes[offset++] = octet(i);
          i += 2; start = i + 1;
        }
        if (start < body.length) bytes.write(body.slice(start), offset, "utf8");
        return media(bytes, mime);
      }
      count(Buffer.byteLength(input));
      return this.urlText(input).replace(/\b(Bearer|Basic)\s+([A-Za-z\d._~+/=-]+)/gi, (_all, scheme, secret) => {
        this.learn(secret); return scheme + " " + hidden;
      });
    };
    const visit = (item: any, depth = 0, mime = "application/octet-stream", headers = false): any => {
      if (depth > 100) throw new SnapshotError("invalid_value");
      count(4);
      if (item === null || item === undefined || typeof item === "boolean") return item;
      if (typeof item === "number") {
        if (!Number.isFinite(item)) throw new SnapshotError("invalid_value");
        return item;
      }
      if (typeof item === "string") return text(item);
      if (typeof item !== "object") throw new SnapshotError("invalid_value");
      if (item instanceof Uint8Array) return media(item, mime);
      if (item instanceof Date) return item.toISOString();
      if (item instanceof URL) return text(item.href);
      if (stack.has(item)) throw new SnapshotError("invalid_value");
      stack.add(item);
      try {
        if (Array.isArray(item)) {
          // Fetch Headers can also be represented by [name, value] tuples.
          if (headers && item.length === 2 && typeof item[0] === "string" && credentialKey(item[0], item[1])) {
            this.learn(item[1]); return [item[0], hidden];
          }
          return item.map(value => visit(value, depth + 1, mime, headers) ?? null);
        }
        if (typeof Headers !== "undefined" && item instanceof Headers)
          return visit(Object.fromEntries(item.entries()), depth + 1, mime, true);
        const prototype = Object.getPrototypeOf(item);
        if (!(item instanceof Error) && prototype !== Object.prototype && prototype !== null)
          throw new SnapshotError("invalid_value");
        const descriptors = Object.getOwnPropertyDescriptors(item), result: Record<string, any> = {};
        for (const name of ["mime", "mime_type", "media_type"]) {
          const type = descriptors[name]?.value;
          if (typeof type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(type)) mime = type;
        }
        if (item instanceof Error) {
          result.name = text(item.name);
          result.message = text(item.message);
          if (typeof item.stack === "string") result.stack = text(item.stack);
        }
        for (const key of Reflect.ownKeys(descriptors)) {
          const descriptor = (descriptors as any)[key] as PropertyDescriptor;
          if (!descriptor.enumerable) continue;
          if (typeof key !== "string" || !Object.hasOwn(descriptor, "value")) throw new SnapshotError("invalid_value");
          count(Buffer.byteLength(key));
          let saved;
          if (credentialKey(key, descriptor.value)) { this.learn(descriptor.value); saved = hidden; }
          else saved = visit(descriptor.value, depth + 1, mime, headers || /headers$/i.test(key));
          if (saved !== undefined) Object.defineProperty(result, key, { value: saved, enumerable: true, configurable: true });
        }
        return result;
      } finally { stack.delete(item); }
    };
    const snapshot = visit(value);
    if (this.secretOverflow) throw new SnapshotError("secret_capacity");
    const secrets = [...this.secrets].sort((a, b) => b.length - a.length);
    const clean = (item: any): any => {
      if (typeof item === "string") {
        for (const secret of secrets) if (secret.length >= 8) item = item.replaceAll(secret, hidden);
        else if (item === secret) item = hidden;
        return item;
      }
      if (Array.isArray(item)) return item.map(clean);
      if (item && typeof item === "object") {
        // References are generated from trusted hashes, never mutable source paths.
        if (generatedAttachments.has(item)) return item;
        return Object.fromEntries(Object.entries(item).map(([key, value]) => [clean(key), clean(value)]));
      }
      return item;
    };
    return { data: clean(snapshot), attachments: [...attachments.values()] };
  }
  event(kind: string, data: any = {}, context?: DiagnosticContext): void {
    if (!this.enabled) return;
    const sequence = ++this.sequence;
    try {
      if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{0,79}$/.test(kind)) throw new SnapshotError("invalid_value");
      for (const secret of this.secretSource?.() ?? []) this.registerSecret(secret);
      const scope = { ...this.current(), ...context }, fields: Record<string, any> = {};
      for (const key of contextKeys) if (scope[key] !== undefined) {
        if (typeof scope[key] !== "string") throw new SnapshotError("invalid_value");
        fields[key] = scope[key];
      }
      if (scope.relation_verified !== undefined) {
        if (typeof scope.relation_verified !== "boolean") throw new SnapshotError("invalid_value");
        fields.relation_verified = scope.relation_verified;
      }
      const snapshot = this.snapshot({ ...fields, data });
      const line = JSON.stringify({ ...this.metadata(sequence, kind), ...snapshot.data }) + "\n";
      const bytes = Buffer.byteLength(line) + snapshot.attachments.reduce((n, attachment) => n + attachment.bytes.length, 0);
      if (bytes > this.maxEvent) throw new SnapshotError("event_too_large");
      if (bytes + this.queuedBytes > this.maxQueue) throw new SnapshotError("queue_overflow");
      this.queue.push({ sequence, line, bytes, attachments: snapshot.attachments });
      this.queuedBytes += bytes;
      this.kick();
    } catch (error) {
      this.noteGap(sequence, error instanceof SnapshotError ? error.message : "snapshot_failed");
      this.kick();
    }
  }
  private metadata(sequence: number, kind: string) {
    return { schema_version: 1, event_id: `${this.instance}:${sequence}`, producer_id: "whalelife",
      instance_id: this.instance, sequence, ts: new Date().toISOString(), kind };
  }
  private warn(reason: string) {
    if (this.warned.has(reason)) return;
    this.warned.add(reason);
    try { this.logger?.warn?.("私有诊断记录不可用或存在缺口，业务继续", { reason }); } catch { /* Never affect business. */ }
  }
  private noteGap(sequence: number, reason: string, uncertain = false) {
    this.failure = reason;
    if (uncertain) this.uncertain++; else this.dropped++;
    this.gap ??= { first_sequence: sequence, last_sequence: sequence, dropped_events: 0, uncertain_events: 0, reasons: {} };
    this.gap.first_sequence = Math.min(this.gap.first_sequence, sequence);
    this.gap.last_sequence = Math.max(this.gap.last_sequence, sequence);
    this.gap[uncertain ? "uncertain_events" : "dropped_events"]++;
    this.gap.reasons[reason] = (this.gap.reasons[reason] ?? 0) + 1;
    this.warn(reason);
  }
  private async attachment(item: Attachment) {
    const file = join(this.directory, "attachments", item.sha256);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== item.bytes.length ||
          createHash("sha256").update(await readFile(file)).digest("hex") !== item.sha256) throw Error("attachment_conflict");
      return;
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, item.bytes, { flag: "wx", mode: 0o600 });
      // All jobs in this instance are serial. Other instances can only commit the same hash/bytes.
      await rename(temp, file);
    } finally { await unlink(temp).catch(() => {}); }
  }
  private async writeJob(job: Job) {
    await ordinaryDirectory(this.directory);
    await ordinaryDirectory(join(this.directory, "attachments"));
    for (const attachment of job.attachments) await this.attachment(attachment);
    if (!this.file) await this.newFile();
    const info = await lstat(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error("unsafe_file");
    const handle = await open(this.file, "a", 0o600);
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || current.ino !== info.ino || current.dev !== info.dev) throw Error("unsafe_file");
      try { await handle.writeFile(job.line, "utf8"); }
      catch { throw Object.assign(Error("write_failed"), { uncertain: true }); }
    } finally { await handle.close(); }
  }
  private kick() {
    if (!this.active || this.pumping || (!this.queue.length && !this.gap)) return;
    this.pumping = this.pump().catch(() => { this.failure = "writer_failed"; this.warn("writer_failed"); }).finally(() => {
      this.pumping = undefined;
      // A failed gap is retried only by new events/flush, not by an unbounded background loop.
      if (this.queue.length) this.kick();
    });
  }
  private async pump() {
    while (this.queue.length || this.gap) {
      const reporting = !this.queue.length ? this.gap : undefined;
      let job: Job;
      if (reporting) {
        this.gap = undefined;
        const sequence = ++this.sequence;
        const line = JSON.stringify({ ...this.metadata(sequence, "capture.gap"), data: { reason: "capture_incomplete", ...reporting } }) + "\n";
        job = { sequence, line, bytes: 0, attachments: [] };
      } else job = this.queue.shift()!;
      this.inFlight = job;
      try { await this.writeJob(job); this.written++; }
      catch (error: any) {
        // An append can leave a half line. Preserve it and continue in a fresh file.
        this.file = "";
        if (reporting) {
          const later = this.gap;
          this.gap = reporting;
          if (later) {
            this.gap.first_sequence = Math.min(this.gap.first_sequence, later.first_sequence);
            this.gap.last_sequence = Math.max(this.gap.last_sequence, later.last_sequence);
            this.gap.dropped_events += later.dropped_events; this.gap.uncertain_events += later.uncertain_events;
            for (const [reason, count] of Object.entries(later.reasons)) this.gap.reasons[reason] = (this.gap.reasons[reason] ?? 0) + count;
          }
          this.failure = "gap_write_failed"; this.warn("gap_write_failed");
          break;
        }
        this.noteGap(job.sequence, "write_failed", error?.uncertain === true);
      } finally { this.queuedBytes -= job.bytes; this.inFlight = undefined; }
    }
  }
  async flush(timeoutMs = this.drainTimeout): Promise<void> {
    try {
      this.kick();
      if (!this.pumping) return;
      const timeout = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(60000, timeoutMs)) : this.drainTimeout;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.pumping, new Promise<void>(resolve => { timer = setTimeout(resolve, timeout); })]);
      if (timer) clearTimeout(timer);
    } catch { this.warn("flush_failed"); }
  }
  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    return this.closingPromise = (async () => {
      await this.flush();
      for (const job of this.queue.splice(0)) {
        this.queuedBytes -= job.bytes; this.noteGap(job.sequence, "close_timeout");
      }
      if (this.inFlight) this.warn("close_timeout");
      this.closed = true;
    })();
  }
  status() {
    return { enabled: this.enabled, initialized: this.initialized, closed: this.closed,
      writing: !!this.inFlight, pending_events: this.queue.length + (this.inFlight ? 1 : 0), queued_bytes: this.queuedBytes,
      last_sequence: this.sequence, written_events: this.written, dropped_events: this.dropped,
      uncertain_events: this.uncertain, gap_pending: !!this.gap, ...(this.failure ? { last_error: this.failure } : {}) };
  }
}
