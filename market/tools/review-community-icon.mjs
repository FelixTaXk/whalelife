/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { crc32, inflateSync } from "node:zlib";

const maxBytes = 1024 * 1024;
const maxSide = 1024;
const signature = Buffer.from("89504e470d0a1a0a", "hex");
const marketDirectory = fileURLToPath(new URL("../", import.meta.url));

export function inspectCommunityIcon(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes || bytes.length < 45 ||
      !bytes.subarray(0, 8).equals(signature)) throw Error("图标须为不超过 1 MiB 的 PNG 文件。");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > maxSide || height > maxSide) throw Error("图标的宽和高须在 1 至 1024 像素之间。");
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] || bytes[27] || bytes[28] > 1)
    throw Error("PNG 像素格式无效。");
  const imageData = [];
  for (let start = 8; start + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(start), end = start + 8 + size;
    const type = bytes.toString("latin1", start + 4, start + 8);
    if (end + 4 > bytes.length || crc32(bytes.subarray(start + 4, end)) !== bytes.readUInt32BE(end))
      throw Error("PNG 数据块不完整或 CRC 校验失败。");
    if (start === 8 && (type !== "IHDR" || size !== 13)) throw Error("PNG 文件头无效。");
    if (start !== 8 && type === "IHDR") throw Error("PNG 文件头重复。");
    if (type === "IDAT") imageData.push(bytes.subarray(start + 8, end));
    if (type === "IEND") {
      if (size || end + 4 !== bytes.length || !imageData.length) throw Error("PNG 图像数据或文件结尾无效。");
      // Check the compressed stream without allocating unbounded image data.
      if (!inflateSync(Buffer.concat(imageData), { maxOutputLength: (width * 8 + 16) * height + 128 }).length)
        throw Error("PNG 缺少图像数据。");
      return { width, height, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    start = end + 4;
  }
  throw Error("PNG 缺少文件结尾。");
}

function pinnedImageURL(repository, input) {
  const expected = new URL(repository), source = new URL(input);
  const parts = source.pathname.slice(1).split("/");
  if (expected.origin !== "https://github.com" || source.protocol !== "https:" || source.username ||
      source.password || source.port || !["github.com", "raw.githubusercontent.com"].includes(source.hostname) ||
      ("/" + parts.slice(0, 2).join("/")).toLowerCase() !== expected.pathname.replace(/\/$/, "").toLowerCase())
    throw Error("图标必须来自该插件在目录中登记的 GitHub 仓库。");
  const [owner, repo] = parts.splice(0, 2);
  if (source.hostname === "github.com" && parts.shift() !== "blob") throw Error("请提供 GitHub 图片文件的永久链接。");
  const commit = parts.shift();
  if (!/^[0-9a-f]{40}$/i.test(commit || "") || !parts.length) throw Error("请使用固定到完整提交 SHA 的图标链接。");
  const path = parts.map(part => {
    const decoded = decodeURIComponent(part);
    if (!decoded || decoded === "." || decoded === ".." || /[\\/\x00-\x1f\x7f]/.test(decoded)) throw Error("图标文件路径无效。");
    return encodeURIComponent(decoded);
  }).join("/");
  if (!path.toLowerCase().endsWith(".png")) throw Error("请提供 PNG 图片文件链接。");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path}`;
}

async function download(url, request) {
  const response = await request(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(20000) });
  if (response.status !== 200 || !response.body) throw Error("读取图标失败，HTTP " + response.status);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw Error("PNG 图标超过 1 MiB。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function entryFor(text, id) {
  const matches = JSON.parse(text).community.filter(entry => entry.id === id);
  if (matches.length !== 1) throw Error("请先在社区目录中核实插件 ID：" + id);
  return matches[0];
}

// Use source ranges to retain formatting, including inline dependency and release records.
async function setIcon(text, id, icon) {
  const { parseDocument } = await import("yaml");
  const doc = parseDocument(text);
  const index = JSON.parse(text).community.findIndex(entry => entry.id === id);
  const row = doc.getIn(["community", index], true);
  const existing = row.get("icon", true);
  if (existing) return text.slice(0, existing.range[0]) + JSON.stringify(icon) + text.slice(existing.range[1]);
  const pair = row.items.find(item => item.key.value === "id");
  const indent = /\r?\n[\t ]*$/.exec(text.slice(0, pair.key.range[0]))?.[0] ?? " ";
  const colon = text.slice(pair.key.range[1], pair.value.range[0]);
  const at = pair.value.range[1];
  return text.slice(0, at) + "," + indent + '"icon"' + colon + JSON.stringify(icon) + text.slice(at);
}

async function replaceFile(path, data) {
  const stage = path + "." + randomUUID() + ".tmp";
  try { await writeFile(stage, data, { flag: "wx" }); await rename(stage, path); }
  finally { await rm(stage, { force: true }); }
}

export async function reviewCommunityIcon(id, input, { market = marketDirectory, request = fetch, apply = false } = {}) {
  const root = await realpath(market), catalogFile = join(root, "catalog.json");
  const before = entryFor(await readFile(catalogFile, "utf8"), id);
  const previewUrl = pinnedImageURL(before.repository, input);
  const bytes = await download(previewUrl, request);
  const info = inspectCommunityIcon(bytes);
  const icon = "assets/community-icons/" + info.sha256 + ".png";
  const result = { id, previewUrl, ...info, icon, applied: apply };
  if (!apply) return result;

  const lockPath = catalogFile + ".icon-review.lock";
  const lock = await open(lockPath, "wx");
  try {
    const original = await readFile(catalogFile, "utf8");
    const current = entryFor(original, id);
    if (before.repository !== current.repository || (before.icon !== current.icon && current.icon !== icon))
      throw Error("下载期间插件条目已经变更，请重新核对图标。");
    const next = current.icon === icon ? original : await setIcon(original, id, icon);
    const expected = JSON.parse(original);
    expected.community.find(entry => entry.id === id).icon = icon;
    if (!isDeepStrictEqual(JSON.parse(next), expected)) throw Error("图标目录更新无效。");
    const assets = join(root, "assets"), folder = join(assets, "community-icons");
    if (await realpath(assets) !== assets) throw Error("商店资源目录包含链接。");
    await mkdir(folder, { recursive: true });
    if (await realpath(folder) !== folder) throw Error("图标目录包含链接。");
    const file = join(root, icon);
    const stat = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (stat) {
      if (!stat.isFile() || !bytes.equals(await readFile(file))) throw Error("已存在的图标与摘要不一致。");
    } else await replaceFile(file, bytes);
    if (next !== original) {
      if (original !== await readFile(catalogFile, "utf8")) throw Error("目录已变更，请重试。");
      await replaceFile(catalogFile, next);
    }
    return result;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [id, url, ...args] = process.argv.slice(2);
  if (!id || !url || args.length > 1 || (args.length && args[0] !== "--apply"))
    throw Error("用法：node market/tools/review-community-icon.mjs <插件 ID> <固定提交的 GitHub 图片链接> [--apply]");
  console.log(JSON.stringify(await reviewCommunityIcon(id, url, { apply: args[0] === "--apply" }), null, 2));
}
