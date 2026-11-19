/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const preserved = plugin.preserve ?? [];
  assert.ok(Array.isArray(preserved) && new Set(preserved).size === preserved.length);
  for (const path of preserved) {
    assert.ok(typeof path === "string" && !/[\\:\x00-\x1f]/u.test(path) &&
      path.split("/").every(part => part && part !== "." && part !== ".."));
  }
  assert.ok(Array.isArray(plugin.verifiedReleases));
  const hashes = new Set();
  for (const release of plugin.verifiedReleases) {
    for (const key of ["version", "hostRange", "platform", "arch", "verification"]) {
      assert.ok(typeof release[key] === "string" && release[key].trim(), plugin.id + ": missing " + key);
    }
    assert.match(release.sourceCommit, /^[a-f0-9]{40}$/);
    assert.match(release.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!hashes.has(release.sha256), "Duplicate official asset");
    hashes.add(release.sha256);
    assert.ok(Number.isSafeInteger(release.fileCount) && release.fileCount > 0);
    assert.ok(Number.isSafeInteger(release.sizeBytes) && release.sizeBytes > 0);
    if (release.recognitionOnly === true) {
      assert.equal(release.delivery, "inventory");
      assert.equal(release.inventoryPath, "market/inventories/" + release.sha256 + ".json");
      const raw = readFileSync(new URL("../../" + release.inventoryPath, import.meta.url));
      assert.equal(createHash("sha256").update(raw).digest("hex"), release.sha256);
      const inventory = JSON.parse(raw);
      assert.equal(inventory.format, 1);
      assert.equal(raw.length, release.sizeBytes);
      assert.equal(inventory.files.length, release.fileCount);
      const paths = new Set();
      for (const { path, size, sha256 } of inventory.files) {
        assert.ok(typeof path === "string" && !/[\\:\x00-\x1f]/u.test(path) &&
          path.split("/").every(part => part && part !== "." && part !== ".."));
        assert.ok(!paths.has(path.toLowerCase()), "Duplicate inventory path");
        assert.ok(!preserved.includes(path), "Persistent file in release inventory");
        paths.add(path.toLowerCase());
        assert.ok(Number.isSafeInteger(size) && size >= 0);
        assert.match(sha256, /^[a-f0-9]{64}$/);
      }
    } else if (release.assetUrl) {
      const asset = new URL(release.assetUrl);
      assert.equal(asset.origin, repo.origin);
      assert.ok(asset.pathname.startsWith(repo.pathname + "/releases/download/"));
    } else {
      assert.equal(release.delivery, "local-build");
    }
    assert.ok(release.dependencies && typeof release.dependencies === "object" && !Array.isArray(release.dependencies));
    for (const [dep, range] of Object.entries(release.dependencies)) {
      assert.ok(ids.includes(dep) && dep !== plugin.id && typeof range === "string" && range.trim());
    }
    assert.deepEqual(Object.keys(release.dependencies).sort(), [...plugin.requiredPlugins].sort());
  }
}
console.log("Official entries checked:", ids.join(", "));
