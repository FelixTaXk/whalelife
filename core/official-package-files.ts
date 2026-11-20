/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

export interface OfficialPackageSpec {
  directory: string;
  sha256: string;
  recognitionOnly?: boolean;
  preserve?: readonly string[];
}
export interface OfficialFileState {
  state: "absent" | "installed" | "blocked";
  reason?: string;
}
interface PackageFile { path: string; size: number; sha256: string }
interface Inventory {
  files: PackageFile[];
  byPath: Map<string, PackageFile>;
  directories: Set<string>;
}
const hashPattern = /^[a-f0-9]{64}$/;
const held = new Map<string, Promise<void>>();
const metadata = new Map<string, { stamp: string; inventory: Inventory }>();
const digestCache = new Map<string, { stamp: string; digest: string }>();
const persistent = new Set(["data", "config", "config.json", "config.yml", "config.yaml", "settings.json", ".env"]);

function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && value.normalize("NFC") === value &&
    value.split("/").every(part => part && !/[. ]$/.test(part) && !/[\\<>:"|?*\x00-\x1f]/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) && !/~\d+(?:\.|$)/.test(part));
}
export function isPackageDataPath(path: string, preserve: readonly string[] = []) {
  const lower = path.toLowerCase();
  if (preserve.some(value => lower === value.toLowerCase() || lower.startsWith(value.toLowerCase() + "/"))) return true;
  // Each nested plugin has its own data/config namespace. Libraries may have source files named config.
  const parts = lower.split("/");
  let offset = 0;
  while (parts[offset] === "sub" && parts.length > offset + 2) offset += 2;
  return persistent.has(parts[offset]) || parts[offset].startsWith(".env.");
}
export function inventoryOf(header: Buffer): Inventory {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header));
  if (value?.format !== 1 || !Array.isArray(value.files) || value.files.length > 150_000) throw Error("发行包清单格式错误");
  const byPath = new Map<string, PackageFile>(), directories = new Set<string>(), spellings = new Map<string, string>();
  let size = 0;
  for (const file of value.files) {
    if (!safePath(file?.path) || !hashPattern.test(file?.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 ||
        isPackageDataPath(file.path) || byPath.has(file.path)) throw Error(`发行包文件不合规：${file?.path}`);
    size += file.size;
    if (size > 16 * 1024 ** 3) throw Error("发行包超出大小上限");
    const parts = file.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/"), key = path.toLowerCase();
      if ((spellings.has(key) && spellings.get(key) !== path) || (i < parts.length && byPath.has(path)) ||
          (i === parts.length && directories.has(path))) throw Error(`发行包文件名冲突：${path}`);
      spellings.set(key, path);
      if (i < parts.length) directories.add(path);
    }
    byPath.set(file.path, file);
  }
  if (!byPath.has("plugin.yaml")) throw Error("发行包缺少 plugin.yaml");
  return { files: [...byPath.values()], byPath, directories };
}

