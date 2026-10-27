import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.ts";
import { Memory } from "./memory.ts";
import { LLM } from "./llm.ts";
import { Tools } from "./tools.ts";
import { approval } from "./permission.ts";
import { Runtime } from "./runtime.ts";
import { Sessions } from "./session.ts";
import { startWeb } from "./web.ts";
import { ModelConfig, resolveModel } from "./model-config.ts";
import { PersonaFiles } from "./persona-config.ts";
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
    llm,
    tools,
    approval,
    modelConfig,
    personaFiles: new PersonaFiles(root, config, logger),
    channels: {
      register() {
        throw Error("M0 仅提供 Web 渠道");
      },
      send() {
        throw Error("M0 渠道接口预留");
      },
    },
  };
  for (const id of ["logger", "memory", "llm", "tools", "approval", "channels"])
    await runtime.builtin(id, services[id]);
  await runtime.builtin("permission", { approval });
  await runtime.builtin("facts", memory, (ctx) =>
    ctx.tools.register({
      name: "remember_fact",
      description:
        "当用户明确要求记下、记住一条长期事实或约定时调用，将事实保存至跨会话共享记忆",
      schema: { text: { type: "string" } },
      danger: "ask",
      async run(args: any) {
        return memory.addFact(args.text);
      },
    }),
  );
  const sessions = new Sessions(root, config, services);
  services.sessions = sessions;
  await runtime.builtin("chat", sessions);
  const web = await startWeb(config, services, runtime);
  services.web = web;
  await runtime.builtin("web", web);
  await runtime.bus.start();
  await runtime.scan();
  logger.info("核心就绪");
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    logger.info("WhaleLife 关闭");
    await web.close();
    await runtime.bus.stop();
    await memory.queue;
  };
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
