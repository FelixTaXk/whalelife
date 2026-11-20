/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { boot } from "../core/index.ts";
import { CommunityPackages } from "../core/community-packages.ts";
import { reviewedCommunityEntries } from "../core/community-reviews.ts";

const [catalogFile, id, version, ...flags] = process.argv.slice(2);
if (!catalogFile || !id || !version || flags.some(flag => !["--install", "--serve"].includes(flag)) ||
    (flags.includes("--serve") && !flags.includes("--install")))
  throw Error("用法：node tools/trial-community-package.mjs <本地待审 catalog.json> <完整 ID> <版本> [--install [--serve]]");
const reviewed = reviewedCommunityEntries(JSON.parse(await readFile(catalogFile, "utf8")));
const base = fileURLToPath(new URL("../.artifacts/community-trials", import.meta.url));
await mkdir(base, {recursive:true});
if (await realpath(base) !== base) throw Error("试装目录使用了链接。");
const root = await mkdtemp(join(base, "trial-"));
const previousDirectory = process.cwd();
let app;
try {
  process.chdir(root); // Plugins using relative filesystem paths stay in the trial instance.
  const config = JSON.parse(await readFile(new URL("../config.example.json", import.meta.url), "utf8"));
  config.web = {host:"127.0.0.1", port:0};
  config.providers = [];
  config.models = [];
  config.log = {level:"error"};
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify(config), {flag:"wx"});
  app = await boot(root);
  // The draft catalog is visible only to this CLI's package manager.
  const packages = new CommunityPackages(app.runtime, reviewed);
  const { plugins } = await packages.list();
  const plan = plugins.find(p => p.id === id);
  if (plan?.action !== "install" || plan.version !== version)
    throw Error(plan?.reason || "当前宿主、平台与待审记录没有匹配指定版本的安装计划。");
  console.log(JSON.stringify({id, version, steps:plan.steps}, null, 2));
  if (flags.includes("--install")) {
    await packages.apply({id, action:"install", planKey:plan.planKey});
    const installed = app.runtime.list().find(p => p.id === id);
    if (installed?.status !== "active" || installed.version !== version) throw Error("试装后未按指定版本启用。");
    console.log(`试装通过，${id} ${version} 已在临时实例启用。`);
    if (flags.includes("--serve")) {
      const address = app.web.server.address();
      const prompt = createInterface({input:process.stdin, output:process.stdout});
      try { await prompt.question(`打开 http://127.0.0.1:${address.port}/ 验证插件功能。试用完按回车关闭并清理临时实例。\n`); }
      finally { prompt.close(); }
    }
  }
} finally {
  try { if (app) await app.close(); }
  finally {
    process.chdir(previousDirectory);
    if (dirname(root) !== base || await realpath(base) !== base || await realpath(root) !== root)
      throw Error("临时实例路径已变化，已停止清理。");
    await rm(root, {recursive:true, force:true, maxRetries:3, retryDelay:100});
  }
}