// gzip wraps one UTF-8 inventory line followed by each file's exact bytes in inventory order.
async function readPackage(path: string, staging?: string, expected?: Inventory,
  manifests?: Map<string, Buffer>): Promise<Inventory> {
  const compressed = createReadStream(path), gzip = createGunzip({ chunkSize: 256 * 1024 });
  compressed.on("error", error => gzip.destroy(error)).pipe(gzip);
  const header: Buffer[] = [], created = new Set<string>();
  let headerSize = 0, inventory: Inventory | undefined, index = 0, written = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined, hash = createHash("sha256");
  let captured: Buffer[] = [];
  try {
    for await (const chunk of gzip) {
      const bytes = chunk as Buffer;
      let offset = 0;
      if (!inventory) {
        const end = bytes.indexOf(10), part = end < 0 ? bytes : bytes.subarray(0, end);
        headerSize += part.length;
        if (headerSize > 32 * 1024 ** 2) throw Error("发行包清单过大");
        header.push(part);
        if (end < 0) continue;
        inventory = inventoryOf(Buffer.concat(header));
        if (!staging && !manifests) return inventory;
        if (expected && (expected.files.length !== inventory.files.length || expected.files.some((file, i) => {
          const next = inventory!.files[i];
          return next.path !== file.path || next.size !== file.size || next.sha256 !== file.sha256;
        }))) throw Error("解包时发行清单已变化");
        offset = end + 1;
      }
      while (index < inventory.files.length) {
        const file = inventory.files[index];
        if (offset === bytes.length && file.size > written) break;
        const capture = manifests && /^(?:sub\/[^/]+\/)*plugin\.yaml$/.test(file.path);
        if (capture && (file.size > 128 * 1024 || manifests.size >= 256)) throw Error("发行包插件清单过大或子插件过多");
        if (staging && !handle) {
          const target = join(staging!, file.path), parent = dirname(target);
          if (!created.has(parent)) { await mkdir(parent, { recursive: true }); created.add(parent); }
          handle = await open(target, "wx");
        }
        const length = Math.min(bytes.length - offset, file.size - written);
        if (length) {
          const part = bytes.subarray(offset, offset + length);
          hash.update(part);
          if (handle) await handle.writeFile(part);
          if (capture) captured.push(part);
          written += length;
          offset += length;
        }
        if (written === file.size) {
          await handle?.close();
          handle = undefined;
          if (hash.digest("hex") !== file.sha256) throw Error(`发行文件校验失败：${file.path}`);
          if (capture) { manifests!.set(file.path, Buffer.concat(captured)); captured = []; }
          index++;
          written = 0;
          hash = createHash("sha256");
        }
      }
      if (offset !== bytes.length) throw Error("发行包包含清单之外的内容");
    }
    if (!inventory || index !== inventory.files.length) throw Error("发行包内容不完整");
    return inventory;
  } finally {
    compressed.destroy();
    gzip.destroy();
    await handle?.close();
  }
}

/** Stream verified contents and collect only plugin manifests, before any file becomes executable. */
export async function verifiedPackageManifests(root: string, spec: OfficialPackageSpec) {
  const { archive, inventory } = await releaseAt(root, spec);
  const manifests = new Map<string, Buffer>();
  await readPackage(archive, undefined, inventory, manifests);
  return { paths: inventory.byPath, manifests };
}

async function fileStamp(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile()) throw Error(`不是普通文件或使用了链接：${path}`);
  return { size: info.size, key: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join("/") };
}
export async function digestFile(path: string, expectedSize?: number, fresh = false) {
  const stamp = await fileStamp(path);
  if (expectedSize !== undefined && stamp.size !== BigInt(expectedSize)) return "";
  const previous = digestCache.get(path);
  if (!fresh && previous?.stamp === stamp.key) return previous.digest;
  const hash = createHash("sha256");
  if (stamp.size < 128 * 1024) hash.update(await readFile(path));
  else for await (const bytes of createReadStream(path, { highWaterMark: 512 * 1024 })) hash.update(bytes);
  if ((await fileStamp(path)).key !== stamp.key) throw Error(`校验时文件被修改：${path}`);
  const digest = hash.digest("hex");
  if (digestCache.size >= 150_000) digestCache.clear();
  digestCache.set(path, { stamp: stamp.key, digest });
  return digest;
}

