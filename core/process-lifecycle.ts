/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { installLogOutputGuards, writeLogOutput } from "./log-output.ts";

interface ProcessApplication {
  close(): void | Promise<void>;
  pendingPackageCommit?(): Promise<void> | undefined;
  logger: { error(message: string, extra?: unknown): void };
}

interface LifecycleOptions {
  shutdownTimeoutMs?: number;
}

function shutdownTimeout(options: LifecycleOptions) {
  const configured = options.shutdownTimeoutMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured : 10_000;
}

// This is only the executable's process policy; imported boot() keeps its own lifecycle.
export function installProcessLifecycle(app: ProcessApplication, options: LifecycleOptions = {}) {
  installLogOutputGuards();
  const timeoutMs = shutdownTimeout(options);
  let closing = false, fatal = false, failed = false, reporting = false;
  let deadline: ReturnType<typeof setTimeout>;

  const report = (message: string, error: unknown) => {
    if (reporting) return;
    reporting = true;
    try { app.logger.error(message, { error }); }
    catch { writeLogOutput(`${message}（日志记录失败）`, "stderr"); }
    finally { reporting = false; }
  };
  const finish = () => {
    clearTimeout(deadline);
    process.exit(failed ? 1 : 0);
  };
  const onDeadline = async () => {
    const commit = app.pendingPackageCommit?.();
    if (commit) {
      // A multi-plugin commit can still need to undo an earlier dependency while a later step is running.
      await commit;
      deadline = setTimeout(onDeadline, timeoutMs);
      return;
    }
    failed = true;
    writeLogOutput("WhaleLife 关闭超时，强制退出", "stderr");
    finish();
  };
  const shutdown = () => {
    if (closing) return;
    // Set the guard and deadline before calling any application or logger code.
    closing = true;
    deadline = setTimeout(onDeadline, timeoutMs);
    // A synchronous throw and a rejected close() share the same rejection handler.
    void Promise.resolve().then(() => app.close()).then(finish, () => {
      failed = true;
      writeLogOutput("WhaleLife 关闭失败，强制退出", "stderr");
      finish();
    });
  };
  const onException = (error: unknown) => {
    failed = true;
    process.exitCode = 1;
    if (fatal) return;
    fatal = true;
    shutdown();
    report("未捕获异常", error);
  };
  const onRejection = (error: unknown) => {
    if (!fatal) report("未处理 Promise 拒绝", error);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return shutdown;
}

export async function runMain(start: () => Promise<ProcessApplication>, options: LifecycleOptions = {}) {
  installLogOutputGuards();
  try { installProcessLifecycle(await start(), options); }
  catch (error) {
    process.exitCode = 1;
    // A failed boot may have opened handles before it could return app.close().
    // Allow ordinary output/handle cleanup, but do not leave that partial app running forever.
    setTimeout(() => process.exit(1), shutdownTimeout(options)).unref();
    let message = "无法读取错误信息";
    try { message = error instanceof Error ? error.message : String(error); } catch {}
    writeLogOutput(`WhaleLife 启动失败：${message}`, "stderr");
  }
}
