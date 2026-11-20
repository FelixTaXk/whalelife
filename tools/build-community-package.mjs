/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { parse } from "yaml";
import { digestFile, inventoryOf } from "../core/official-package-files.ts";
import { assertPluginCompatibility } from "../core/plugin-compatibility.ts";

const slug = /^[a-z][a-z0-9-]*$/;
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const persistent = new Set(["data", "config", "config.json", "config.yml", "config.yaml", "settings.json", "logs", "backups"]);
function permitted(path) {
  const parts = path.toLowerCase().split("/");
  let start = 0;
  while (parts[start] === "sub" && start + 2 < parts.length) start += 2;
  const file = parts.at(-1);
  return !persistent.has(parts[start]) && !parts.some(p => p.startsWith(".")) &&
    !/^(?:credentials?|cookies?|secrets?|tokens?)(?:\.(?:json|txt|ya?ml|sqlite|db))?$/.test(file) &&
    !/^(?:id_rsa|id_ecdsa|id_ed25519)$|\.(?:key|pfx|p12|ppk|jks|kdbx|sqlite|db|log|wlpkg\.gz)$/i.test(file);
}

async function programFiles(source, fromDirectory) {
  if (!fromDirectory) {
    const git = (...args) => execFileSync("git", ["-C", source, ...args], {encoding:"utf8", maxBuffer:32 * 1024 ** 2});
    git("diff", "--no-ext-diff", "--quiet", "HEAD", "--", ".");
    return git("ls-files", "--stage", "-z", "--", ".").split("\0").filter(Boolean).flatMap(entry => {
      const match = /^(100644|100755) [0-9a-f]+ 0\t([\s\S]+)$/.exec(entry);
      if (!match) throw Error("发行源码含链接、子模块或未解决的冲突，请改用准备好的发行目录。");
      return permitted(match[2]) ? [match[2]] : [];
    });
  }
  const files = [];
  async function visit(prefix) {
    for (const entry of await readdir(join(source, prefix), {withFileTypes:true})) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      if (!permitted(path)) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw Error("发行目录含链接或特殊文件：" + path);
    }
  }
  await visit("");
  return files;
}

async function ordinaryFile(root, path) {
  const target = join(root, path);
  if (await realpath(target) !== target || !(await lstat(target)).isFile()) throw Error("文件使用了链接：" + path);
  return target;
}

async function readManifest(root, path) {
  const manifest = parse(await readFile(await ordinaryFile(root, path), "utf8"));
  if (!manifest || ["id", "name", "description", "version"].some(key => typeof manifest[key] !== "string") ||
      !slug.test(manifest.id) || (manifest.sub !== undefined && (!Array.isArray(manifest.sub) ||
      manifest.sub.some(id => typeof id !== "string" || !slug.test(id)))))
    throw Error("请核对插件清单中的 ID、名称、说明、版本和子插件声明：" + path);
  assertPluginCompatibility(manifest);
  return manifest;
}

export async function buildCommunityPackage(sourceDirectory, outputDirectory, {fromDirectory = false, id} = {}) {
  const source = await realpath(sourceDirectory), output = resolve(outputDirectory);
  await mkdir(output, {recursive:true});
  const distance = relative(source, await realpath(output));
  if (!isAbsolute(distance) && distance !== ".." && !distance.startsWith(".." + sep)) throw Error("请选择插件目录以外的输出位置。");
  const paths = (await programFiles(source, fromDirectory)).sort();
  if (!paths.includes("plugin.yaml") || !paths.includes("index.ts")) throw Error("安装包根目录必须含 plugin.yaml 和 index.ts。");
  const rootManifest = await readManifest(source, "plugin.yaml");
  const runtimeId = id ?? rootManifest.id, version = rootManifest.version;
  if (typeof runtimeId !== "string" || !runtimeId.split("/").every(part => slug.test(part)) ||
      runtimeId.split("/").at(-1) !== rootManifest.id || typeof version !== "string" || !stable.test(version))
    throw Error("运行 ID 或正式版本号与 plugin.yaml 不匹配。");

  const manifests = new Map([["", rootManifest]]);
  const children = new Set();
  for (const path of paths) {
    const parts = path.split("/");
    let prefix = "";
    for (let i = 0; parts[i] === "sub"; i += 2) {
      if (!slug.test(parts[i+1] ?? "") || i+2 >= parts.length) throw Error("子插件路径无效：" + path);
      prefix += "sub/" + parts[i+1] + "/";
      children.add(prefix);
    }
  }
  const selected = new Set(paths);
  for (const prefix of [...children].sort()) {
    const parts = prefix.slice(0,-1).split("/"), parent = parts.slice(0,-2).join("/");
    const manifestPath = prefix + "plugin.yaml";
    if (!selected.has(manifestPath) || !selected.has(prefix + "index.ts")) throw Error("包内子插件缺少清单或入口：" + prefix);
    const manifest = await readManifest(source, manifestPath);
    const parentManifest = manifests.get(parent ? parent + "/" : "");
    if (manifest.id !== parts.at(-1) || (parentManifest.sub && !parentManifest.sub.includes(manifest.id)))
      throw Error("子插件 ID 与目录或父插件声明不一致：" + prefix);
    manifests.set(prefix, manifest);
  }

  const files = [];
  for (const path of paths) {
    const target = await ordinaryFile(source, path), size = (await lstat(target)).size;
    files.push({path, size, sha256:await digestFile(target, size, true)});
  }
  const header = Buffer.from(JSON.stringify({format:1, files}));
  if (header.length > 32 * 1024 ** 2) throw Error("发行包的文件清单过大。");
  inventoryOf(header);
  async function* payload() {
    yield header;
    yield Buffer.from("\n");
    for (const file of files) {
      const hash = createHash("sha256");
      let tail = "";
      for await (const chunk of createReadStream(await ordinaryFile(source, file.path))) {
        const text = tail + chunk.toString("latin1");
        if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) throw Error("文件内含私钥标记：" + file.path);
        tail = text.slice(-96);
        hash.update(chunk);
        yield chunk;
      }
      if (hash.digest("hex") !== file.sha256) throw Error("打包期间文件已变更：" + file.path);
    }
  }
  const filename = runtimeId.replaceAll("/", "-") + "-" + version + ".wlpkg.gz";
  const asset = join(output, filename), temp = join(output, ".package-" + randomUUID());
  try {
    await pipeline(Readable.from(payload()), createGzip({level:9}), createWriteStream(temp, {flags:"wx"}));
    const sizeBytes = (await lstat(temp)).size;
    if (sizeBytes > 2 * 1024 ** 3) throw Error("发行包超过 2 GiB。");
    const sha256 = await digestFile(temp, sizeBytes, true);
    await link(temp, asset);
    const bundledPluginIds = [...children].sort().map(prefix => runtimeId + "/" + prefix.split("/").filter((_,i) => i % 2).join("/"));
    return {id:runtimeId, version, filename, sizeBytes, sha256, bundledPluginIds, files:paths};
  } finally {
    await unlink(temp).catch(e => { if (e.code !== "ENOENT") throw e; });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, output, ...flags] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--from-dir") options.fromDirectory = true;
    else if (flags[i] === "--id" && flags[i+1]) options.id = flags[++i];
    else throw Error("未知或缺少参数：" + flags[i]);
  }
  if (!source || !output) throw Error("用法：node tools/build-community-package.mjs <插件目录> <输出目录> [--from-dir] [--id 父/子]");
  console.log(JSON.stringify(await buildCommunityPackage(source, output, options), null, 2));
}