// Check every ancestor before crossing it. readdir also detects case aliases on case-insensitive volumes.
export async function directoryAt(root: string, relative: string, create = false, made?: Set<string>) {
  let parent = root;
  const rootInfo = await lstat(parent);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error("宿主目录不是普通目录");
  for (const part of relative.split("/").filter(Boolean)) {
    const names = await readdir(parent), aliases = names.filter(name => name.toLowerCase() === part.toLowerCase());
    if (aliases.some(name => name !== part)) throw Error(`目录名大小写冲突：${part}`);
    parent = join(parent, part);
    if (!aliases.length && !create) return undefined;
    if (!aliases.length) {
      try { await mkdir(parent); made?.add(parent); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    }
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`目录使用了链接或不是目录：${part}`);
  }
  return parent;
}
async function releaseAt(root: string, spec: OfficialPackageSpec) {
  if (!/^plugins\/[a-z][a-z0-9-]*(?:\/sub\/[a-z][a-z0-9-]*)*$/.test(spec.directory) || !hashPattern.test(spec.sha256) ||
      spec.preserve?.some(path => !safePath(path))) throw Error("官方插件目录或摘要无效");
  if (spec.recognitionOnly) {
    const archive = fileURLToPath(new URL("../market/inventories/" + spec.sha256 + ".json", import.meta.url));
    const stamp = (await fileStamp(archive)).key;
    let entry = metadata.get(archive);
    if (entry?.stamp !== stamp) {
      const bytes = await readFile(archive);
      if (createHash("sha256").update(bytes).digest("hex") !== spec.sha256) throw Error("历史发行清单 SHA-256 校验失败");
      entry = { stamp, inventory: inventoryOf(bytes) };
      metadata.set(archive, entry);
    }
    if (spec.preserve?.length && entry.inventory.files.some(file => isPackageDataPath(file.path, spec.preserve!)))
      throw Error("历史清单包含需保留的用户资料");
    return { cache: join(root, ".artifacts", "official-packages"), archive, inventory: entry.inventory };
  }
  const cache = await directoryAt(root, ".artifacts/official-packages");
  if (!cache) throw Error("尚未取得已验证的发行包");
  const archive = join(cache, spec.sha256 + ".wlpkg.gz");
  let stamp: string;
  try { stamp = (await fileStamp(archive)).key; }
  catch (error) { if (missing(error)) throw Error("尚未取得已验证的发行包"); throw error; }
  let entry = metadata.get(archive);
  if (entry?.stamp !== stamp) {
    if (await digestFile(archive) !== spec.sha256) throw Error("发行包 SHA-256 校验失败");
    entry = { stamp, inventory: await readPackage(archive) };
    if ((await fileStamp(archive)).key !== stamp) throw Error("校验期间发行包被替换");
    metadata.set(archive, entry);
  }
  if (spec.preserve?.length && entry.inventory.files.some(file => isPackageDataPath(file.path, spec.preserve!))) {
    throw Error("发行包包含用户配置或持久数据");
  }
  return { cache, archive, inventory: entry.inventory };
}
function subDirectory(path: string) {
  return /^(?:sub\/[^/]+\/)*sub$/.test(path);
}
async function inspectTree(root: string, spec: OfficialPackageSpec, inventory: Inventory, fresh = false): Promise<OfficialFileState> {
  const base = await directoryAt(root, spec.directory);
  if (!base) return { state: "absent" };
  const seen = new Set<string>();
  async function visit(parent: string) {
    for (const item of await readdir(join(base!, parent), { withFileTypes: true })) {
      const path = parent ? parent + "/" + item.name : item.name;
      if (isPackageDataPath(path, spec.preserve)) {
        if (item.isSymbolicLink()) throw Error(`持久目录或配置使用了链接：${path}`);
        continue;
      }
      if (item.isSymbolicLink()) throw Error(`插件目录中存在链接：${path}`);
      if (item.isDirectory()) {
        if (subDirectory(parent) && !inventory.directories.has(path)) continue;
        if (!inventory.directories.has(path) && !subDirectory(path)) throw Error(`无法确认目录归属：${path}`);
        await visit(path);
      } else {
        if (!item.isFile() || !inventory.byPath.has(path)) throw Error(`无法确认文件归属：${path}`);
        seen.add(path);
      }
    }
  }
  await visit("");
  if (!seen.size) return { state: "absent" };
  for (const file of inventory.files) {
    if (!seen.has(file.path)) throw Error(`缺少发行文件：${file.path}`);
  }
  for (let i = 0; i < inventory.files.length; i += 16) {
    await Promise.all(inventory.files.slice(i, i + 16).map(async file => {
      if (await digestFile(join(base, file.path), file.size, fresh) !== file.sha256) throw Error(`文件与已审核发行包不一致：${file.path}`);
    }));
  }
  return { state: "installed" };
}
async function serialized<T>(root: string, work: () => Promise<T>) {
  const key = resolve(root).toLowerCase(), previous = held.get(key);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  held.set(key, gate);
  try { await previous; return await work(); }
  finally { release(); if (held.get(key) === gate) held.delete(key); }
}
export async function inspectOfficialFiles(root: string, spec: OfficialPackageSpec): Promise<OfficialFileState> {
  return serialized(root, async () => {
    try { return await inspectTree(root, spec, (await releaseAt(root, spec)).inventory); }
    catch (error) { return { state: "blocked", reason: errorText(error) }; }
  });
}

