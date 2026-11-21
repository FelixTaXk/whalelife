/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostReleaseDirectory, readHostUpdateState, runHostSupervisor } from "../core/host-supervisor.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

const host = JSON.stringify(new URL("../core/index.ts", import.meta.url).href);
const job = "synthetic-job-1";
const original = "0.1.0", candidate = "0.2.0";

async function fixture(failure: "trial" | "delivery") {
  const area = await temporaryDirectory("whale-host-recovery-");
  const root = join(area, "instance");
  const plugin = join(root, "plugins", "sender");
  const queue = join(plugin, "data", "queued");
  // The mock recipient is outside the instance. Restoring a backup cannot undo a delivery.
  const ledger = join(area, "recipient.log");
  const imports = join(area, "plugin-imports.log");
  await mkdir(join(plugin, "data"), { recursive: true });
  await mkdir(join(root, "config"));
  await writeFile(ledger, "");
  await writeFile(join(root, "config", "config.json"), JSON.stringify({
    log: { level: "error" }, web: { host: "127.0.0.1", port: 0 },
    providers: [], models: [], model_bindings: {}, personas: {},
    channels: {}, memory: { root: "memory", budget_tokens: 6000 },
  }));
  await writeFile(join(plugin, "plugin.yaml"), JSON.stringify({
    id: "sender", name: "Sender", version: "1.0.0", description: "Fixture queue consumer",
  }));
  await writeFile(join(plugin, "index.ts"), `
    import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
    const queue = new URL("./data/queued", import.meta.url);
    appendFileSync(${JSON.stringify(imports)}, process.env.WHALE_TEST_RELEASE + "\\n");
    export function apply() {
      if (!existsSync(queue)) return;
      const id = readFileSync(queue, "utf8");
      appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({ id, version: process.env.WHALE_TEST_RELEASE }) + "\\n");
      unlinkSync(queue);
    }`);

  const journal = join(root, ".whalelife-updates", "state.json");
  const savedJournal = join(area, "journal-before-write-failure");
  const receipt = join(area, "session-receipt");
  const breakNextBoot = join(area, "fail-next-boot");
  async function install(dir: string, version: string) {
    await mkdir(join(dir, "core"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ version, type: "module" }));
    await writeFile(join(dir, "core", "host-updates.ts"), `
      export class HostUpdates {
        constructor(root, current, activate) { this.activate = activate; }
      }`);
    await writeFile(join(dir, "core", "index.ts"), `
      import * as host from ${host};
      import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      const version = process.env.WHALE_TEST_RELEASE = ${JSON.stringify(version)};
      const candidate = version === ${JSON.stringify(candidate)};
      const trialFailure = candidate && ${failure === "trial"};
      const queue = ${JSON.stringify(queue)}, receipt = ${JSON.stringify(receipt)};
      // The deadline turns an IPC regression into an assertion failure in the owning test.
      setTimeout(() => process.exit(72), 30_000).unref();
      async function rejectTrial(app) {
        await app.close();
        throw Error("fixture rejected candidate after initialization");
      }
      export async function prepareHostTrial(...args) {
        const app = await host.prepareHostTrial(...args);
        if (trialFailure) return rejectTrial(app);
        return app;
      }
      async function afterServing(app, updates, starting) {
        while (starting()) await delay(10);
        if (!candidate && !existsSync(${JSON.stringify(join(area, "requested"))})) {
          writeFileSync(queue, ${JSON.stringify(job)});
          writeFileSync(${JSON.stringify(join(area, "requested"))}, "yes");
          await updates.activate(${JSON.stringify(candidate)});
          return;
        }
        if (candidate) {
          const origin = "http://127.0.0.1:" + app.web.server.address().port;
          const login = await fetch(origin + "/api/login", { method: "POST", body: "{}" });
          if (!login.ok) throw Error("fixture login failed: " + login.status);
          const cookie = login.headers.get("set-cookie").split(";")[0];
          const response = await fetch(origin + "/api/session/current", {
            method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ create: true }),
          });
          const session = await response.json();
          if (!response.ok || !session.id) throw Error("fixture session request failed: " + response.status);
          writeFileSync(receipt, session.id);
        }
        process.emit("SIGTERM");
      }
      export async function boot(root, updates, starting) {
        if (candidate && existsSync(${JSON.stringify(breakNextBoot)})) throw Error("fixture cannot boot again");
        const app = await host.boot(root, updates, starting);
        if (trialFailure) return rejectTrial(app);
        if (candidate) {
          // Fail real journal replacements beginning with the command that opens HTTP traffic.
          process.prependListener("message", packet => {
            if (packet?.type !== "host-serving" || existsSync(${JSON.stringify(savedJournal)})) return;
            renameSync(${JSON.stringify(journal)}, ${JSON.stringify(savedJournal)});
            mkdirSync(${JSON.stringify(journal)});
          });
        }
        void afterServing(app, updates, starting).catch(error => { console.error(error); process.exit(73); });
        return app;
      }`);
  }
  await install(root, original);
  await install(hostReleaseDirectory(root, candidate), candidate);
  const deliveries = async () => (await readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { root, journal, savedJournal, receipt, imports, breakNextBoot, deliveries };
}

test("a rejected candidate never delivers a queued plugin action before rollback", async () => {
  const f = await fixture("trial");
  assert.equal(await runHostSupervisor(f.root), 0);
  const state = await readHostUpdateState(f.root);
  assert.equal(state.lastResult?.status, "rolled-back");
  assert.match(state.lastResult.message, /fixture rejected candidate/);
  assert.deepEqual(await f.deliveries(), [{ id: job, version: original }]);
  assert.ok(!(await readFile(f.imports, "utf8")).split("\n").includes(candidate), "a trial must not execute plugin module initializers");
});

test("a failed journal write at handover and a later failed boot preserve acknowledged work", async () => {
  const f = await fixture("delivery");
  assert.equal(await runHostSupervisor(f.root), 0);
  assert.ok((await stat(f.journal)).isDirectory());
  const session = await readFile(f.receipt, "utf8");
  const readSession = async () => JSON.parse(await readFile(join(f.root, "memory", "index.json"), "utf8")).sessions[session];
  const beforeRestart = await readSession();
  assert.ok(beforeRestart, "the session acknowledged by the live HTTP API exists on disk");
  assert.deepEqual(await f.deliveries(), [{ id: job, version: candidate }]);

  // The disk recovers with its last successful journal intact. The selected program now fails to boot.
  await rmdir(f.journal);
  await rename(f.savedJournal, f.journal);
  await writeFile(f.breakNextBoot, "yes");
  const restart = await runHostSupervisor(f.root).catch((error: Error) => error);
  assert.deepEqual(await readSession(), beforeRestart, "keep the session even when the new release cannot restart");
  assert.deepEqual(await f.deliveries(), [{ id: job, version: candidate }]);
  assert.ok(restart instanceof Error);
  assert.match(restart.message, /fixture cannot boot again/);
  assert.equal((await readHostUpdateState(f.root)).active, candidate);
});
