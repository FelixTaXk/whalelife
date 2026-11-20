import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";

const { bindHostUpdate, hostUpdateContent, resetHostUpdateSession } =
  await import(new URL("../core/ui/host-updates.js", import.meta.url).href);
const ready = {
  current: "0.1.0", phase: "idle", supported: true,
  latest: { version: "0.1.1", url: "https://github.com/iinukami/whalelife/releases/tag/v0.1.1" },
};

function overview() {
  const slot = {
    innerHTML: "", ownerDocument: { activeElement: null }, contains: () => false,
    onclick: (_event: unknown) => {},
  };
  let confirm: (() => Promise<void>) | undefined;
  const app = {
    authenticated: true, state: { page: "overview" }, content: { querySelector: () => slot },
    requireLogin() {
      resetHostUpdateSession(app);
      app.authenticated = false;
    },
    dialog(_title: string, _body: string, submit: () => Promise<void>, label: string) {
      assert.equal(label, "更新并重启");
      confirm = submit;
    },
  };
  return {
    app, slot, click(action: string) {
      slot.onclick({ target: { closest: () => ({ dataset: { hostAction: action } }) } });
    },
    confirm: async () => { assert.ok(confirm); await confirm(); },
  };
}

test("a console read or cancelled dialog cannot apply an update; confirming pins the shown version", async t => {
  const view = overview();
  const requests: { path: string; body?: string }[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    requests.push({ path, body: init.body as string });
    return Response.json(path.endsWith("/apply") ? { ...ready, phase: "preparing" } : ready);
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  await turn();
  assert.match(view.slot.innerHTML, /v0\.1\.1 可更新/);
  view.click("open");
  assert.equal(fetch.mock.callCount(), 1); // The cancel path never runs submit.
  view.click("open");
  await view.confirm();
  assert.deepEqual(requests.map(call => call.path), ["/api/host-update", "/api/host-update/apply"]);
  assert.deepEqual(JSON.parse(requests[1].body!), { version: "0.1.1", confirmed: true });
  assert.match(view.slot.innerHTML, /正在准备本体更新/);
  assert.doesNotMatch(view.slot.innerHTML, /更新成功/);
});

test("an interrupted apply waits for server status and 401 requires login; rollback survives a new session", async t => {
  const view = overview();
  let reads = 0, applies = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (path: string) => {
    if (path.endsWith("/apply")) { applies++; throw Error("断线"); }
    if (++reads === 1) return Response.json(ready);
    if (reads === 2) return Response.json({ error: "请重新登录" }, { status: 401 });
    return Response.json({ ...ready, lastResult: { status: "rolled-back", version: "0.1.1", message: "已恢复 0.1.0" } });
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  await turn();
  view.click("open");
  await view.confirm();
  assert.match(view.slot.innerHTML, /正在重新连接/);
  assert.doesNotMatch(view.slot.innerHTML, /更新成功/);
  t.mock.timers.tick(2000);
  await turn();
  assert.equal(view.app.authenticated, false);
  t.mock.timers.tick(60_000);
  assert.equal(reads, 2);
  view.app.authenticated = true;
  bindHostUpdate(view.app);
  await turn();
  assert.match(view.slot.innerHTML, /更新失败，已回滚/);
  assert.match(view.slot.innerHTML, /已恢复 0\.1\.0/);
  assert.equal(applies, 1);
});

test("offline checks can be retried, and only the host's returned outcome is shown as success", async t => {
  const view = overview();
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: string) => {
    paths.push(path);
    if (paths.length === 1) throw Error("无法连接发行源");
    return Response.json({ ...ready, current: "0.1.1", latest: null,
      lastResult: { status: "updated", version: "0.1.1", message: "已更新并重启" } });
  });
  t.after(() => resetHostUpdateSession(view.app));
  bindHostUpdate(view.app);
  await turn();
  assert.match(view.slot.innerHTML, /无法连接发行源/);
  view.click("check");
  await turn();
  assert.equal(paths[1], "/api/host-update/check");
  assert.match(view.slot.innerHTML, /更新成功/);
  assert.match(view.slot.innerHTML, /暂无新版本/);
  assert.doesNotMatch(hostUpdateContent({ hostUpdate: { data: { ...ready, supported: false } } }), /data-host-action="open"/);
});
