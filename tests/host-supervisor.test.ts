/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { temporaryDirectory } from "./temporary-directory.ts";
import { holdHostLock, hostReleaseDirectory, readHostUpdateState, runHostSupervisor } from "../core/host-supervisor.ts";
import { prepareHostBackup } from "../core/host-update-backup.ts";

// Run a real supervised child with the same IPC/bootstrap as production. Its small boot fixture
// simulates a release with an incompatible plugin or a write during startup, without real accounts.
async function program(dir: string, version: string, body: string) {
  await mkdir(join(dir, "core"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({version, type:"module"}));
  await writeFile(join(dir, "core", "host-updates.ts"), "export class HostUpdates { constructor(root, version, activate) { this.activate = activate } }");
  await writeFile(join(dir, "core", "index.ts"), `
    import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    export async function boot(root, updates, starting) {
      const image = join(root, 'plugins/gallery/data/image.png'), ready = () => process.exit(0);
      let plugins = ['gallery'];
      ${body}
      return {runtime:{list:()=>plugins.map(id=>({id,status:'active'}))}, logger:{error(){}}, close(){}};
    }`);
}
const old = `
  if (existsSync(join(root, 'asked'))) setTimeout(ready, 250);
  else setTimeout(() => {
    writeFileSync(join(root, 'asked'), 'yes');
    updates.activate('0.2.0').catch(() => process.exit(1));
  }, 300);
`;
async function fixture() {
  const root = await temporaryDirectory("whale-host-supervisor-");
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/config.json"), JSON.stringify({memory:{root:"memory"},personas:{}}));
  await mkdir(join(root, "plugins/gallery/data"), {recursive:true});
  await writeFile(join(root, "plugins/gallery/data/image.png"), Buffer.from([137,80,78,71,1,2,3]));
  await program(root, "0.1.0", old);
  return { root, target: hostReleaseDirectory(root, "0.2.0"), image: join(root, "plugins/gallery/data/image.png") };
}
test("supervisor commits a healthy release and preserves the original instance directory", async () => {
  const {root,target,image} = await fixture(), bytes = await readFile(image);
  await program(target, "0.2.0", "setTimeout(ready, 950);");
  assert.equal(await runHostSupervisor(root), 0);
  const state = await readHostUpdateState(root);
  assert.equal(state.active, "0.2.0");
  assert.equal(state.lastResult?.status, "updated");
  assert.equal(state.pending, null);
  assert.deepEqual(await readFile(image), bytes);
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readHostUpdateState(root), state);
});
test("loss of a formerly running plugin restores data touched by trial and restarts the previous program", async () => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", "writeFileSync(image, 'trial changed'); plugins = [];");
  assert.equal(await runHostSupervisor(root), 0);
  const state = await readHostUpdateState(root);
  assert.equal(state.active, null);
  assert.equal(state.lastResult?.status, "rolled-back");
  assert.match(state.lastResult!.message, /gallery/);
  assert.deepEqual(await readFile(image), original);
});
test("a candidate that exits right after its first ready report triggers rollback", async () => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", "writeFileSync(image, 'trial changed'); setTimeout(() => process.exit(1), 80);");
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readFile(image), original);
  assert.equal((await readHostUpdateState(root)).lastResult?.status, "rolled-back");
});
test("a hung trial is terminated and rolled back within the health deadline", async () => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", "writeFileSync(image, 'trial changed'); await new Promise(() => {});");
  assert.equal(await runHostSupervisor(root, {healthTimeoutMs:800}), 0);
  assert.deepEqual(await readFile(image), original);
  assert.match((await readHostUpdateState(root)).lastResult!.message, /限定时间/);
});
test("failure to write the update journal rejects that request and keeps the running application", async () => {
  const {root} = await fixture();
  await program(root, "0.1.0", `
    setTimeout(async () => {
      mkdirSync(join(root,'.whalelife-updates/state.json'), {recursive:true});
      try { await updates.activate('0.2.0'); process.exit(2); }
      catch (error) { writeFileSync(join(root, 'rejected'), error.message); ready(); }
    },300);
  `);
  assert.equal(await runHostSupervisor(root), 0);
  assert.match(await readFile(join(root,"rejected"),"utf8"), /无法准备本体更新/);
});
test("interrupted trial recovers its saved image before bringing back the old application", async () => {
  const {root,image} = await fixture(), original = await readFile(image);
  await writeFile(join(root, "asked"), "yes");
  await prepareHostBackup(root);
  await writeFile(join(root, ".whalelife-updates/state.json"), JSON.stringify({active:null,pending:"0.2.0",phase:"trial",lastResult:null}));
  await writeFile(image, "trial changed");
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readFile(image), original);
  assert.equal((await readHostUpdateState(root)).lastResult?.status, "rolled-back");
});
test("killing the manager while the final handover response is outstanding restores the previous release and image", async t => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await program(target, "0.2.0", `
    writeFileSync(image, 'trial changed');
    const send = process.send.bind(process);
    process.send = (packet,...rest) => {
      if (packet.type === 'host-confirmed' && JSON.parse(readFileSync(join(root,'.whalelife-updates/state.json'),'utf8')).phase === 'handover') {
        writeFileSync(join(root,'waiting-for-handover'), String(starting()));
        return true; // Simulate an IPC reply still in flight; the worker remains responsive to parent disconnect.
      }
      return send(packet,...rest);
    };
  `);
  const entry = join(root,"manager.mjs");
  await writeFile(entry, `import {runHostSupervisor} from ${JSON.stringify(new URL("../core/host-supervisor.ts", import.meta.url).href)}; process.exitCode=await runHostSupervisor(process.argv[2]);`);
  const manager = fork(entry,[root],{execArgv:[],stdio:["ignore","ignore","ignore","ipc"]});
  const exited = once(manager,"exit");
  t.after(async () => { if (manager.exitCode === null && manager.signalCode === null) manager.kill("SIGKILL"); await exited; });
  let gated = "";
  const until = Date.now() + 15_000;
  while (Date.now() < until && !gated) {
    gated = await readFile(join(root,"waiting-for-handover"),"utf8").catch(() => "");
    if (!gated) await wait(30);
  }
  assert.equal(gated, "true");
  const interrupted = await readHostUpdateState(root);
  assert.deepEqual([interrupted.active, interrupted.pending, interrupted.phase], [null,"0.2.0","handover"]);
  manager.kill("SIGKILL");
  await exited;
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readFile(image), original);
  const recovered = await readHostUpdateState(root);
  assert.deepEqual([recovered.active,recovered.lastResult?.status], [null,"rolled-back"]);
});
test("an interrupted delivery retains its prior program and snapshot if the selected version cannot boot", async () => {
  const {root,target,image} = await fixture(), original = await readFile(image);
  await writeFile(join(root, "asked"), "yes");
  await prepareHostBackup(root);
  await program(target,"0.2.0","throw Error('partial delivery failed to boot');");
  await writeFile(join(root, ".whalelife-updates/state.json"), JSON.stringify({
    active:"0.2.0",pending:null,lastResult:null,delivery:{previous:null,plugins:["gallery"]},
  }));
  await writeFile(image, "trial changed");
  assert.equal(await runHostSupervisor(root), 0);
  assert.deepEqual(await readFile(image), original);
  assert.equal((await readHostUpdateState(root)).lastResult?.status, "rolled-back");
});
test("a second supervisor never consumes or resets the first supervisor's pending journal", async () => {
  const {root} = await fixture();
  const unlock = await holdHostLock(root,"manager");
  try { await assert.rejects(runHostSupervisor(root), /仍在运行/); }
  finally { await unlock(); }
});
