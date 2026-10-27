import { Context as Cordis } from "@cordisjs/core";
import { readFileSync } from "node:fs";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { atomic } from "./memory.ts";
import type { Logger } from "./logger.ts";
export class Runtime {
  bus = new Cordis();
  records = new Map<string, any>();
  services = new Map<string, any>();
  root: string;
  logger: Logger;
  constructor(root: string, logger: Logger) {
    this.root = root;
    this.logger = logger;
    this.bus.on("internal/error", (...args: any[]) =>
      logger.error("cordis 错误", args.map(String)),
    );
  }
  list() {
    return [...this.records.values()].map(
      ({ id, manifest, status, error }) => ({ ...manifest, id, status, error }),
    );
  }
  async builtin(id: string, value: any, setup?: (ctx: any) => any) {
    return this.load(
      id,
      {
        id,
        name: id,
        description: "核心服务",
        version: "0.1.0",
        builtin: true,
      },
      async (ctx: any) => {
        ctx.provide(id, value);
        await setup?.(ctx);
      },
    );
  }
  async scan() {
    await mkdir(join(this.root, "plugins"), { recursive: true });
    for (const dir of await readdir(join(this.root, "plugins"), {
      withFileTypes: true,
    }))
      if (dir.isDirectory()) await this.loadPath(dir.name);
  }
  async loadPath(id: string) {
    const parts = id.split("/");
    if (parts.some((p) => !/^[a-z][a-z0-9-]*$/.test(p)))
      throw Error("插件 ID 无效");
    const parent =
      parts.length > 1
        ? this.records.get(parts.slice(0, -1).join("/"))
        : undefined;
    const dir = join(this.root, "plugins", parts.join("/sub/"));
    try {
      if (parts.length > 1 && !["active", "loading"].includes(parent?.status))
        throw Error("父插件缺失");
      const manifest = parse(await readFile(join(dir, "plugin.yaml"), "utf8"));
      for (const key of ["id", "name", "description", "version"])
        if (typeof manifest[key] !== "string")
          throw Error("manifest 缺少 " + key);
      if (manifest.id !== basename(dir))
        throw Error("manifest ID 必须匹配目录");
      manifest.builtin = false;
      const module = await import(
        pathToFileURL(join(dir, "index.ts")).href + "?v=" + crypto.randomUUID()
      );
      return await this.load(id, manifest, module.apply, parent, dir);
    } catch (error: any) {
      this.logger.error("插件加载失败", { id, error });
      this.records.set(id, {
        id,
        manifest: { name: id },
        status: "failed",
        error: error.message,
        dir,
        parent,
      });
      return this.records.get(id);
    }
  }
  async load(
    id: string,
    manifest: any,
    apply: any,
    parent?: any,
    dir?: string,
  ) {
    if (this.records.get(id)?.status === "active") return this.records.get(id);
    const record: any = {
      id,
      manifest,
      parent,
      dir,
      status: "loading",
      local: new Map(),
      dependencies: new Set(),
      pending: [],
    };
    this.records.set(id, record);
    const lookup = (name: string) => {
      let at = record;
      while (at) {
        if (at.local.has(name)) return at.local.get(name);
        at = at.parent;
      }
      return this.services.get(name)?.value;
    };
    const fail = (error: any) => {
      record.status = "failed";
      record.error = error.message;
      this.logger.error("插件失败", { id, error });
    };
    let finish!: () => void;
    const complete = new Promise<void>((r) => (finish = r));
    record.fork = (parent?.cordis ?? this.bus).plugin(async (native: any) => {
      record.cordis = native;
      const get = (name: string, strict = true) => {
        const value = lookup(name);
        if (value === undefined && strict) throw Error("依赖缺失：" + name);
        if (value !== undefined) record.dependencies.add(name);
        return value;
      };
      const config: any = (file = manifest.config ?? "config.json") => {
        const target = configPath(file);
        try {
          return JSON.parse(requireRead(target));
        } catch (error: any) {
          if (error.code !== "ENOENT")
            this.logger.warn("插件配置损坏，使用默认值", { id, error });
          return {};
        }
      };
      const configPath = (file: string) => {
        const base = join(dir ?? join(this.root, "config"), "data");
        const target = resolve(base, file);
        if (!target.startsWith(base + "\\") && !target.startsWith(base + "/"))
          throw Error("配置路径越界");
        return target;
      };
      const requireRead = (file: string) => {
        try {
          return readFileSync(file, "utf8");
        } catch (error: any) {
          if (error.code !== "ENOENT")
            this.logger.warn("插件配置读取失败，使用默认值", { id, error });
          throw error;
        }
      };
      config.read = async (file = manifest.config ?? "config.json") => {
        try {
          return JSON.parse(await readFile(configPath(file), "utf8"));
        } catch (error: any) {
          if (error.code !== "ENOENT")
            this.logger.warn("插件配置损坏，使用默认值", { id, error });
          return {};
        }
      };
      config.save = async (file: string, value: any) => {
        const target = configPath(file);
        await mkdir(join(target, ".."), { recursive: true });
        await atomic(target, JSON.stringify(value, null, 2));
      };
      const ctx: any = {
        get,
        logger: this.logger,
        config,
        provide: (name: string, value: any) => {
          if (record.local.has(name) || (!parent && this.services.has(name)))
            throw Error("服务重名：" + name);
          record.local.set(name, value);
          if (!parent) this.services.set(name, { value, owner: id });
          native.effect(() => () => {
            record.local.delete(name);
            if (!parent && this.services.get(name)?.owner === id)
              this.services.delete(name);
          });
        },
        effect: (fn: any) => native.effect(fn),
        on: (event: string, fn: any) =>
          native.on(event, async (...args: any[]) => {
            try {
              await fn(...args);
            } catch (error) {
              fail(error);
              await this.stop(id, true);
            }
          }),
        plugin: (module: any) => {
          const task = Promise.resolve(module).then(async (mod) => {
            let target = mod.id;
            if (!target && dir) {
              for (const child of await readdir(join(dir, "sub"), {
                withFileTypes: true,
              })) {
                if (!child.isDirectory()) continue;
                const candidate = await import(
                  pathToFileURL(join(dir, "sub", child.name, "index.ts")).href
                );
                if (candidate.apply === mod.apply) {
                  target = child.name;
                  break;
                }
              }
            }
            if (!target) throw Error("无法确定子插件目录，请导出 id");
            return this.loadPath(id + "/" + target);
          });
          record.pending.push(task);
          return task;
        },
      };
      for (const name of [
        "tools",
        "llm",
        "memory",
        "approval",
        "channels",
        "web",
      ])
        Object.defineProperty(ctx, name, {
          get: () => {
            const service = get(name);
            if (name === "web")
              return {
                ...service,
                page: (...args: any[]) => {
                  const dispose = service.page(...args);
                  native.effect(() => dispose);
                  return dispose;
                },
                api: (...args: any[]) => {
                  const dispose = service.api(...args);
                  native.effect(() => dispose);
                  return dispose;
                },
              };
            if (name !== "tools") return service;
            return {
              register: (tool: any) => {
                const dispose = service.register(tool);
                native.effect(() => dispose);
                return dispose;
              },
              list: () => service.list(),
              call: (...args: any[]) => service.call(...args),
            };
          },
        });
      try {
        for (const name of manifest.depends ?? []) get(name);
        if (typeof apply !== "function") throw Error("插件缺少 apply");
        await apply(ctx);
        record.status = "active";
        await Promise.all(record.pending);
        if (dir) {
          let children: string[] = [];
          try {
            children = (
              await readdir(join(dir, "sub"), { withFileTypes: true })
            )
              .filter((d) => d.isDirectory())
              .map((d) => d.name);
          } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
          }
          for (const child of children)
            if (
              (!Array.isArray(manifest.sub) || manifest.sub.includes(child)) &&
              this.records.get(id + "/" + child)?.status !== "active"
            )
              await this.loadPath(id + "/" + child);
        }
        this.logger.info("插件加载", { id });
      } catch (error) {
        fail(error);
      } finally {
        finish();
      }
    });
    await complete;
    if (record.status === "failed") {
      for (const child of this.records.values())
        if (child.parent === record && child.status === "active")
          await this.stop(child.id, true);
      record.fork.dispose();
    }
    return record;
  }
  async stop(id: string, internal = false) {
    const record = this.records.get(id);
    if (!record) throw Error("插件不存在");
    if (record.manifest.builtin && !internal) throw Error("内置插件不可卸载");
    for (const child of this.records.values())
      if (child.parent === record && child.status === "active")
        await this.stop(child.id, true);
    record.fork?.dispose();
    if (record.status !== "failed") record.status = "stopped";
    this.logger.info("插件卸载", { id });
    for (const other of this.records.values())
      if (
        other.status === "active" &&
        [...other.dependencies].some((n: any) => {
          let at = other;
          while (at) {
            if (at.local.has(n)) return false;
            at = at.parent;
          }
          return !this.services.has(n);
        })
      )
        await this.stop(other.id, true);
  }
  async action(id: string, action: string) {
    const record = this.records.get(id);
    if (record?.manifest.builtin) throw Error("内置插件不可管理");
    if (action === "stop") return this.stop(id);
    if (action === "reload" && record) await this.stop(id);
    if (!["start", "reload"].includes(action)) throw Error("操作无效");
    return this.loadPath(id);
  }
}
