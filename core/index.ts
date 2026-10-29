import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.ts";
import { Memory } from "./memory.ts";
import { MemoryAdmin } from "./memory-admin.ts";
import { LLM } from "./llm.ts";
import { Tools } from "./tools.ts";
import { approval } from "./permission.ts";
import { Runtime } from "./runtime.ts";
import { Sessions } from "./session.ts";
import { Channels } from "./channels.ts";
import { startWeb } from "./web.ts";
import { ModelConfig, resolveModel } from "./model-config.ts";
import { PersonaFiles } from "./persona-config.ts";
import { MemoryEngine } from "./memory-engine.ts";
import { registerMemoryTools } from "./memory-tools.ts";
import { pluginServices } from "./plugin-services.ts";
export async function boot(
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const config = JSON.parse(
    (await readFile(resolve(root, "config/config.json"), "utf8")).replace(
      /^\uFEFF/,
      "",
    ),
  );
  const logger = new Logger(
    resolve(root, "logs"),
    config.log,
    config.providers.map((p: any) => p.api_key),
  );
  logger.info("WhaleLife 启动");
  logger.info("配置加载与校验", {
    providers: config.providers.map((p: any) => p.id),
  });
  const modelConfig = new ModelConfig(root, config, logger);
  const memory = new Memory(resolve(root, config.memory.root), logger);
  await memory.init();
  const memoryEngine = new MemoryEngine(memory);
  (memory as any).engine = memoryEngine;
  await memoryEngine.recoverSummaries();
  for (const [id, p] of Object.entries<any>(config.personas)) {
    const file = resolve(root, p.file);
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(
        file,
        `# ${p.name}\n你是鲸鲸，温柔、真诚、清醒的本地伙伴。用自然的中文交流。记忆以共享事实和会话记录为准；不编造经历或用户资料。\n`,
        { flag: "wx" },
      );
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
    logger.info("人格就绪", { id });
  }
  const llm = new LLM(logger, config.providers, (id) =>
      resolveModel(config, id),
    ),
    tools = new Tools(logger, config.permissions?.tools);
  const runtime = new Runtime(root, logger);
  const services: any = {
    logger,
    memory,
    memoryEngine,
    llm,
    tools,
    approval,
    modelConfig,
    personaFiles: new PersonaFiles(root, config, logger),
  };
  const sessions = new Sessions(root, config, services);
  services.sessions = sessions;
  services.channels = new Channels(memory, sessions, config);
  memory.onChange = (name, payload) => runtime.events.emit(name, payload);
  const extensionServices = pluginServices(config, modelConfig, sessions, memory);
  for (const [name, service] of Object.entries(extensionServices)) await runtime.builtin(name, service);
  for (const id of ["logger", "memory", "llm", "tools", "approval", "channels"])
    await runtime.builtin(id, services[id]);
  await runtime.builtin("permission", { approval });
  await runtime.builtin("facts", {}, (ctx) =>
    registerMemoryTools(ctx.tools, memoryEngine),
  );
  memoryEngine.maintenance = (id) =>
    sessions.memoryMaintenance || !!(id && sessions.blockedSessions.has(id));
  tools.observe = async (event) => {
    runtime.events.emit("tool/called", { id: event.id, name: event.name, source: event.source,
      origin: event.origin, session: event.session?.id, ok: event.ok, result: event.result });
    if (
      !event.session?.id ||
      ["recall_memory", "remember_fact", "edit_facts"].includes(event.name)
    )
      return;
    await memoryEngine.experience(event.session.id, event.source, {
      event_id: event.id,
      origin: event.origin,
      outcome: event.ok ? "succeeded" : "failed",
      text: `工具 ${event.name} ${event.ok ? "调用完成" : "调用失败"}：${String(JSON.stringify(event.result)).slice(0, 350)}`,
    });
  };
  services.memoryAdmin = new MemoryAdmin(memory, sessions, logger);
  await runtime.builtin("chat", sessions);
  const web = await startWeb(config, services, runtime);
  services.web = web;
  await runtime.builtin("web", web);
  await runtime.bus.start();
  await runtime.scan();
  runtime.events.emit("whalelife/ready", { at: new Date().toISOString() });
  logger.info("核心就绪");
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    logger.info("WhaleLife 关闭");
    runtime.events.emit("whalelife/shutdown", { at: new Date().toISOString() });
    // Let shutdown listeners receive the notification before their subscriptions are removed.
    await new Promise<void>((r) => setImmediate(r));
    sessions.beginClose();
    services.channels.beginClose();
    runtime.beginClose();
    await Promise.all([web.close(), sessions.close(), services.channels.close(), runtime.bus.stop()]);
    await memory.queue;
  })();
  return { config, ...services, runtime, close };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  boot()
    .then((app) => {
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        process.on(signal, () => void app.close().then(() => process.exit(0)));
      process.on("uncaughtException", (error) => {
        app.logger.error("未捕获异常", { error });
        void app.close().finally(() => process.exit(1));
      });
      process.on("unhandledRejection", (error) =>
        app.logger.error("未处理 Promise 拒绝", { error }),
      );
    })
    .catch((error) => {
      console.error("WhaleLife 启动失败：", error.message);
      process.exitCode = 1;
    });
}
