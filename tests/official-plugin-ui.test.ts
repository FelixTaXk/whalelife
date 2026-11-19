import { test } from "node:test";
import assert from "node:assert/strict";

const { renderOfficialShelf } = await import(new URL("../core/ui/official-plugins.js", import.meta.url).href);
const plugin = {
  id: "bilibili", name: "B 站", version: "1.2.0", installed: false, action: "install",
  label: "启用网上冲浪并安装 B 站插件", planKey: "preview-key", installation: "https://github.com/example/bilibili",
  steps: [
    { id: "surf", name: "网上冲浪", action: "enable", version: "1.0.0" },
    { id: "bilibili", name: "B 站", action: "install", version: "1.2.0" },
  ],
};

test("official cards show the approved dependency plan, version and one action", () => {
  const html = renderOfficialShelf({ officialPlugins: [plugin] });
  assert.match(html, /图库图片和标签/);
  assert.match(html, /启用<\/strong> 网上冲浪 <span>v1\.0\.0/);
  assert.match(html, /安装版本 v1\.2\.0/);
  assert.match(html, /data-key="preview-key"/);
  assert.match(html, /启用网上冲浪并安装 B 站插件/);
  assert.equal(html.match(/<button\b/g)?.length, 1);
  assert.match(renderOfficialShelf({ officialPlugins: [plugin], officialBusy: "bilibili" }), /disabled>.*正在安装/s);
});

test("blocked cards explain the reason without an action and show the installed version", () => {
  const html = renderOfficialShelf({ officialPlugins: [{
    ...plugin, action: null, installed: true, enabled: true, installedVersion: "1.1.5", steps: [],
    reason: "请先卸载依赖它的插件：<示例>。", installation: "javascript:invalid", upgradeUrl: "https://github.com/example/core",
  }] });
  assert.match(html, /已安装版本 v1\.1\.5/);
  assert.match(html, /请先卸载依赖它的插件：&lt;示例&gt;/);
  assert.match(html, /查看升级说明/);
  assert.doesNotMatch(html, /<button|javascript:invalid/);
});

test("runtime failures and blocked dependencies retain the saved enablement setting", () => {
  const installed = { ...plugin, installed: true, enabled: true };
  for (const [status, label] of [["failed", "加载失败"], ["blocked", "等待依赖"]]) {
    const html = renderOfficialShelf({ officialPlugins: [{ ...installed, status }] });
    assert.ok(html.includes("已安装 · " + label));
    assert.ok(html.includes("开关已启用"));
  }
  assert.ok(renderOfficialShelf({ officialPlugins: [installed] }).includes("已安装 · 已启用"));
  assert.ok(renderOfficialShelf({ officialPlugins: [{ ...installed, enabled: false }] }).includes("已安装 · 已停用"));
});

test("failed actions display the failing step and the exact rollback even when catalog refresh fails", () => {
  const state = { officialPlugins: [plugin], officialResult: {
    id: "bilibili", message: "安装 B 站失败", error: true, rolledBack: ["恢复网上冲浪为停用", "移除 <新文件>"],
  } };
  for (const html of [renderOfficialShelf(state), renderOfficialShelf({ ...state, officialReadError: "目录暂不可读" })]) {
    assert.match(html, /role="alert"/);
    assert.match(html, /安装 B 站失败/);
    assert.match(html, /<li>恢复网上冲浪为停用<\/li><li>移除 &lt;新文件&gt;<\/li>/);
  }
});
