import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPluginCompatibility, PluginCompatibilityError, PLUGIN_API_VERSION,
  SUPPORTED_PLUGIN_API_VERSIONS } from "../core/plugin-compatibility.ts";

test("package entry exposes API metadata without exporting implementation objects", async () => {
  const publicEntry = await import("whalelife");
  assert.deepEqual(Object.keys(publicEntry).sort(), ["PLUGIN_API_VERSION", "SUPPORTED_PLUGIN_API_VERSIONS"]);
  assert.equal(publicEntry.PLUGIN_API_VERSION, PLUGIN_API_VERSION);
});

test("legacy manifests and explicit supported v1 declarations remain compatible", () => {
  assert.equal(PLUGIN_API_VERSION, "1.0.0");
  assert.ok(Object.isFrozen(SUPPORTED_PLUGIN_API_VERSIONS));
  assert.doesNotThrow(() => assertPluginCompatibility({ version: "9.5.7" }));
  for (const apiVersion of ["1", "1.x", "1.0.0", "^1.0.0", "~1.0.0"])
    assert.doesNotThrow(() => assertPluginCompatibility({ apiVersion }));
});

test("minor and patch upgrades preserve minimum-compatible consumers", () => {
  for (const apiVersion of [undefined, "1", "1.x", "1.0.0", "^1.0.0", "1.2.0", "~1.2.0"])
    assert.doesNotThrow(() => assertPluginCompatibility({ apiVersion }, ["1.2.3"]));
  for (const apiVersion of ["1.2.4", "^1.3.0", "~1.1.0", "2", "2.0.0"])
    assert.throws(() => assertPluginCompatibility({ apiVersion }, ["1.2.3"]),
      (error: unknown) => error instanceof PluginCompatibilityError && error.code === "PLUGIN_API_INCOMPATIBLE");
});

test("a new host API may retain the original contract alongside newer versions", () => {
  for (const apiVersion of [undefined, "1.0.0", "^2.0.0"])
    assert.doesNotThrow(() => assertPluginCompatibility({ apiVersion }, ["1.4.0", "2.1.0"]));
  assert.throws(() => assertPluginCompatibility({ apiVersion: "3.x" }, ["1.4.0", "2.1.0"]), /未加载插件代码/);
});

test("malformed requirements are rejected instead of silently allowing unknown APIs", () => {
  for (const apiVersion of [null, 1, true, [], {}, "", "*", ">=1", "1.*", "1.0", "01", "1.00.0",
    "1.0.0-beta", "1.0.0+build", "1.0.0 || 2.0.0", " ^1.0.0", "1.0.0 ", "1.0.0\n", "9".repeat(60)])
    assert.throws(() => assertPluginCompatibility({ apiVersion }),
      (error: unknown) => error instanceof PluginCompatibilityError && error.code === "PLUGIN_API_INVALID");
  for (const manifest of [null, undefined, false, [], "manifest"])
    assert.throws(() => assertPluginCompatibility(manifest), /manifest 必须是对象/);
  assert.throws(() => assertPluginCompatibility({}, ["broken"]), /宿主 API 版本配置无效/);
});
