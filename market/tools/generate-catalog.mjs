/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { catalog } from "./check-official.mjs";

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--check"),
  "Usage: node market/tools/generate-catalog.mjs [--check]");
const check = args.includes("--check");

function markdownText(value) {
  // Table cells contain literal author-supplied text, including pipes and brackets.
  return value.replace(/\s+/gu, " ").trim().replace(/[\\&<>\[\]*_~\x60|$]/gu,
    char => "&#" + char.codePointAt(0) + ";");
}

function destination(url) {
  return "<" + new URL(url).href.replaceAll("|", "%7C").replaceAll("&", "&amp;") + ">";
}

const names = new Map([...catalog.official, ...catalog.community].map(entry => [entry.id, entry.name]));
function table(entries) {
  const rows = ["| 插件 | 收录版本 | 作者 | 用途 | 必需插件 | 相关链接 |", "| --- | --- | --- | --- | --- | --- |"];
  for (const entry of entries) {
    const dependencies = entry.dependencies.map(id => names.get(id) || id).join("、") || "—";
    const links = [
      "[安装说明](" + destination(entry.installation) + ")",
      "[原仓库 · 加星](" + destination(entry.repository) + ")",
      "[反馈](" + destination(entry.feedback) + ")",
    ];
    const cells = [entry.name, entry.version ? "v" + entry.version : "版本未提供", entry.author, entry.description, dependencies].map(markdownText);
    rows.push("| " + [...cells, links.join(" · ")].join(" | ") + " |");
  }
  return rows.join("\n");
}

const community = [...catalog.community].sort((a, b) =>
  b.stars - a.stars || b.collected.localeCompare(a.collected) || a.id.localeCompare(b.id));
const readme = [
  "<!-- Generated from catalog.json by tools/generate-catalog.mjs. -->",
  "# WhaleLife 插件市场",
  "在这里找到作者、安装说明和反馈渠道。启动 WhaleLife 后，可从概览或「插件管理」[打开插件商店](http://127.0.0.1:9270/#market)，关闭商店即可回到原页。已安装的官方插件可在「插件管理」中设置或卸载。",
  "## 官方插件",
  "以下插件由 WhaleLife 团队开发和维护。",
  table(catalog.official),
  "## 社区插件",
  community.length ? table(community) : "目前还没有收录的社区插件。",
  "社区插件由原作者维护。首次[提交收录申请](https://github.com/iinukami/whalelife/issues/new?template=submit-plugin.yml)时附上公开仓库链接和一句话介绍，收录后可以关闭 Issue。后续在作者仓库升版并发布正式 GitHub Release 即可，维护者会收到发版通知。每个新版附件单独审核。商店提供适合本机的已审核安装包或作者的安装说明。[社区插件打包与审核说明](community-packages.md)",
  "<details>\n<summary>维护目录</summary>",
  "条目资料在 [catalog.json](catalog.json) 维护。在主仓根目录运行 `node market/tools/generate-catalog.mjs` 更新这个页面与随主干提供的离线快照。提交前运行 `node market/tools/generate-catalog.mjs --check` 检查生成物和[官方插件发行清单](official-releases.json)。",
  "商店显示条目的 `version`。提供一键安装的条目填写最新已审核发行包的版本，仅提供安装说明的条目可填写已核对的作者发布版本。暂无记录时省略该字段，商店会显示「版本未提供」。",
  "官方插件按宿主版本、操作系统和架构匹配。每个可安装版本都在发行清单中固定包的大小和 SHA-256。维护者可按[官方安装包构建说明](official-builds.md)核验发行物。`parentId` 记录父插件，`requiredPlugins` 记录直接依赖。",
  [
    "| 字段 | 说明 |",
    "| --- | --- |",
    "| `version`、`hostRange` | 插件版本与适用的 WhaleLife 正式版本。单写 `0.1.0` 表示最低实测宿主。可用 `>=0.1.0 <0.2.0` 或 `<=` 上界限制范围，用 `=0.1.0` 指定单一版本。 |",
    "| `platform`、`arch` | 适用系统和架构，使用 Node.js 的标识。 |",
    "| `dependencies` | 该发行版本依赖的插件标识到兼容范围的映射。 |",
    "| `sourceCommit`、`sha256` | 公开源码提交和对应安装包的 SHA-256。已有发布资产可另附 `assetUrl`。 |",
    "| `delivery`、`recognitionOnly` | 本机构建见 `local-build`；`recognitionOnly` 条目以历史程序清单的 SHA-256 识别手装版本。 |",
    "| `fileCount`、`sizeBytes` | 发行文件数与安装包或历史清单的字节数。 |",
    "| `verification` | 构建、校验方法与验收范围。 |",
  ].join("\n"),
  "社区条目的 `collected` 为首次收录日期（YYYY-MM-DD），`stars` 为原仓库的 GitHub 星标数。确认仓库删除或转为私有后，撤下公开条目，在原投稿 Issue 记录原因及首次收录日期。作者提供新的公开仓库并通过核对后，可按原收录日期恢复。",
  "</details>",
  "<sub>WhaleLife 交流 QQ 群 962935021</sub>",
].join("\n\n") + "\n";

const header = `/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 * Generated from catalog.json by tools/generate-catalog.mjs.
 */`;
const snapshot = header + "\nwindow.WHALELIFE_CATALOG = " + JSON.stringify(catalog, null, 2) + ";\n";
for (const [name, content] of [["README.md", readme], ["assets/catalog.js", snapshot]]) {
  const file = new URL("../" + name, import.meta.url);
  if (check) {
    assert.equal(readFileSync(file, "utf8").replaceAll("\r\n", "\n"), content, name + " is stale");
  } else {
    writeFileSync(file, content);
  }
}