async function change(root: string, spec: OfficialPackageSpec, install: boolean) {
  return serialized(root, async () => {
    if (install && spec.recognitionOnly) throw Error("历史清单仅供识别已安装的官方版本。");
    const { archive, cache, inventory } = await releaseAt(root, spec);
    const before = await inspectTree(root, spec, inventory, true);
    if (before.state === (install ? "installed" : "absent")) return;
    await directoryAt(root, ".artifacts/official-packages", true);
    const staging = await mkdtemp(join(cache, install ? "install-" : "uninstall-"));
    const moved: PackageFile[] = [], made = new Set<string>(), checked = new Set<string>();
    let keepBackup = false;
    try {
      if (install) await readPackage(archive, staging, inventory);
      const base = (await directoryAt(root, spec.directory, install, made))!;
      // Publish the manifest last on install; hide it first on uninstall.
      const files = inventory.files.filter(file => file.path !== "plugin.yaml");
      const manifest = inventory.byPath.get("plugin.yaml")!;
      if (install) files.push(manifest); else files.unshift(manifest);
      for (const file of files) {
        const target = join(base, file.path), backup = join(staging, file.path), parent = dirname(target);
        if (!checked.has(parent)) {
          const relative = file.path.slice(0, Math.max(0, file.path.lastIndexOf("/")));
          if (!await directoryAt(base, relative, install, made)) throw Error(`目标目录已变化：${file.path}`);
          checked.add(parent);
        }
        if (install) {
          // link publishes the complete verified file atomically and never overwrites an existing name.
          await link(backup, target);
        } else {
          if (await digestFile(target, file.size) !== file.sha256) throw Error(`卸载时文件已改变：${file.path}`);
          await mkdir(dirname(backup), { recursive: true });
          await rename(target, backup);
        }
        moved.push(file);
      }
      if (!install) {
        for (const path of [...inventory.directories].sort((a, b) => b.length - a.length)) await removeEmpty(join(base, path));
        await removeEmpty(base);
      }
    } catch (error) {
      const failures: string[] = [];
      for (const file of moved.reverse()) {
        const target = join(root, spec.directory, file.path), backup = join(staging, file.path);
        try {
          if (install) {
            if (await digestFile(target, file.size) !== file.sha256) throw Error("文件已变化");
            await unlink(target);
          } else {
            await directoryAt(root, spec.directory + (file.path.includes("/") ? "/" + file.path.slice(0, file.path.lastIndexOf("/")) : ""), true);
            await link(backup, target);
          }
        } catch (rollback) { failures.push(`${file.path}：${errorText(rollback)}`); }
      }
      if (install) for (const path of [...made].sort((a, b) => b.length - a.length)) await removeEmpty(path);
      if (failures.length) {
        keepBackup = true;
        throw Error(`${errorText(error)}；撤回未完成，备份在 ${staging}：${failures.join("、")}`);
      }
      throw Error(`${errorText(error)}；已撤回本步的 ${moved.length} 项文件改动`);
    } finally {
      if (!keepBackup) await rm(staging, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
async function removeEmpty(path: string) {
  try { await rmdir(path); }
  catch (error: any) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
}
export function installOfficialFiles(root: string, spec: OfficialPackageSpec) { return change(resolve(root), spec, true); }
export function uninstallOfficialFiles(root: string, spec: OfficialPackageSpec) { return change(resolve(root), spec, false); }
