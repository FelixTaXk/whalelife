/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, createInflateRaw } from "node:zlib";
import { ensureCachedPackage, ensureOfficialPackage, type OfficialAsset } from "./official-package-download.ts";
import { inventoryOf } from "./official-package-files.ts";

interface Composition {
  sha256: string;
  sizeBytes: number;
  inventory: Uint8Array;
  packagePart: OfficialAsset;
  zipPart: OfficialAsset & { files: readonly { path: string; member: string }[] };
}

async function readAt(file: FileHandle, offset: number, length: number) {
  const bytes = Buffer.allocUnsafe(length);
  let pos = 0;
  while (pos < length) {
    const { bytesRead } = await file.read(bytes, pos, length - pos, offset + pos);
    if (!bytesRead) throw Error("上游 ZIP 提前结束。");
    pos += bytesRead;
  }
  return bytes;
}

interface ZipMember { method: number; flags: number; packed: number; offset: number; size: number }

// Only index the named members of a single-disk, non-ZIP64 archive. No ZIP paths are extracted to disk.
async function zipDirectory(file: FileHandle, length: number, wanted: Set<string>) {
  const tail = await readAt(file, Math.max(0, length - 65_557), Math.min(length, 65_557));
  let end = tail.length - 22;
  for (; end >= 0; end--) {
    if (tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length) break;
  }
  if (end < 0 || tail.readUInt32LE(end + 4) !== 0 ||
      tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10)) throw Error("上游 ZIP 中央目录无效。");
  const count = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), start = tail.readUInt32LE(end + 16);
  if (count === 0xffff || size > 32 * 1024 ** 2 || start + size !== length - tail.length + end)
    throw Error("上游 ZIP 中央目录大小或位置无效。");
  const directory = await readAt(file, start, size), members = new Map<string, ZipMember>();
  let offset = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > size || directory.readUInt32LE(offset) !== 0x02014b50) throw Error("上游 ZIP 条目无效。");
    const nameSize = directory.readUInt16LE(offset + 28);
    const next = offset + 46 + nameSize + directory.readUInt16LE(offset + 30) + directory.readUInt16LE(offset + 32);
    if (next > size) throw Error("上游 ZIP 条目越界。");
    const name = directory.toString("utf8", offset + 46, offset + 46 + nameSize);
    if (wanted.has(name)) {
      const flags = directory.readUInt16LE(offset + 8), method = directory.readUInt16LE(offset + 10);
      if (members.has(name) || (flags & ~0x80e) || (method !== 0 && method !== 8) ||
          directory.readUInt16LE(offset + 34) !== 0) throw Error("上游 ZIP 成员重复或格式不受支持：" + name);
      members.set(name, { method, flags, packed: directory.readUInt32LE(offset + 20),
        size: directory.readUInt32LE(offset + 24), offset: directory.readUInt32LE(offset + 42) });
    }
    offset = next;
  }
  if (offset !== size || members.size !== wanted.size) throw Error("上游 ZIP 缺少指定成员或目录不一致。");
  return { members, start };
}

async function* zipBytes(file: FileHandle, name: string, entry: ZipMember, limit: number) {
  const header = await readAt(file, entry.offset, 30), nameSize = header.readUInt16LE(26);
  const start = entry.offset + 30 + nameSize + header.readUInt16LE(28);
  if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags ||
      header.readUInt16LE(8) !== entry.method || start + entry.packed > limit ||
      !(await readAt(file, entry.offset + 30, nameSize)).equals(Buffer.from(name))) throw Error("上游 ZIP 成员位置无效：" + name);
  async function* compressed() {
    for (let n = 0; n < entry.packed; n += 64 * 1024)
      yield await readAt(file, start + n, Math.min(entry.packed - n, 64 * 1024));
  }
  if (entry.method === 8) yield* Readable.from(compressed()).compose(createInflateRaw());
  else yield* compressed();
}

// Consume exactly the next N bytes of the partial package, retaining at most one gunzip output chunk.
function byteReader(stream: Readable) {
  const iterator = stream[Symbol.asyncIterator]();
  let buffer: Buffer = Buffer.alloc(0);
  return {
    async *take(length: number) {
      while (length > 0) {
        if (!buffer.length) {
          const result = await iterator.next();
          if (result.done) throw Error("插件部分包提前结束。");
          buffer = result.value;
        }
        const n = Math.min(length, buffer.length);
        yield buffer.subarray(0, n);
        buffer = buffer.subarray(n);
        length -= n;
      }
    },
    async finish() {
      if (buffer.length || !(await iterator.next()).done) throw Error("插件部分包包含清单外的数据。");
    },
  };
}

export async function ensureComposedOfficialPackage(root: string, spec: Composition, shutdown?: AbortSignal): Promise<void> {
  shutdown?.throwIfAborted();
  if (new Set([spec.sha256, spec.packagePart.sha256, spec.zipPart.sha256]).size !== 3)
    throw Error("组装发行包的来源摘要不能重复。");
  const files = inventoryOf(Buffer.from(spec.inventory)).files;
  const members = new Map(spec.zipPart.files.map(x => [x.path, x.member]));
  const wanted = new Set(members.values());
  if (!members.size || members.size !== spec.zipPart.files.length || wanted.size !== members.size ||
      [...wanted].some(name => name.includes("\\") || name.split("/").some(p => !p || p === "." || p === "..")) ||
      files.filter(f => members.has(f.path)).length !== members.size) throw Error("上游 ZIP 成员映射与发行清单不一致。");
  const header = (list: typeof files) => Buffer.from(JSON.stringify({ format: 1, files: list }) + "\n");
  const partialHeader = header(files.filter(f => !members.has(f.path)));
  return ensureCachedPackage(root, spec, async (write, cache) => {
    await ensureOfficialPackage(root, spec.packagePart, shutdown);
    await ensureOfficialPackage(root, spec.zipPart, shutdown);
    shutdown?.throwIfAborted();
    const pathOf = (asset: OfficialAsset) => join(cache, asset.sha256 + ".wlpkg.gz");
    const zip = await open(pathOf(spec.zipPart), "r");
    try {
      const index = await zipDirectory(zip, spec.zipPart.sizeBytes, wanted);
      const partial = createReadStream(pathOf(spec.packagePart)).compose(createGunzip());
      try {
        const bytes = byteReader(partial);
        let offset = 0;
        for await (const chunk of bytes.take(partialHeader.length)) {
          if (!chunk.equals(partialHeader.subarray(offset, offset + chunk.length))) throw Error("插件部分包清单不匹配。");
          offset += chunk.length;
        }
        async function* assemble() {
          yield header(files);
          for (const file of files) {
            const name = members.get(file.path);
            const member = name && index.members.get(name);
            if (member && member.size !== file.size) throw Error("上游 ZIP 成员大小不匹配：" + file.path);
            const chunks = name ? zipBytes(zip, name, index.members.get(name)!, index.start) : bytes.take(file.size);
            const hash = createHash("sha256");
            let n = 0;
            for await (const chunk of chunks) {
              n += chunk.length;
              if (n > file.size) throw Error("组装内容超出文件大小：" + file.path);
              hash.update(chunk);
              yield chunk;
            }
            if (n !== file.size || hash.digest("hex") !== file.sha256) throw Error("组装文件校验失败：" + file.path);
          }
          await bytes.finish();
        }
        await pipeline(Readable.from(assemble()), createGzip({ level: 6 }), async compressed => {
          for await (const chunk of compressed) await write(chunk);
        }, { signal: shutdown });
      } finally {
        partial.destroy();
      }
    } finally {
      await zip.close();
    }
  });
}
