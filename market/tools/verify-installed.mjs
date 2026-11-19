/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
// Run with Node 24: WHALELIFE_OFFICIAL_CACHE=<cache> node --test market/tools/verify-installed.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { boot } from "../../core/index.ts";
import { temporaryDirectory } from "../../tests/temporary-directory.ts";

const registry = JSON.parse(await readFile(new URL("../official-releases.json", import.meta.url), "utf8"));
const sample = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAj8AAAAASUVORK5CYII=", "base64");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("seven official releases on a clean host, including a gallery uninstall, reinstall and cold boot", async t => {
  assert.ok(process.env.WHALELIFE_OFFICIAL_CACHE, "Set WHALELIFE_OFFICIAL_CACHE to the verified package cache.");
  const source = resolve(process.env.WHALELIFE_OFFICIAL_CACHE), root = await temporaryDirectory("whale-official-real-");
  const cache = join(root, ".artifacts/official-packages");
  await mkdir(cache, { recursive: true });
  for (const plugin of registry.plugins) {
    const release = plugin.verifiedReleases.find(r => !r.recognitionOnly && r.platform === process.platform && r.arch === process.arch);
    assert.ok(release, plugin.id + " has no release for this platform");
    const basename = release.sha256 + ".wlpkg.gz";
    await copyFile(join(source, basename), join(cache, basename));
  }
  const config = JSON.parse(await readFile(new URL("../../config.example.json", import.meta.url), "utf8"));
  config.web = { host: "127.0.0.1", port: 0 };
  config.log.level = "warn";
  assert.deepEqual(config.providers, []);
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config/config.json"), JSON.stringify(config));
  // Optional manual-install fixture. Only copy files named by the pinned, public historical inventory.
  const legacy = process.env.WHALELIFE_LEGACY_GALLERY;
  if (legacy) {
    const release = registry.plugins.find(row => row.id === "gallery").verifiedReleases
      .find(r => r.recognitionOnly && r.version === "0.1.1");
    assert.ok(release);
    const inventory = await readFile(new URL("../inventories/" + release.sha256 + ".json", import.meta.url));
    assert.equal(hash(inventory), release.sha256);
    const base = join(root, "plugins/gallery");
    for (const file of JSON.parse(inventory).files) {
      assert.ok(!/^(?:data|config|sub)(?:\/|$)/i.test(file.path));
      assert.ok(!file.path.split("/").includes(".."));
      const bytes = await readFile(join(resolve(legacy), file.path));
      assert.equal(hash(bytes), file.sha256, file.path);
      await mkdir(dirname(join(base, file.path)), { recursive: true });
      await writeFile(join(base, file.path), bytes, { flag: "wx" });
    }
    t.diagnostic("Manually installed only the " + release.fileCount + " verified 0.1.1 program files");
  }
  let app, origin, cookie;
  t.after(async () => { await app?.close(); });
  async function restart() {
    await app?.close();
    app = await boot(root);
    origin = "http://127.0.0.1:" + app.web.server.address().port;
    const response = await fetch(origin + "/api/login", { method: "POST", body: "{}" });
    assert.ok(response.ok);
    cookie = response.headers.get("set-cookie").split(";")[0];
    await response.json();
  }
  async function request(path, body, contentType = "application/json") {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST",
      headers: { cookie, origin, "Content-Type": contentType },
      body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : body });
    if (!response.ok) throw Error(`${path} returned ${response.status}: ${await response.text()}`);
    return response;
  }
  const json = async (path, body) => (await request(path, body)).json();
  const list = async () => (await json("/api/official-plugins")).plugins;
  async function entry(id) { return (await list()).find(row => row.id === id); }
  async function apply(id, action, expectedSteps) {
    const row = await entry(id);
    assert.equal(row.action, action, id + ": " + row.reason);
    if (expectedSteps) assert.deepEqual(row.steps.map(step => [step.action, step.id]), expectedSteps);
    const result = await json("/api/official-plugins/apply", { id, action, planKey: row.planKey });
    assert.ok(result.ok, JSON.stringify(result));
    t.diagnostic(id + " " + action + " " + (action === "uninstall" ? row.installedVersion : row.version));
  }
  const gallery = "/plugins/gallery";
  async function gallerySnapshot(id) {
    const state = await json(gallery + "/state");
    const { asset } = await json(gallery + "/action", { action: "read", id });
    const bytes = Buffer.from(await (await request(gallery + "/image?id=" + encodeURIComponent(id))).arrayBuffer());
    return { id: asset.id, tags: asset.tags, revision: asset.revision, config: state.config, imageSHA256: hash(bytes) };
  }
  await restart();
  const initial = await list();
  assert.equal(initial.length, 7);
  assert.ok(initial.filter(row => !legacy || row.id !== "gallery").every(row => row.action === "install"),
    JSON.stringify(initial.map(row => [row.id, row.reason])));
  if (legacy) {
    const row = initial.find(row => row.id === "gallery");
    assert.equal(row.installedVersion, "0.1.1");
    assert.equal(row.action, "uninstall", row.reason);
    assert.equal(app.runtime.records.get("gallery")?.status, "active");
  } else await apply("gallery", "install");
  const uploaded = await (await request(gallery + "/upload?name=roundtrip.png", sample, "image/png")).json();
  assert.ok(uploaded.asset?.id, JSON.stringify(uploaded));
  const { id, revision } = uploaded.asset;
  await json(gallery + "/action", { action: "edit", id, revision, patch: { tags: ["安装验收", "保留原图"] } });
  const settings = await json(gallery + "/state");
  await json(gallery + "/action", { action: "config", revision: settings.revision,
    config: { ...settings.config, allowOriginals: true, topK: 11 } });
  const original = await gallerySnapshot(id);
  assert.deepEqual(original.tags, ["安装验收", "保留原图"]);
  assert.equal(original.imageSHA256, hash(sample));
  assert.equal(original.config.allowOriginals, true);
  assert.equal(original.config.topK, 11);
  await apply("gallery", "uninstall");
  await restart();
  assert.equal((await entry("gallery")).installed, false);
  assert.ok((await readdir(join(root, "plugins/gallery/data"))).length > 0);
  await apply("gallery", "install");
  assert.equal((await entry("gallery")).installedVersion, "0.1.2");
  assert.deepEqual(await gallerySnapshot(id), original);
  await restart();
  assert.deepEqual(await gallerySnapshot(id), original);
  t.diagnostic("Gallery after reinstall and cold boot: " + JSON.stringify(original));
  await apply("gallery", "uninstall");

  for (const id of ["autonomy", "vision"]) {
    await apply(id, "install");
    assert.equal(app.runtime.records.get(id)?.status, "active");
    await apply(id, "uninstall");
  }
  for (const [parent, child] of [["surf", "bilibili"], ["qq", "qzone"]]) {
    await apply(child, "install", [["install", parent], ["install", child]]);
    assert.equal(app.runtime.records.get(parent)?.status, "active");
    assert.equal(app.runtime.records.get(parent + "/" + child)?.status, "active");
    const dependent = await entry(child), blocked = await entry(parent);
    assert.equal(blocked.action, null);
    assert.ok(blocked.reason.includes(dependent.name), blocked.reason);
    assert.equal(dependent.action, "uninstall", dependent.reason);
    await apply(child, "uninstall", [["uninstall", child]]);
    assert.equal(app.runtime.records.get(parent)?.status, "active");
    if (parent === "surf") {
      const reuse = await entry(child);
      assert.deepEqual(reuse.steps.map(step => [step.action, step.id]), [["reuse", parent], ["install", child]]);
      await json("/api/plugin", { id: parent, action: "stop" });
      const enable = await entry(child);
      assert.equal(enable.label, "启用网上冲浪并安装 B 站插件");
      assert.notEqual(enable.planKey, reuse.planKey);
      assert.equal(app.runtime.records.get(parent)?.status, "stopped");
      await apply(child, "install", [["enable", parent], ["install", child]]);
      assert.equal(app.runtime.records.get(parent)?.status, "active");
      await apply(child, "uninstall");
    }
    await apply(parent, "uninstall", [["uninstall", parent]]);
  }
  assert.ok((await list()).every(row => !row.installed && row.action === "install"));
});
