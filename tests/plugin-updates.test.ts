import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PluginUpdates } from "../core/plugin-updates.ts";

const host: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const catalogURL = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json";
const registryURL = "https://raw.githubusercontent.com/iinukami/whalelife/main/market/official-releases.json";
const github = "https://github.com/example/";
const card = (id: string) => ({ id, name: id, repository: github + id });
const author = card("color-note");
const catalog = { official: [card("child")], community: [author] };
const child = { ...card("child"), parentId: "parent" };
const asset = (version: string) => ({ version, hostRange: host, platform: process.platform, arch: process.arch,
  delivery: "github-release", sizeBytes: 100, sha256: "a".repeat(64), inventorySha256: "b".repeat(64),
  assetUrl: child.repository + "/releases/download/v" + version + "/child.wlpkg.gz" });
const registry = { schemaVersion: 1, plugins: [{ ...child, verifiedReleases: [asset("1.1.0")] }] };
const make = () => new PluginUpdates(new AbortController().signal, catalog, registry);
const installed = [{ id: "parent/child", version: "1.0.0" }, { id: "color-note", version: "1.9.0" }];
const recognized = async () => ({ plugins: [{ runtimeId: "parent/child", installed: true, installedVersion: "1.0.0" }],
  recognizedRuntimeIds: ["parent/child"] });
const unrecognized = async () => ({ plugins: [], recognizedRuntimeIds: [] });
const latestURL = (id: string) => "https://api.github.com/repos/example/" + id + "/releases/latest";
const stable = (tag_name: string) => ({ tag_name, draft: false, prerelease: false });

function serve(t: TestContext, replies: Map<string, unknown>) {
  const requests: { address: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (address: string, init: RequestInit) => {
    requests.push({ address, init });
    const reply = replies.get(address);
    if (reply instanceof Error) throw reply;
    return reply instanceof Response ? reply.clone() : reply ? Response.json(reply) : new Response(null, { status: 404 });
  });
  return requests;
}

test("updates compare local installations to compatible verified packages or public author releases without disclosing them", async t => {
  const newest = asset("1.10.0");
  const publicEntries = [{ ...child, verifiedReleases: [
    asset("1.9.0"), newest, { ...asset("3.0.0"), recognitionOnly: true }, { ...asset("4.0.0"), platform: "other" },
    { ...asset("5.0.0"), arch: "other" }, { ...asset("6.0.0"), hostRange: "other" },
    { ...asset("7.0.0"), delivery: "inventory" }, { ...asset("8.0.0"), inventorySha256: "invalid" },
    { ...asset("9.0.0"), assetUrl: "https://example.net/download" }, asset("20.0.0-pre.1")
  ] }];
  const replies = new Map<string, unknown>([
    [catalogURL, { ...catalog, community: [author, ...Array.from({ length: 120 }, (_, i) => card("absent-" + i))] }],
    [registryURL, { schemaVersion: 1, plugins: publicEntries }],
    [latestURL("color-note"), stable("v1.10.0")],
  ]);
  const requests = serve(t, replies);
  const service = make();
  const local = [...installed, { id: "private-plugin", version: "9.9.9", repository: "https://private.test/a" }];
  const [first, concurrent] = await Promise.all([service.list(local, recognized), service.list(local, recognized)]);
  assert.deepEqual(first.updates, [
    { id: "color-note", runtimeId: "color-note", repository: author.repository, source: "community", installedVersion: "1.9.0",
      latestVersion: "1.10.0", url: author.repository + "/releases/tag/v1.10.0" },
    { id: "child", runtimeId: "parent/child", repository: child.repository, source: "official", installedVersion: "1.0.0",
      latestVersion: "1.10.0", url: child.repository + "/releases/tag/v1.10.0" },
  ]);
  assert.equal(concurrent.updates.length, 2);
  assert.deepEqual(requests.map(r => r.address).sort(), [...replies.keys()].sort());
  for (const { init } of requests) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.deepEqual(init.headers, { Accept: "application/json" });
    assert.equal(init.body, undefined);
  }
  assert.deepEqual((await service.list([], recognized)).updates, []);
  assert.deepEqual((await service.list([{ id: "color-note", version: "2.0.0" }], recognized)).updates, []);
  assert.deepEqual((await service.list(installed, async () => { throw Error("inventory busy"); })).updates.map(p => p.source), ["community"]);
  assert.equal(requests.length, 3);
});

test("a fresh instance makes no public requests and unlisted installations do not trigger any author queries", async t => {
  const community = Array.from({ length: 150 }, (_, i) => card("absent-" + i));
  const requests = serve(t, new Map<string, unknown>([[catalogURL, { ...catalog, community }]]));
  const service = make();
  assert.deepEqual(await service.list([], recognized), { updates: [] });
  assert.equal(requests.length, 0);
  assert.deepEqual(await service.list([{ id: "private", version: "1.0.0" }], unrecognized), { updates: [] });
  assert.deepEqual(requests.map(r => r.address).sort(), [catalogURL, registryURL].sort());
});

