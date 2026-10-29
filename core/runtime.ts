import { Context as Cordis } from "@cordisjs/core";
import { readFileSync } from "node:fs";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { atomic } from "./memory.ts";
import type { Logger } from "./logger.ts";
import { PluginState, validPluginId } from "./plugin-state.ts";
export class Runtime {
  bus = new Cordis();
  records = new Map<string, any>();
  services = new Map<string, any>();
  root: string;
  logger: Logger;
  pluginState: PluginState;
  private actions: Promise<unknown> = Promise.resolve();
  constructor(root: string, logger: Logger) {
    this.root = root;
    this.logger = logger;
    this.pluginState = new PluginState(root);
    this.bus.on("internal/error", (...args: any[]) =>
      logger.error("cordis 错误", args.map(String)),
    );
  }
  list() {
    return [...this.records.values()].map(
      ({ id, manifest, status, error }) => ({ ...manifest, id, status, error,
        enabled: manifest.builtin || this.pluginState.enabled(id) }),
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
    return this.serial(async () => {
      await mkdir(join(this.root, "plugins"), { recursive: true });
      for (const dir of await readdir(join(this.root, "plugins"), {
        withFileTypes: true,
      }))
        if (dir.isDirectory()) await this.loadPath(dir.name);
      await this.resumeBlocked();
    });
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.actions.then(task);
    this.actions = result.catch(() => {});
    return result;
  }
  private lookup(record: any, name: string) {
    let at = record;
    while (at) {
      if (at.local?.has(name)) return at.local.get(name);
      at = at.parent;
    }
    return this.services.get(name)?.value;
  }
  private async children(record: any) {
    let dirs;
    try { dirs = await readdir(join(record.dir, "sub"), { withFileTypes: true }); }
    catch (error: any) { if (error.code === "ENOENT") return; throw error; }
    for (const child of dirs) {
      if (!child.isDirectory() || (Array.isArray(record.manifest.sub) && !record.manifest.sub.includes(child.name))) continue;
      const id = record.id + "/" + child.name;
      if (this.records.get(id)?.parent !== record) await this.loadPath(id);
    }
  }
  private async resumeBlocked() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const record of [...this.records.values()]) {
        if (record.status !== "blocked" || !record.dir || !this.pluginState.enabled(record.id)) continue;
        const parent = record.parent ? this.records.get(record.parent.id) : undefined;
        if (parent && parent.status !== "active") continue;
        const dependencies = new Set([...(record.manifest.depends ?? []),
          ...[...(record.dependencies ?? [])].filter((name) => !record.provided?.has(name)), ...(record.missingDependencies ?? [])]);
        if ([...dependencies].some((name) => this.lookup({ parent }, name as string) === undefined)) continue;
        const loaded = await this.loadPath(record.id);
        if (loaded.status === "active") progress = true;
      }
    }
  }
  async loadPath(id: string) {
    if (!validPluginId(id)) throw Error("插件 ID 无效");
    if (this.records.get(id)?.status === "active") return this.records.get(id);
    const parts = id.split("/");
    const parent =
      parts.length > 1
        ? this.records.get(parts.slice(0, -1).join("/"))
        : undefined;
    const dir = join(this.root, "plugins", parts.join("/sub/"));
    try {
      await this.pluginState.load();
      const manifest = parse(await readFile(join(dir, "plugin.yaml"), "utf8"));
      for (const key of ["id", "name", "description", "version"])
        if (typeof manifest[key] !== "string")
          throw Error("manifest 缺少 " + key);
      if (manifest.id !== basename(dir))
        throw Error("manifest ID 必须匹配目录");
      manifest.builtin = false;
      if (manifest.depends !== undefined && (!Array.isArray(manifest.depends) || manifest.depends.some((name: any) => typeof name !== "string")))
        throw Error("插件依赖必须是服务名称数组");
      const enabled = this.pluginState.enabled(id);
      const missing = (manifest.depends ?? []).filter((name: string) => this.lookup({ parent }, name) === undefined);
      const blocked = parts.length > 1 && !["active", "loading"].includes(parent?.status)
        ? "父插件未启用：" + parts.slice(0, -1).join("/")
        : missing.length ? "等待依赖：" + missing.join("、") : undefined;
      if (!enabled || blocked) {
        const record = { id, manifest, dir, parent, status: enabled ? "blocked" : "stopped",
          error: enabled ? blocked : undefined, dependencies: new Set(manifest.depends ?? []), local: new Map() };
        this.records.set(id, record);
        await this.children(record);
        return record;
      }
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
      missingDependencies: new Set(),
      provided: new Set(),
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
      record.status = record.missingDependencies.size ? "blocked" : "failed";
      record.error = error.message;
      this.logger.error("插件失败", { id, error });
    };
    let finish!: () => void;
    const complete = new Promise<void>((r) => (finish = r));
    record.fork = (parent?.cordis ?? this.bus).plugin(async (native: any) => {
      record.cordis = native;
      let pluginMemory: any;
      let pluginChannels: any;
      const get = (name: string, strict = true) => {
        const value = lookup(name);
        if (value === undefined && strict) {
          record.missingDependencies.add(name);
          throw Error("依赖缺失：" + name);
        }
        if (value !== undefined) record.dependencies.add(name);
        if (name === "channels" && value?.plugin) {
          pluginChannels ??= value.plugin(id, (dispose: any) =>
            native.effect(() => dispose),
          );
          return pluginChannels;
        }
        if (name === "memory" && !manifest.builtin && value?.engine) {
          pluginMemory ??= value.engine.plugin(id, (dispose: any) =>
            native.effect(() => dispose),
          );
          return pluginMemory;
        }
        if (name === "facts" && !manifest.builtin)
          throw Error("事实管理服务仅供核心使用；插件使用memory接口");
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
          record.provided.add(name);
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
                const dispose = service.register({ ...tool, owner: id });
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
        if (dir) await this.children(record);
        this.logger.info("插件加载", { id });
      } catch (error) {
        fail(error);
      } finally {
        finish();
      }
    });
    await complete;
    if (["failed", "blocked"].includes(record.status)) {
      for (const child of this.records.values())
        if (child.parent === record && child.status === "active")
          await this.stop(child.id, true);
      record.fork.dispose();
    }
    return record;
  }
  async stop(id: string, internal = false, reason?: string) {
    const record = this.records.get(id);
    if (!record) throw Error("插件不存在");
    if (record.manifest.builtin && !internal) throw Error("内置插件不可卸载");
    for (const child of this.records.values())
      if (child.parent === record && child.status === "active")
        await this.stop(child.id, true, "父插件未启用：" + id);
    record.fork?.dispose();
    if (record.status !== "failed") { record.status = "stopped"; record.error = undefined; }
    if (reason && this.pluginState.enabled(id)) { record.status = "blocked"; record.error = reason; }
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
        await this.stop(other.id, true, "等待依赖恢复");
  }
  async action(id: string, action: string) {
    return this.serial(async () => {
      if (!validPluginId(id)) throw Error("插件 ID 无效");
      const record = this.records.get(id);
      if (!record) throw Error("插件不存在");
      if (record?.manifest.builtin) throw Error("内置插件不可管理");
      if (!["stop", "start", "reload"].includes(action)) throw Error("操作无效");
      await this.pluginState.load();
      if (action === "stop") {
        await this.pluginState.setEnabled(id, false);
        return this.stop(id);
      }
      if (action === "start") {
        if (record.parent && this.records.get(record.parent.id)?.status !== "active")
          throw Error("请先启用父插件：" + record.parent.id);
        await this.pluginState.setEnabled(id, true);
      }
      if (action === "reload" && record) await this.stop(id);
      const loaded = await this.loadPath(id);
      await this.resumeBlocked();
      return loaded;
    });
  }
}
