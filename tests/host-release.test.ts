/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { hostAssetName, hostReleaseRootFiles, latestHostRelease, stageHostRelease } from "../core/host-release.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const repo = "https://github.com/iinukami/whalelife";
const version = "0.10.0", url = repo + "/releases/tag/v" + version, filename = hostAssetName(version);
const assetURL = repo + "/releases/download/v" + version + "/" + filename;
const metadata = { tag_name: "v" + version, html_url: url, prerelease: false, draft: false,
  assets: [{ name: filename, state: "uploaded", browser_download_url: assetURL, size: 100, digest: "sha256:" + "a".repeat(64) }] };
const jsonResponse = (value: unknown): typeof fetch => async () => Response.json(value);
const release = (bytes: Buffer) => ({ version, url, size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") });

test("release checks accept only newer official, stable, digest-pinned host assets", async () => {
  const found = await latestHostRelease("0.9.30", async (input, init) => {
    assert.equal(String(input), "https://api.github.com/repos/iinukami/whalelife/releases/latest");
    assert.equal(init?.redirect, "error");
    return Response.json(metadata);
  });
  assert.deepEqual(found, { version, url, digest: "a".repeat(64), size: 100 });
  assert.equal(await latestHostRelease("0.10.0", jsonResponse(metadata)), null);
  assert.equal(await latestHostRelease("1.0.0", jsonResponse(metadata)), null);
  assert.equal(await latestHostRelease("0.1.0", async () => new Response(null, { status: 404 })), null);
  for (const flag of ["draft", "prerelease"]) assert.equal(await latestHostRelease("0.1.0", jsonResponse({ ...metadata, [flag]: true })), null);
  for (const overrides of [{ digest: null }, { digest: "sha256:no" }, { size: 0 }, { browser_download_url: repo }])
    await assert.rejects(latestHostRelease("0.1.0", jsonResponse({ ...metadata, assets: [{ ...metadata.assets[0], ...overrides }] })));
  await assert.rejects(latestHostRelease("0.1.0", async () => new Response(null, { status: 503 })), /503/);
});

test("invalid downloads and an archive outside the program allowlist leave staging empty", async () => {
  const root = await temporaryDirectory("whale-host-release-bad-");
  for (const path of ["plugins/gallery/index.ts", "config/config.json", "core/../config/x", "market/CON"]) {
    const bytes = gzipSync(JSON.stringify({ format: 1, version, files: [{ path, size: 1 }] }) + "\nx");
    const request: typeof fetch = async () => new Response(new Uint8Array(bytes));
    await assert.rejects(stageHostRelease(release(bytes), root, request), /路径/);
    await assert.rejects(stageHostRelease({ ...release(bytes), digest: "0".repeat(64) }, root, request), /SHA-256/);
  }
  let calls = 0;
  await assert.rejects(stageHostRelease(release(Buffer.from("a")), root, async () => {
    calls++; return Response.redirect("https://example.org/file");
  }), /跳转/);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(root), []);
});

test("build two identical releases from tracked source and extract a working independent program", async () => {
  const root = await temporaryDirectory("whale-host-bundle-");
  const source = join(root, "source"), unpacked = join(root, "slot"), out1 = join(root, "first"), out2 = join(root, "second");
  await mkdir(source); await mkdir(unpacked);
  const pkg = { name: "whalelife", version, type: "module" };
  const tracked: Record<string, string> = Object.fromEntries(hostReleaseRootFiles.map(p => [p, p]));
  Object.assign(tracked, { "package.json": JSON.stringify(pkg),
    "package-lock.json": JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { "": pkg } }),
    "core/index.ts": 'console.log("healthy")', "market/catalog.json": "{}", "market/official-releases.json": "[]" });
  for (const [path, value] of Object.entries(tracked)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), value);
  }
  execFileSync("git", ["init", "--quiet", source]);
  execFileSync("git", ["-C", source, "add", "--", ...Object.keys(tracked)], { stdio: "pipe" });
  await writeFile(join(source, "core", "private-local-file.ts"), "private");
  await mkdir(join(source, "config")); await writeFile(join(source, "config/config.json"), "private");
  const builder = fileURLToPath(new URL("../tools/build-host-release.mjs", import.meta.url));
  for (const out of [out1, out2]) execFileSync(process.execPath, [builder, out, source]);
  const bytes = await readFile(join(out1, filename));
  assert.deepEqual(bytes, await readFile(join(out2, filename)));
  await stageHostRelease(release(bytes), unpacked, async (input, init) => {
    assert.equal(init?.redirect, "manual");
    if (String(input) === assetURL) return Response.redirect("https://release-assets.githubusercontent.com/sample");
    assert.equal(String(input), "https://release-assets.githubusercontent.com/sample");
    return new Response(new Uint8Array(bytes));
  });
  assert.deepEqual(await readdir(join(unpacked, "core")), ["index.ts"]);
  assert(!(await readdir(unpacked)).includes("config"));
  assert.equal(execFileSync(process.execPath, [join(unpacked, "core/index.ts")], { encoding: "utf8" }).trim(), "healthy");
  await assert.rejects(stageHostRelease(release(bytes), unpacked), /空的暂存目录/);
});
