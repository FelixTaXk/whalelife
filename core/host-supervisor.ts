/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { directoryAt } from "./official-package-files.ts";
import { discardHostBackup, prepareHostBackup, restoreHostBackup } from "./host-update-backup.ts";
import { installLogOutputGuards, writeLogOutput } from "./log-output.ts";

const base = ".whalelife-updates";
const validVersion = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(v);
export const hostUpdateDirectory = (root: string) => join(root, base);
export function hostReleaseDirectory(root: string, version: string) {
  if (!validVersion(version)) throw Error("本体版本号无效");
  return join(hostUpdateDirectory(root), "releases", version);
}
type Outcome = "updated" | "rolled-back" | "failed";
export interface HostUpdateState {
  active: string | null;
  pending: string | null;
  phase?: "preparing" | "trial" | "handover";
  delivery?: { previous: string | null; plugins: string[] };
  lastResult: { status: Outcome; version: string; message: string; at: string } | null;
}
export async function readHostUpdateState(root: string): Promise<HostUpdateState> {
  const path = join(hostUpdateDirectory(root), "state.json");
  try {
    if (!await directoryAt(root, base)) return { active: null, pending: null, lastResult: null };
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw Error("本体状态文件异常");
    const s = JSON.parse(await readFile(path, "utf8"));
    if (!s || !(s.active === null || validVersion(s.active)) ||
      !(s.pending === null || (validVersion(s.pending) && ["preparing", "trial", "handover"].includes(s.phase))) ||
      (s.delivery !== undefined && !(s.pending === null && validVersion(s.active) && s.delivery &&
        (s.delivery.previous === null || validVersion(s.delivery.previous)) &&
        Array.isArray(s.delivery.plugins) && s.delivery.plugins.every((id: unknown) => typeof id === "string"))) ||
      !(s.lastResult === null || (s.lastResult && validVersion(s.lastResult.version) &&
        ["updated", "failed", "rolled-back"].includes(s.lastResult.status) &&
        typeof s.lastResult.message === "string" && typeof s.lastResult.at === "string")))
      throw Error("本体更新状态无效，请检查状态文件");
    return s;
  } catch (error: any) {
    if (error.code === "ENOENT") return { active: null, pending: null, lastResult: null };
    throw error;
  }
}
async function save(root: string, state: HostUpdateState) {
  const dir = (await directoryAt(root, base, true))!;
  const tmp = join(dir, "state-" + randomUUID() + ".tmp");
  try {
    const out = await open(tmp, "wx", 0o600);
    try { await out.writeFile(JSON.stringify(state)); await out.sync(); }
    finally { await out.close(); }
    await rename(tmp, join(dir, "state.json"));
    if (process.platform !== "win32") {
      const folder = await open(dir, "r");
      try { await folder.sync(); } finally { await folder.close(); }
    }
  } finally { await unlink(tmp).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
}

// Kernel-owned locks disappear with the owner even if it crashes. No PID is used to signal or kill a process.
export async function holdHostLock(root: string, role: "manager" | "worker", waitMs = 0) {
  // macOS and other Unix hosts lack Linux's abstract socket namespace. A SQLite exclusive
  // transaction is process-owned too, without leaving a stale bound socket path after a crash.
  if (process.platform !== "win32" && process.platform !== "linux") {
    const directory = (await directoryAt(root, base + "/locks", true))!;
    const path = join(directory, role + ".sqlite");
    const file = await open(path, "ax", 0o600).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    if (file) await file.close();
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error("本体实例锁文件无效");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(waitMs))}; BEGIN EXCLUSIVE`);
      return async () => db.close();
    } catch (error: any) {
      db.close();
      if (error.errcode === 5) throw Error("此 WhaleLife 实例仍在运行或关闭中，请稍后再启动");
      throw error;
    }
  }
  let canonical = await realpath(root);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const key = createHash("sha256").update(canonical + "\0" + role).digest("hex");
  const endpoint = { path: process.platform === "win32" ? "\\\\.\\pipe\\whalelife-" + key : "\0wl-" + key };
  const limit = Date.now() + waitMs;
  for (;;) {
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(endpoint, done); });
      return () => new Promise<void>(done => server.close(() => done()));
    } catch (error: any) {
      if (error.code !== "EADDRINUSE") throw error;
      if (Date.now() >= limit) throw Error("此 WhaleLife 实例仍在运行或关闭中，请稍后再启动");
      await delay(200);
    }
  }
}

type Health = { version: string; plugins: string[] };
type Activation = { version: string; plugins: string[] };
const childEntry = fileURLToPath(new URL("./host-child.ts", import.meta.url));
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function launch(root: string, program: string, trial: boolean) {
  const child = fork(childEntry, [root, program, trial ? "trial" : "active"], {
    cwd: root, execArgv: [], stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true,
  });
  const ready = deferred<Health | null>();
  let activation = deferred<Activation | null>();
  const exited = deferred<number>();
  let failure = "";
  let ended = false;
  let probe: { id: string; resolve: (health: Health | null) => void } | undefined;
  child.on("message", (packet: any) => {
    if (packet?.type === "host-boot-error") { failure = String(packet.error).slice(0, 400); return; }
    if (!validVersion(packet?.version) || !Array.isArray(packet.plugins) || !packet.plugins.every((x: unknown) => typeof x === "string")) return;
    if (packet.type === "host-ready") ready.resolve(packet);
    if (packet.type === "host-confirmed" && probe && packet.id === probe.id) probe.resolve(packet);
    if (packet.type === "host-activate") activation.resolve(packet);
  });
  const end = (code: number) => { ended = true; ready.resolve(null); activation.resolve(null); probe?.resolve(null); exited.resolve(code); };
  child.on("error", error => { failure = error.message; if (!child.pid) end(1); });
  child.once("exit", code => end(code ?? 1));
  const send = (type: string, error?: string) => { if (child.connected) child.send({ type, error }, () => {}); };
  return {
    ready: ready.promise, next: async () => {
      if (ended) return null;
      const request = await activation.promise;
      activation = deferred<Activation | null>();
      return request;
    },
    reject: (message: string) => send("host-activation-error", message),
    exit: exited.promise,
    health: async (serve: boolean, required: string[] = []) => {
      if (ended || !child.connected) return null;
      const reply = deferred<Health | null>();
      probe = { id: randomUUID(), resolve: reply.resolve };
      const timer = setTimeout(() => reply.resolve(null), 10_000);
      try {
        child.send({ type: serve ? "host-serving" : "host-probe", id: probe.id, required }, error => { if (error) reply.resolve(null); });
        return await reply.promise;
      } finally { clearTimeout(timer); probe = undefined; }
    },
    stop: () => send("host-stop"),
    terminateTrial: () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); },
    error: () => failure || "子进程在完成启动检查前退出",
  };
}

const result = (status: Outcome, version: string, message: string) => ({ status, version, message, at: new Date().toISOString() });
async function recover(root: string, state: HostUpdateState, message: string) {
  if (!state.pending) return state;
  if (state.phase === "trial" || state.phase === "handover") await restoreHostBackup(root);
  const restored: HostUpdateState = { active: state.active, pending: null, lastResult: result("rolled-back", state.pending, message) };
  await save(root, restored);
  return restored;
}

// The parent remains in the original installation across upgrades. It never imports a staged program.
export async function runHostSupervisor(instanceRoot: string, options: { healthTimeoutMs?: number } = {}) {
  installLogOutputGuards();
  const root = await realpath(instanceRoot);
  const unlock = await holdHostLock(root, "manager");
  let child: ReturnType<typeof launch> | undefined;
  let stopping = false;
  const stop = () => { stopping = true; child?.stop(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    // A previous parent may have been forcibly terminated while its worker is still draining.
    // Wait for that worker's kernel lock before reading a pending trial or touching its backup.
    await (await holdHostLock(root, "worker", 30_000))();
    let state = await readHostUpdateState(root);
    let previousPlugins: string[] = [];
    if (state.delivery) {
      // The worker confirmed that it could take over, but an orderly handover was never
      // recorded. Retry its health check without discarding or replacing the rollback image.
      previousPlugins = state.delivery.plugins;
      state = { active: state.delivery.previous, pending: state.active, phase: "trial", lastResult: null };
      await save(root, state);
    } else {
      state = await recover(root, state, "上次更新中断，已恢复之前的版本");
    }
    const cleanBackup = () => discardHostBackup(root).catch((e: Error) => writeLogOutput("更新备份暂未清理：" + e.message, "stderr"));
    while (!stopping) {
      const trial = state.pending !== null;
      const version = state.pending ?? state.active;
      let reason = "";
      try {
        const program = version === null ? root : await directoryAt(root, base + "/releases/" + version);
        if (!program) throw Error("更新程序目录不存在");
        child = launch(root, program, trial);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let health: Health | null;
        try {
          health = trial ? await Promise.race([child.ready, new Promise<null>(done => {
            deadline = setTimeout(() => { reason = "新版在限定时间内未完成启动检查"; done(null); }, options.healthTimeoutMs ?? 180_000);
          })]) : await child.ready;
        } finally { clearTimeout(deadline); }
        if (!health) throw Error(reason || child.error());
        if (version !== null && health.version !== version) throw Error("启动的程序版本和确认的更新版本不同");
        if (trial) {
          // A full boot and a separate live check catch a child or a plugin failing just after ready.
          if (await Promise.race([child.exit.then(() => true), delay(500, false)])) throw Error("新版启动后立即退出");
          const checked = await child.health(false);
          if (!checked || checked.version !== version) throw Error("新版未通过启动后的健康检查");
          const active = new Set(checked.plugins);
          const missing = previousPlugins.filter(id => !active.has(id));
          if (missing.length) throw Error("原先运行的插件未能启动：" + missing.join("、"));
          if (stopping) throw Error("更新在启动检查期间中断");
          state = { ...state, phase: "handover" };
          await save(root, state);
          // Keep public traffic gated during the final readiness round trip. Interruption here
          // leaves the previous active version and its complete rollback snapshot in the journal.
          const armed = await child.health(false, previousPlugins);
          if (!armed || armed.version !== version || previousPlugins.some(id => !armed.plugins.includes(id)) || stopping)
            throw Error("新版未能确认接管服务");
          const updated: HostUpdateState = { active: version, pending: null, lastResult: result("updated", version!, "新版已启动，原有插件检查通过") };
          const delivering: HostUpdateState = { ...updated, delivery: { previous: state.active, plugins: previousPlugins } };
          await save(root, delivering);
          // Selection is durable. A separate command opens traffic. Its receipt is journalled
          // before the old backup is cleaned, including when resuming after a parent crash.
          const serving = await child.health(true, previousPlugins);
          if (!serving || serving.version !== version || previousPlugins.some(id => !serving.plugins.includes(id))) {
            await save(root, state);
            throw Error("新版未能接管服务，已撤回版本切换");
          }
          // Traffic is already open. If disk writes fail now, keep the verified version serving
          // and retain its backup. A later request or restart can finish recording delivery.
          try { await save(root, updated); state = updated; }
          catch (error: any) { state = delivering; writeLogOutput("接管确认暂未写入，已保留备份：" + error.message, "stderr"); }
        } else if (!await child.health(true)) throw Error("本体启动后未响应健康检查");
        if (state.lastResult && !state.delivery) await cleanBackup();
        let next: Activation | null;
        for (;;) {
          next = await child.next();
          if (!next || stopping) { if (stopping) child.stop(); return await child.exit; }
          try {
            if (next.version === health.version) throw Error("本体已运行该版本");
            if (state.delivery) {
              const { delivery: _finished, ...record } = state;
              await save(root, record);
              state = record;
              await cleanBackup();
            }
            const preparing: HostUpdateState = { ...state, pending: next.version, phase: "preparing" };
            await save(root, preparing);
            state = preparing;
            break;
          } catch (error: any) { child.reject("无法准备本体更新：" + error.message); }
        }
        previousPlugins = next.plugins;
        child.stop();
        const status = await child.exit;
        child = undefined;
        try {
          if (status !== 0 || stopping) throw Error("原实例未正常结束，已取消切换");
          await prepareHostBackup(root);
          const testing: HostUpdateState = { ...state, phase: "trial" };
          await save(root, testing);
          state = testing;
        } catch (error: any) {
          const original: HostUpdateState = { active: state.active, pending: null, lastResult: result("failed", next.version, error.message) };
          await save(root, original);
          state = original;
          await cleanBackup();
        }
        continue;
      } catch (error: any) { reason = error.message; }
      if (child) {
        if (trial) {
          // A partially booted or wedged trial cannot own any user traffic. Its stable backup is still intact.
          child.terminateTrial();
        } else child.stop();
        await child.exit;
        child = undefined;
      }
      if (!trial) throw Error(reason);
      state = await recover(root, state, reason);
      await cleanBackup();
    }
    return 0;
  } finally {
    if (child) { child.stop(); await child.exit; }
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await unlock();
  }
}
