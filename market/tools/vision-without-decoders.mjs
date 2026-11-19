/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";

// The verified local vision 0.5.0 build (c95330d3...) includes the two Gyan
// binaries. Only its exact complement below is eligible for this release check.
const fullSha = "d5a0e8331722fefdd930c33465a29a6362a8d2961d10a241cab38d73558cf9dc";
const inventorySha = "2c54ea817813f91374dbcad21d26f62bfb6f048c1fc9752fe6e38903283c4448";
const decoderPaths = new Set(["ffmpeg.exe", "ffprobe.exe", "LICENSE", "README.txt"]
  .map(name => "runtime/ffmpeg/win32-x64/" + name));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const inventory = await readFile(new URL("../inventories/" + inventorySha + ".json", import.meta.url));
if (digest(inventory) !== inventorySha) throw Error("视听理解 0.5.0 完整文件清单校验失败");
const allFiles = JSON.parse(inventory).files;
const programFiles = allFiles.filter(file => !decoderPaths.has(file.path));
if (allFiles.length !== 386 || programFiles.length !== 382) throw Error("未找到指定的四项外部组件");

function header(files) {
  return Buffer.from(JSON.stringify({ format: 1, files }) + "\n");
}

// This is an offline tool for one pinned build. Decompression is bounded by
// its trusted inventory, and every member is checked without extracting paths.
function verifiedContents(compressed, files) {
  const expectedHeader = header(files);
  const expectedSize = files.reduce((size, file) => size + file.size, expectedHeader.length);
  const raw = gunzipSync(compressed, { maxOutputLength: expectedSize });
  if (raw.length !== expectedSize || !raw.subarray(0, expectedHeader.length).equals(expectedHeader)) {
    throw Error("安装包文件清单或内容长度不同");
  }
  const contents = [];
  let offset = expectedHeader.length;
  for (const file of files) {
    const bytes = raw.subarray(offset, offset + file.size);
    if (digest(bytes) !== file.sha256) throw Error("程序文件校验失败：" + file.path);
    contents.push(bytes);
    offset += file.size;
  }
  return contents;
}

const [command, input, output, ...extra] = process.argv.slice(2);
if (!input || extra.length || !((command === "build" && output) || (command === "check" && !output))) {
  throw Error("用法：vision-without-decoders.mjs build <完整本地包> <程序包输出文件> 或 check <程序包>");
}
const info = await lstat(input);
if (!info.isFile() || info.size > 88_664_256) throw Error("输入不是受支持的发行包");
let compressed = await readFile(input);
if (command === "build") {
  if (digest(compressed) !== fullSha) throw Error("输入必须是已核验的视听理解 0.5.0 完整本地包");
  const contents = verifiedContents(compressed, allFiles);
  const selected = contents.filter((_, index) => !decoderPaths.has(allFiles[index].path));
  compressed = gzipSync(Buffer.concat([header(programFiles), ...selected]), { level: 6 });
}
const parts = verifiedContents(compressed, programFiles);
// Reject hidden gzip headers, extra members or trailing data even when an
// inflater would ignore them. This also pins the canonical package encoding.
const canonical = gzipSync(Buffer.concat([header(programFiles), ...parts]), { level: 6 });
if (!compressed.equals(canonical)) throw Error("程序包压缩内容与规范封装不同");
if (command === "build") await writeFile(output, compressed, { flag: "wx" });
console.log(JSON.stringify({
  sha256: digest(compressed), sizeBytes: compressed.length, fileCount: programFiles.length,
  inventorySha256: digest(header(programFiles)), installedInventorySha256: inventorySha,
}));