test("reading the last manual result is local, and notices disappear for removed or replaced installations", async t => {
  const calls = serve(t, new Map<string, unknown>([[catalogURL, catalog], [registryURL, registry],
    [latestURL(author.id), stable("v2.0.0")]]));
  const service = make();
  assert.deepEqual(service.snapshot(installed), { updates: [] });
  assert.equal(calls.length, 0);
  const { updates } = await service.list(installed, recognized);
  assert.equal(updates.length, 2);
  assert.deepEqual(service.snapshot(installed), { updates, checked: true, incomplete: false });
  assert.deepEqual(service.snapshot([{ ...installed[0], version: "9.0.0" }, { ...installed[1], repository: github + "other" }]), { updates: [] });
  assert.equal(calls.length, 3);
});

test("no published author release is distinct from an interrupted or rate-limited manual check", async t => {
  const replies = new Map<string, unknown>([[catalogURL, catalog], [registryURL, registry]]);
  serve(t, replies);
  assert.deepEqual(await make().list([installed[1]], recognized), { updates: [] });
  for (const failure of [new Response(null, {status: 403}), new Response(null, {status: 429}), Error("offline")]) {
    replies.set(latestURL(author.id), failure);
    const service = make();
    assert.deepEqual(await service.list([installed[1]], recognized), { updates: [], incomplete: true });
    assert.deepEqual(service.snapshot([installed[1]]), { updates: [], checked: true, incomplete: true });
  }
});

test("offline official fallback respects fingerprints, runtime paths and installed versions", async t => {
  const replies = new Map<string, unknown>([[registryURL, Error("offline")], [catalogURL, Error("offline")]]);
  serve(t, replies);
  const service = make();
  assert.deepEqual((await service.list(installed, recognized)).updates.map(p => p.latestVersion), ["1.1.0"]);
  assert.deepEqual((await service.list(installed, unrecognized)).updates, []);
  assert.deepEqual((await service.list([{ id: "child", version: "1.0.0" }], recognized)).updates, []);
  assert.deepEqual((await service.list(installed, async () => ({
    ...await recognized(), plugins: [{ runtimeId:"parent/child", installed:true, installedVersion:"0.9.0" }]
  }))).updates, []);
  let scans = 0;
  for (const version of ["1.1.0", "1.1.0+my.build", "2.0.0", "malformed", "01.0.0"]) {
    assert.deepEqual((await service.list([{ id: "parent/child", version }], async () => { scans++; return recognized(); })).updates, []);
  }
  assert.equal(scans, 0);
});

test("foreign registry identities, duplicated parents and incompatible official releases never confer official updates", async t => {
  const replies = new Map<string, unknown>();
  serve(t, replies);
  const changed = { ...child, verifiedReleases: [asset("4.0.0")] };
  for (const candidates of [[{ ...changed, repository: github + "wrong" }], [{ ...changed, name: "other" }],
    [{ ...changed, parentId: "another" }], [changed, changed], [null]]) {
    replies.set(registryURL, { schemaVersion: 1, plugins: candidates });
    assert.deepEqual((await make().list(installed, recognized)).updates.map(p => p.latestVersion), ["1.1.0"]);
  }
});

test("community checks honor the author's stable Release, full local ID, current listing and declared repository", async t => {
  const replies = new Map<string, unknown>([[catalogURL, catalog]]);
  const requests = serve(t, replies);
  for (const data of [stable("1.9.0+other"), stable("v1.8.9"), stable("tomorrow"), stable("v2.0"),
    stable("v02.0.0"), stable("v2.0.0-preview.1"), { ...stable("v2.0.0"), prerelease: true },
    { ...stable("v2.0.0"), draft: true }, { tag_name: "v2.0.0" }, Error("offline"),
    new Response(null, { status: 429 }), new Response("{")]) {
    replies.set(latestURL("color-note"), data);
    assert.deepEqual((await make().list(installed, unrecognized)).updates, []);
  }
  replies.set(latestURL("color-note"), stable("1.9.0+build"));
  const pre = await make().list([{ id: "color-note", version: "1.9.0-rc.1" }], unrecognized);
  assert.equal(pre.updates[0]?.latestVersion, "1.9.0+build");
  replies.set(latestURL("color-note"), stable("v2.0.0"));
  for (const plugin of [{ id: "else/color-note", version: "1.0.0" }, { ...installed[1], builtin: true },
    { ...installed[1], repository: github + "other" }, { ...installed[1], version: "1.9.0-beta.01" }]) {
    assert.deepEqual((await make().list([plugin], unrecognized)).updates, []);
  }
  replies.set(catalogURL, { ...catalog, community: [] });
  assert.deepEqual((await make().list(installed, unrecognized)).updates, []);
  for (const repository of ["http://github.com/a/b", "https://github.com@private.test/a/b", "https://github.com/a/.."]) {
    replies.set(catalogURL, { ...catalog, community: [{ ...author, repository }] });
    await make().list(installed, unrecognized);
  }
  assert.ok(requests.every(r => [catalogURL, registryURL, latestURL("color-note")].includes(r.address)));
});
