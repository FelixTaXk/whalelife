/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { temporaryDirectory } from "./temporary-directory.ts";

const { reviewCommunityIcon, inspectCommunityIcon } =
  await import(new URL("../market/tools/review-community-icon.mjs", import.meta.url).href);
const repository = "https://github.com/Example/sample", commit = "a".repeat(40);
const imageLink = repository + "/blob/" + commit + "/assets/图标.png";
const rawLink = "https://raw.githubusercontent.com/Example/sample/" + commit + "/assets/%E5%9B%BE%E6%A0%87.png";
const catalog = [
  "{", '  "official": [],', '  "community": [', "    {", '      "id": "sample",',
  '      "repository": "' + repository + '",', '      "verifiedReleases": [{"version":"0.2.0","dependencies":{}}]', "    },",
  '    {"id":"other","repository":"' + repository + '"}', "  ]", "}", "",
].join("\r\n");

function png(pixel = 0, width = 1): Buffer {
  function chunk(name: string, bytes: Buffer) {
    const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    const body = Buffer.concat([Buffer.from(name), bytes]);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([header, body, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = 8;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, pixel]))), chunk("IEND", Buffer.alloc(0))]);
}

async function fixture() {
  const market = await temporaryDirectory("whale-community-icon-");
  await mkdir(join(market, "assets"));
  const file = join(market, "catalog.json");
  await writeFile(file, catalog);
  return { market, file };
}

test("pinned review previews without writes, then applies just the icon and reuses shared assets", async () => {
  const { market, file } = await fixture();
  let bytes = png(), calls = 0;
  const request = async (url: string, opts: RequestInit) => {
    assert.equal(url, rawLink);
    assert.equal(opts.redirect, "error");
    assert.equal(opts.credentials, "omit");
    calls++;
    return new Response(Uint8Array.from(bytes));
  };
  const preview = await reviewCommunityIcon("sample", imageLink, { market, request });
  assert.equal(preview.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual([preview.width, preview.height, preview.sizeBytes, preview.previewUrl], [1, 1, bytes.length, rawLink]);
  assert.equal(await readFile(file, "utf8"), catalog);
  assert.deepEqual(await readdir(join(market, "assets")), []);
  const apply = { market, request, apply: true };
  await reviewCommunityIcon("sample", imageLink, apply);
  const first = await readFile(file, "utf8");
  assert.equal(first, catalog.replace('"id": "sample",', '"id": "sample",\r\n      "icon": "' + preview.icon + '",'));
  assert.deepEqual(await readFile(join(market, preview.icon)), bytes);
  await reviewCommunityIcon("sample", rawLink, apply);
  assert.equal(await readFile(file, "utf8"), first);
  await reviewCommunityIcon("other", rawLink, apply);
  const folder = join(market, "assets/community-icons");
  assert.equal((await readdir(folder)).length, 1);
  const shared = await readFile(file, "utf8");
  bytes = png(255);
  const next = await reviewCommunityIcon("sample", imageLink, apply);
  assert.notEqual(next.icon, preview.icon);
  assert.equal(await readFile(file, "utf8"), shared.replace(preview.icon, next.icon));
  assert.equal((await readdir(folder)).length, 2);
  assert.equal(calls, 5);
});

test("icon source must be from the named repository at an immutable commit", async () => {
  const { market, file } = await fixture();
  const request = () => assert.fail("unsupported URL must not be fetched");
  for (const url of [imageLink.replace(commit, "main"), imageLink.replace("/Example/", "/Someone/"),
    imageLink.replace("github.com", "images.example.org"), imageLink.replace("https:", "http:"),
    imageLink.replace("github.com", "user@github.com"), imageLink.replace(".png", ".svg")])
    await assert.rejects(reviewCommunityIcon("sample", url, { market, request, apply: true }));
  await assert.rejects(reviewCommunityIcon("missing", imageLink, { market, request, apply: true }));
  assert.equal(await readFile(file, "utf8"), catalog);
});

test("bad, truncated, oversized and redirected images leave the catalog unchanged", async () => {
  const { market, file } = await fixture();
  const badCRC = png(); badCRC[badCRC.length - 1] ^= 1;
  for (const bytes of [Buffer.from("not an image"), png(0, 1025), badCRC, png().subarray(0, -12),
    Buffer.concat([png(), Buffer.alloc(2)]), Buffer.alloc(1024 * 1024 + 1)])
    await assert.rejects(reviewCommunityIcon("sample", imageLink, {
      market, request: () => new Response(Uint8Array.from(bytes)), apply: true,
    }));
  assert.throws(() => inspectCommunityIcon(Buffer.alloc(10)));
  await assert.rejects(reviewCommunityIcon("sample", imageLink, {
    market, request: () => new Response(null, { status: 302 }), apply: true,
  }));
  assert.equal(await readFile(file, "utf8"), catalog);
  assert.deepEqual(await readdir(join(market, "assets")), []);
});

test("the command-line entry point resolves its own catalog independently of the working directory", async () => {
  const { market, file } = await fixture();
  const tools = join(market, "tools");
  await mkdir(tools);
  const script = join(tools, "review-community-icon.mjs"), mock = join(market, "mock.mjs");
  await copyFile(new URL("../market/tools/review-community-icon.mjs", import.meta.url), script);
  await writeFile(mock, `globalThis.fetch = () => new Response(Buffer.from("${png().toString("base64")}", "base64"));`);
  const run = (...flags: string[]) => JSON.parse(execFileSync(process.execPath,
    ["--import", pathToFileURL(mock).href, script, "sample", imageLink, ...flags], { cwd: tools, encoding: "utf8" }));
  assert.equal(run().applied, false);
  assert.equal(await readFile(file, "utf8"), catalog);
  const applied = run("--apply");
  assert.equal(applied.applied, true);
  assert.equal(JSON.parse(await readFile(file, "utf8")).community[0].icon, applied.icon);
});
