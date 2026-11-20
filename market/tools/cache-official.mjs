/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const defaultCache = join(root, ".artifacts/official-packages");
const sha = () => createHash("sha256");
const readJSON = async file => JSON.parse(await readFile(file, "utf8"));
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
async function digest(file) {
  const hash = sha();
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest("hex");
}

// Read only files explicitly named by the plugin's own build tool.
async function inventory(directory, plugin, release) {
  const manifest = join(directory, "BUILD.json");
  const build = await readJSON(manifest);
  if (build.version !== release.version || (plugin.id === "qq" && build.mode !== "desktop"))
    throw Error("构建版本或 QQ 桌面模式不匹配");
  const files = Array.isArray(build.files)
    ? build.files.map(item => ({ path: item.path, sha256: item.sha256 }))
    : Object.entries(build.files).map(([path, sha256]) => ({ path, sha256 }));
  files.push({ path: "BUILD.json", sha256: await digest(manifest) });
  files.sort(byPath);
  const seen = new Set();
  for (const file of files) {
    const name = file.path;
    const parts = name.split("/");
    if (/[\\:\x00-\x1f]/u.test(name) || parts.some(p => !p || p === "." || p === "..") ||
        /^(?:data|config|logs|\.git|\.artifacts)(?:\/|$)/i.test(name) ||
        /^sub\/(?:[^/]+\/sub\/)*[^/]+\/(?:data|config|logs)(?:\/|$)/i.test(name) ||
        plugin.preserve?.some(path => path.toLowerCase() === name.toLowerCase()) ||
        seen.has(name.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw Error("不安全或重复的发行文件路径：" + name);
    const absolute = join(directory, ...parts);
    if (await realpath(absolute) !== absolute || !(await lstat(absolute)).isFile())
      throw Error("发行清单包含链接或非普通文件：" + name);
    seen.add(name.toLowerCase());
    file.size = (await stat(absolute)).size;
  }
  for (const name of ["plugin.yaml", "index.ts", "license", "notice.md", "third_party_notices.md"]) {
    if (!seen.has(name)) throw Error("发行物缺少 " + name);
  }
  return files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
}

export async function cacheBuild({ plugin, release, checkout, cache }) {
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== release.sourceCommit ||
      git("status", "--porcelain", "--untracked-files=no"))
    throw Error("请使用清单指定提交的干净插件源码");
  const directory = await realpath(join(checkout, "dist", plugin.id));
  if (directory !== join(await realpath(checkout), "dist", plugin.id)) throw Error("构建目录不能是链接");
  const files = await inventory(directory, plugin, release);
  async function* bytes() {
    yield Buffer.from(JSON.stringify({ format: 1, files }) + "\n");
    for (const file of files) {
      const hash = sha();
      let size = 0;
      for await (const chunk of createReadStream(join(directory, ...file.path.split("/")))) {
        hash.update(chunk);
        size += chunk.length;
        yield chunk;
      }
      if (size !== file.size || hash.digest("hex") !== file.sha256)
        throw Error("文件与插件构建清单不符：" + file.path);
    }
  }
  await mkdir(cache, { recursive: true });
  const temporary = join(cache, ".building-" + randomUUID());
  const hash = sha();
  try {
    await pipeline(Readable.from(bytes()), createGzip({ level: 6 }), new Transform({
      transform(chunk, _, callback) { hash.update(chunk); callback(null, chunk); },
    }), createWriteStream(temporary, { flags: "wx" }));
    const sha256 = hash.digest("hex");
    const sizeBytes = (await stat(temporary)).size;
    if (release.sha256 && (sha256 !== release.sha256 || sizeBytes !== release.sizeBytes ||
        files.length !== release.fileCount)) throw Error("本机构建与已核验发行物不同");
    const target = join(cache, sha256 + ".wlpkg.gz");
    try {
      await link(temporary, target);
    } catch (error) {
      if (error.code !== "EEXIST" || !(await lstat(target)).isFile() || await digest(target) !== sha256)
        throw error;
    }
    return { sha256, fileCount: files.length, sizeBytes };
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [id, checkout, cache] = process.argv.slice(2);
  if (!id || !checkout || process.argv.length > 5)
    throw Error("用法：node market/tools/cache-official.mjs 插件ID 插件源码目录 [缓存目录]");
  const catalog = await readJSON(join(root, "market/official-releases.json"));
  const plugin = catalog.plugins.find(entry => entry.id === id);
  const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const release = plugin?.verifiedReleases.find(entry => !entry.recognitionOnly && entry.sourceCommit === commit &&
    entry.platform === process.platform && entry.arch === process.arch);
  if (!release?.sha256) throw Error("没有为当前平台核验此版本");
  const result = await cacheBuild({ plugin, release, checkout: resolve(checkout), cache: resolve(cache ?? defaultCache) });
  console.log(id, release.version, result.sha256, result.fileCount + " 个文件", result.sizeBytes + " 字节");
}
