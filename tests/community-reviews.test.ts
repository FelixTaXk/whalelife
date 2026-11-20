import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewedCommunityEntries, readPublishedCommunityReviews } from "../core/community-reviews.ts";

const repo = "https://github.com/example/sample";
const release = { version:"1.2.0", hostRange:"0.1.0", platform:"any", arch:"any", sha256:"a".repeat(64),
  sizeBytes:100, assetUrl:repo + "/releases/download/v1.2.0/sample-1.2.0.wlpkg.gz", dependencies:{} };
const item = {id:"sample", name:"示例", description:"测试", repository:repo, installation:repo, dependencies:[]};

test("收录与逐包审核独立；发行记录只能引用原仓库、已审版本和固定摘要", () => {
  const parse = (entry: object) => reviewedCommunityEntries({official:[], community:[entry]});
  assert.deepEqual(parse(item), []);
  assert.equal(parse({...item,verifiedReleases:[release]})[0].verifiedReleases![0].sha256, release.sha256);
  for (const invalid of [
    {...release, assetUrl:release.assetUrl.replace("example", "someone-else")},
    {...release, assetUrl:release.assetUrl.replace("v1.2.0/", "latest/")},
    {...release, sha256:""}, {...release, platform:"all"}, {...release, sizeBytes:-1},
    {...release, dependencies: {surf:"0.1.1"}}, {...release, bundledPluginIds:["gallery"]},
  ]) assert.throws(() => parse({...item, verifiedReleases:[invalid]}), /审核记录无效/);
  assert.throws(() => parse({...item, id:"surf/bilibili", verifiedReleases:[release]}), /重名/);
  assert.throws(() => parse({...item, id:"surf/sample", verifiedReleases:[release]}), /父插件/);
  assert.throws(() => parse({...item, verifiedReleases:[release, {...release,platform:"win32"}]}), /匹配重复/);
});

test("同一子插件不能同时由独立条目与另一发行包管理", () => {
  assert.throws(() => reviewedCommunityEntries({official:[], community:[
    {...item, verifiedReleases:[{...release, bundledPluginIds:["sample/child"]}]},
    {...item, id:"sample/child"},
  ]}), /已被占用/);
});

test("撤下、断网和格式错误均不会沿用之前的社区发行授权", async () => {
  const signal = new AbortController().signal;
  const responses = [
    Response.json({official:[], community:[{...item,verifiedReleases:[release]}]}),
    Response.json({official:[], community:[item]}), new Response("", {status:503}),
    Response.json({community:{}}),
  ];
  const request: typeof fetch = async (url, options) => {
    assert.equal(url,"https://raw.githubusercontent.com/iinukami/whalelife/main/market/catalog.json");
    assert.equal(options?.credentials,"omit");
    assert.equal(options?.redirect,"error");
    return responses.shift()!;
  };
  assert.equal((await readPublishedCommunityReviews(signal, request)).length,1);
  assert.deepEqual(await readPublishedCommunityReviews(signal, request),[]);
  await assert.rejects(readPublishedCommunityReviews(signal, request));
  await assert.rejects(readPublishedCommunityReviews(signal, request));
});
