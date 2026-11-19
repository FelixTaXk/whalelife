/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const context = { window: {}, URL };
runInNewContext(read("../assets/catalog-validation.js"), context);
export const catalog = JSON.parse(read("../catalog.json"));
assert.ok(context.window.isWhaleLifeCatalog(catalog), "Invalid plugin catalog");
const { official } = catalog;
const manifest = JSON.parse(read("../official-releases.json"));

assert.equal(manifest.schemaVersion, 1);
const ids = Array.from(official, plugin => plugin.id);
assert.equal(new Set(ids).size, ids.length, "Duplicate official plugin id");
assert.deepEqual(manifest.plugins.map(plugin => plugin.id), ids, "Catalog and manifest order differ");

for (const [index, plugin] of manifest.plugins.entries()) {
  const card = official[index];
  assert.equal(plugin.name, card.name);
  assert.equal(plugin.repository, card.repository);
  assert.deepEqual(plugin.requiredPlugins, Array.from(card.dependencies));
  const repo = new URL(plugin.repository);
  assert.ok(plugin.requiredPlugins.every(id => ids.includes(id) && id !== plugin.id));
  assert.ok(plugin.parentId === null || plugin.requiredPlugins.includes(plugin.parentId));
  assert.ok(Array.isArray(plugin.verifiedReleases));
  for (const release of plugin.verifiedReleases) {
    for (const key of ["version", "hostRange", "platform", "arch", "verification"]) {
      assert.ok(typeof release[key] === "string" && release[key].trim(), plugin.id + ": missing " + key);
    }
    const asset = new URL(release.assetUrl);
    assert.equal(asset.origin, repo.origin);
    assert.ok(asset.pathname.startsWith(repo.pathname + "/releases/download/"));
    assert.match(release.sha256, /^[a-f0-9]{64}$/i);
    assert.ok(release.dependencies && typeof release.dependencies === "object" && !Array.isArray(release.dependencies));
    for (const [dep, range] of Object.entries(release.dependencies)) {
      assert.ok(ids.includes(dep) && dep !== plugin.id && typeof range === "string" && range.trim());
    }
  }
}
console.log("Official entries checked:", ids.join(", "));
