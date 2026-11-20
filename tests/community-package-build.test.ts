/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { inventoryOf } from "../core/official-package-files.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const script = fileURLToPath(new URL("../tools/build-community-package.mjs", import.meta.url));
const digest = (file: Buffer) => createHash("sha256").update(file).digest("hex");
function build(source: string, out: string, ...flags: string[]) {
  return JSON.parse(execFileSync(process.execPath, [script, source, out, ...flags], {encoding:"utf8", stdio:"pipe"}));
}

test("社区构建器从固定 Git 检出与独立发行目录生成同格式包，避免带入本机用户数据", async () => {
  const root = await temporaryDirectory("whale-community-build-"), source = join(root, "fixture");
  for (const name of ["", "sub/calendar", "sub/calendar/data", "data", ".github"]) await mkdir(join(source,name), {recursive:true});
  const files: Record<string,string> = {
    "plugin.yaml":"id: demo\nname: 示例\ndescription: 示例\nversion: 1.2.3\nsub: [calendar]\n", "index.ts":"export function apply() {}\n",
    "sub/calendar/plugin.yaml":"id: calendar\nname: 日历\ndescription: 日历\nversion: 1.2.0\n", "sub/calendar/index.ts":"export function apply() {}\n",
    "data/tags.txt":"private", "sub/calendar/data/plan.txt":"private", ".env":"private", "credentials.json":"private",
    "key.pem":"-----BEGIN PRIVATE KEY-----\nsecret\n", ".github/workflow.md":"generated",
  };
  for (const [path,content] of Object.entries(files)) await writeFile(join(source,path), content);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, "-c", "core.autocrlf=false", ...args], {stdio:"pipe"});
  git("init", "--quiet");
  git("add", "plugin.yaml", "index.ts", "sub", "data", ".env", ".github", "credentials.json");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@invalid.example", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "sample");

  const out = join(root, "package"), result = build(source, out, "--id", "parent/demo");
  const bytes = await readFile(join(out, result.filename)), raw = gunzipSync(bytes), split = raw.indexOf(10);
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.sha256, digest(bytes));
  assert.deepEqual(result.bundledPluginIds, ["parent/demo/calendar"]);
  const entries = inventoryOf(raw.subarray(0, split)).files;
  assert.deepEqual(entries.map(file => file.path), ["index.ts", "plugin.yaml", "sub/calendar/index.ts", "sub/calendar/plugin.yaml"]);
  let offset = split+1;
  for (const file of entries) {
    const body = raw.subarray(offset, offset + file.size);
    assert.equal(file.sha256, digest(body)); assert.equal(body.toString(), files[file.path]); offset += body.length;
  }
  assert.equal(offset, raw.length);

  const staged = join(root, "dist"), otherOut = join(root, "other");
  await mkdir(join(staged,"sub/calendar"), {recursive:true});
  for (const [path,body] of Object.entries(files)) if (result.files.includes(path)) await writeFile(join(staged,path), body);
  assert.equal(build(staged, otherOut, "--from-dir", "--id", "parent/demo").sha256, result.sha256);
  assert.throws(() => build(staged, otherOut, "--from-dir", "--id", "parent/demo"), /EEXIST/);
  assert.deepEqual(await readFile(join(otherOut, result.filename)), bytes);
  await mkdir(join(staged, "node_modules/demo-lib"), {recursive:true});
  await writeFile(join(staged, "node_modules/demo-lib/package.json"), '{"name":"demo-lib","version":"1.0.0"}');
  assert.ok(build(staged, join(root,"with-runtime"), "--from-dir").files.includes("node_modules/demo-lib/package.json"));
  await writeFile(join(staged, "accidental.txt"), files["key.pem"]);
  const refused = join(root, "refused");
  assert.throws(() => build(staged, refused, "--from-dir"), /私钥/);
  assert.deepEqual(await readdir(refused), []);
});

test("维护者可在发布目录前用本地草稿预览并试装同一份发行包", async () => {
  const root = await temporaryDirectory("whale-community-preview-");
  const catalog = join(root, "draft.json");
  const repo = "https://github.com/example/sample";
  const source = join(root,"source"), out = join(root,"release");
  await mkdir(source);
  await writeFile(join(source,"plugin.yaml"), "id: sample\nname: 示例\ndescription: 示例\nversion: 1.2.0\n");
  await writeFile(join(source,"index.ts"), "export function apply() {}\n");
  const pkg = build(source, out, "--from-dir");
  const url = repo + "/releases/download/v1.2.0/" + pkg.filename;
  const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const entry = {id:"sample", name:"示例", author:"example", description:"测试", repository:repo,
    installation:repo + "/blob/main/README.md", feedback:repo + "/issues", dependencies:[], collected:"2026-11-21", stars:0,
    verifiedReleases:[{version:"1.2.0", hostRange:version, platform:"any", arch:"any", sizeBytes:pkg.sizeBytes,
      sha256:pkg.sha256, assetUrl:url, dependencies:{}}]};
  await writeFile(catalog, JSON.stringify({official:[],community:[entry]}));
  const trial = fileURLToPath(new URL("../tools/trial-community-package.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [trial, catalog, "sample", "1.2.0"], {encoding:"utf8",stdio:"pipe"});
  const plan = JSON.parse(output);
  assert.equal(plan.id, "sample");
  assert.ok(plan.steps.some((step: {id:string;action:string}) => step.id === "sample" && step.action === "install"));
  const fixture = join(root, "release-fixture.mjs");
  await writeFile(fixture, `import { readFile } from "node:fs/promises";
    globalThis.fetch = async input => {
      if (String(input) !== ${JSON.stringify(url)}) throw Error("unexpected request");
      return new Response(await readFile(${JSON.stringify(join(out,pkg.filename))}), {headers:{"Content-Length":"${pkg.sizeBytes}"}});
    };`);
  const installed = execFileSync(process.execPath, ["--import", pathToFileURL(fixture).href, trial, catalog, "sample", "1.2.0", "--install"],
    {encoding:"utf8", stdio:"pipe", timeout:30_000});
  assert.match(installed, /sample 1\.2\.0 已在临时实例启用/);
  await writeFile(catalog, JSON.stringify({official:[{id:"sample"}], community:[entry]}));
  assert.throws(() => execFileSync(process.execPath, [trial, catalog, "sample", "1.2.0"], {stdio:"pipe"}), /重名/);
});
