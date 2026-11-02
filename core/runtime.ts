/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { Context as Cordis } from "@cordisjs/core";
import { readFileSync } from "node:fs";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { atomic } from "./memory.ts";
import type { Logger } from "./logger.ts";
import { PluginState, validPluginId } from "./plugin-state.ts";
import { PluginEvents } from "./plugin-events.ts";
import { PluginProcess, pluginRuntimeOptions, type PluginRuntimeOptions } from "./plugin-process.ts";
import { assertPluginCompatibility, PLUGIN_API_VERSION } from "./plugin-compatibility.ts";
import { OptionalServices } from "./optional-services.ts";
export class Runtime {
  bus = new Cordis();
  records = new Map<string, any>();
  services = new Map<string, any>();
  root: string;
  logger: Logger;
  pluginState: PluginState;
  events: PluginEvents;
  private actions: Promise<unknown> = Promise.resolve();
  private closing = false;
  private processOptions: ReturnType<typeof pluginRuntimeOptions>;
  private optionalServices: OptionalServices;
  beginClose() {
    this.closing = true;
    for (const record of this.records.values()) record.controller?.abort(Error("核心正在关闭"));
  }
  constructor(root: string, logger: Logger, options: PluginRuntimeOptions = {}) {
    this.root = root;
    this.logger = logger;
    this.processOptions = pluginRuntimeOptions(options);
    this.optionalServices = new OptionalServices((record, name) => {
      let at = record;
      while (at && !at.local?.has(name)) at = at.parent;
      at ??= this.records.get(this.services.get(name)?.owner);
      if (!at || at.manifest.builtin || at.status !== "active" || at.controller?.signal.aborted) return;
      const value = at.local.get(name);
      return value === undefined ? undefined : { owner: at, value };
    }, this.processOptions.callTimeoutMs, this.processOptions.stopTimeoutMs);
    this.pluginState = new PluginState(root);
    this.events = new PluginEvents(logger);
    this.bus.on("internal/error", (...args: any[]) =>
      logger.error("cordis 错误", args.map(String)),
    );
    const stop = this.bus.stop.bind(this.bus);
    this.bus.stop = async () => {
      this.beginClose();
      await stop();
      await Promise.allSettled([...this.records.values()].map((record) => record.execution?.close()));
    };
  }
  list() {
    return [...this.records.values()].map(
      ({ id, manifest, status, error }) => ({ ...manifest, id, status, error,
        enabled: manifest.builtin || this.pluginState.enabled(id), apiVersion: manifest.apiVersion ?? "1.x" }),
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
    if (this.closing) throw Error("核心正在关闭");
    if (!validPluginId(id)) throw Error("插件 ID 无效");
    if (this.records.get(id)?.status === "active") return this.records.get(id);
    const parts = id.split("/");
    const parent =
      parts.length > 1
        ? this.records.get(parts.slice(0, -1).join("/"))
        : undefined;
    const dir = join(this.root, "plugins", parts.join("/sub/"));
    let manifest: any;
    try {
      await this.pluginState.load();
      manifest = parse(await readFile(join(dir, "plugin.yaml"), "utf8"));
      for (const key of ["id", "name", "description", "version"])
        if (typeof manifest[key] !== "string")
          throw Error("manifest 缺少 " + key);
      if (manifest.id !== basename(dir))
        throw Error("manifest ID 必须匹配目录");
      manifest.builtin = false;
      assertPluginCompatibility(manifest);
      if (manifest.console?.groupChildren !== undefined && typeof manifest.console.groupChildren !== "boolean")
        throw Error("console.groupChildren 必须是布尔值");
      if (manifest.depends !== undefined && (!Array.isArray(manifest.depends) || manifest.depends.some((name: any) => typeof name !== "string")))
        throw Error("插件依赖必须是服务名称数组");
      if (manifest.optionalDepends !== undefined && (!Array.isArray(manifest.optionalDepends) || manifest.optionalDepends.some((name: any) =>
        typeof name !== "string" || !name.trim() || name.length > 200 || manifest.depends?.includes(name))))
        throw Error("optionalDepends 必须是非空服务名称数组，不能重复声明必需依赖");
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
      return await this.load(id, manifest, undefined, parent, dir, true);
    } catch (error: any) {
      this.logger.error("插件加载失败", { id, error });
      this.records.set(id, {
        id,
        manifest: manifest && typeof manifest === "object" ? { ...manifest, builtin: false } : { name: id },
        status: "failed",
        error: error?.message ?? String(error),
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
    isolated = false,
  ) {
    if (this.closing) throw Error("核心正在关闭");
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
      record.error = error?.message ?? String(error);
      this.logger.error("插件失败", { id, error });
    };
    let finish!: () => void;
    const complete = new Promise<void>((r) => (finish = r));
    record.fork = (parent?.cordis ?? this.bus).plugin(async (native: any) => {
      record.cordis = native;
      const controller = new AbortController();
      record.controller = controller;
      controller.signal.addEventListener("abort", () => this.optionalServices.refresh(), { once: true });
      const alive = () => controller.signal.throwIfAborted();
      const log = Object.freeze(Object.fromEntries(["log", "debug", "info", "warn", "error"].map((name) => [name, (...args: any[]) => (this.logger as any)[name](...args)])));
      native.effect(() => () => controller.abort(Error("插件已停用")));
      let pluginMemory: any;
      let pluginChannels: any;
      const facades = new Map<string, any>();
      const get = (name: string, strict = true) => {
        alive();
        const value = lookup(name);
        if (value === undefined && strict) {
          record.missingDependencies.add(name);
          throw Error("依赖缺失：" + name);
        }
        if (value !== undefined) record.dependencies.add(name);
        if (name === "logger" && !manifest.builtin) return log;
        if (name === "approval" && !manifest.builtin) {
          if (!facades.has(name) && value) facades.set(name, Object.freeze({ request: (...args: any[]) => { alive(); return value.request(...args); } }));
          return facades.get(name);
        }
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
        if (name === "chat" && !manifest.builtin)
          throw Error("请使用 ctx.sessions 调用带人格和记忆的会话");
        if (!manifest.builtin && ["web", "tools", "llm", "models", "personas", "sessions"].includes(name) && value) {
          if (facades.has(name)) return facades.get(name);
          let facade: any;
          if (name === "web") facade = {
            page: (path: string, handler: any, entry?: any) => { alive(); const dispose = value.registerPlugin(id, controller.signal, "GET", path, handler, entry); return native.effect(() => dispose); },
            api: (path: string, handler: any) => { alive(); const dispose = value.registerPlugin(id, controller.signal, "POST", path, handler); return native.effect(() => dispose); },
          };
          if (name === "tools") facade = {
            register: (tool: any) => { alive(); const dispose = value.register({ ...tool, owner: id }, controller.signal); return native.effect(() => dispose); },
            registerTransient: (tool: any) => { alive(); const dispose = value.registerTransient({ ...tool, owner: id }, controller.signal); return native.effect(() => dispose); },
            list: () => { alive(); return structuredClone(value.list()); },
            call: (name: string, args: any, session: any, ...rest: any[]) => { alive(); return value.call(name, args, { ...session, signal: AbortSignal.any([controller.signal, ...(session?.signal ? [session.signal] : [])]) }, ...rest); },
          };
          if (name === "llm") facade = { chat: (options: any) => { alive(); return value.chat({ ...options, signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]) }); } };
          if (name === "models" || name === "personas") facade = { list: (...args: any[]) => { alive(); return value.list(...args); },
            ...(name === "models" ? { connection: (selected: string) => { alive(); return value.connection(selected); } } : {}) };
          if (name === "sessions") facade = value.plugin(id, controller.signal);
          Object.freeze(facade); facades.set(name, facade); return facade;
        }
        return value;
      };
      const config: any = (file = manifest.config ?? "config.json") => {
        alive();
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
        alive();
        try {
          return JSON.parse(await readFile(configPath(file), "utf8"));
        } catch (error: any) {
          if (error.code !== "ENOENT")
            this.logger.warn("插件配置损坏，使用默认值", { id, error });
          return {};
        }
      };
      config.save = async (file: string, value: any) => {
        alive();
        const target = configPath(file);
        await mkdir(join(target, ".."), { recursive: true });
        await atomic(target, JSON.stringify(value, null, 2));
      };
      const ctx: any = {
        get,
        optional: (name: string, listener: any) => {
          alive();
          return native.effect(() => this.optionalServices.watch(record, name, listener, (error) => {
            if (controller.signal.aborted || this.records.get(id) !== record) return;
            fail(error);
            void this.stop(id, true).catch((cleanup) => this.logger.error("可选服务消费者清理失败", { id, error: cleanup }));
          }));
        },
        logger: manifest.builtin ? this.logger : log,
        apiVersion: PLUGIN_API_VERSION,
        signal: controller.signal,
        config,
        provide: (name: string, value: any) => {
          alive();
          if (record.local.has(name) || (!parent && this.services.has(name)))
            throw Error("服务重名：" + name);
          record.local.set(name, value);
          record.provided.add(name);
          if (!parent) this.services.set(name, { value, owner: id });
          native.effect(() => () => {
            record.local.delete(name);
            if (!parent && this.services.get(name)?.owner === id)
              this.services.delete(name);
            this.optionalServices.refresh();
          });
          this.optionalServices.refresh();
        },
        effect: (fn: any) => { alive(); return native.effect(fn); },
        on: (event: string, fn: any) => {
          alive();
          const dispose = this.events.on(event, async (...args: any[]) => {
            if (controller.signal.aborted) return;
            try {
              await fn(...args);
            } catch (error) {
              if (controller.signal.aborted || this.records.get(id) !== record) return;
              fail(error);
              await this.stop(id, true);
            }
          });
          return native.effect(() => dispose);
        },
        emit: (event: string, payload: any) => { alive();
          if (!event.startsWith(`plugin:${id}:`) || event.length > 200) throw Error("插件只能发布 plugin:<自身ID>:<事件>，不能伪造核心事件");
          this.events.emit(event, payload);
        },
        plugin: (module: any) => {
          alive();
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
            const child = await this.loadPath(id + "/" + target);
            return { id: child.id, status: child.status, error: child.error };
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
        "models",
        "personas",
        "sessions",
      ])
        Object.defineProperty(ctx, name, {
          get: () => {
            const service = get(name);
            if (!manifest.builtin) return service;
            if (name === "web")
              return {
                ...service,
                page: (...args: any[]) => {
                  const dispose = service.page(...args);
                  return native.effect(() => dispose);
                },
                api: (...args: any[]) => {
                  const dispose = service.api(...args);
                  return native.effect(() => dispose);
                },
              };
            if (name !== "tools") return service;
            return {
              register: (tool: any) => {
                const dispose = service.register({ ...tool, owner: id });
                return native.effect(() => dispose);
              },
              registerTransient: (tool: any) => {
                const dispose = service.registerTransient({ ...tool, owner: id });
                return native.effect(() => dispose);
              },
              list: () => service.list(),
              call: (...args: any[]) => service.call(...args),
            };
          },
        });
      try {
        for (const name of manifest.depends ?? []) get(name);
        if (isolated) {
          const execution = new PluginProcess(id, ctx, this.processOptions, (error) => {
            if (this.records.get(id) !== record || controller.signal.aborted) return;
            fail(error);
            void this.stop(id, true).catch((cleanup) => this.logger.error("故障插件清理失败", { id, error: cleanup }));
          });
          record.execution = execution;
          native.effect(() => () => { void execution.close(); });
          await execution.start(dir!);
        } else {
          if (typeof apply !== "function") throw Error("插件缺少 apply");
          await apply(ctx);
        }
        alive();
        record.status = "active";
        this.optionalServices.refresh();
        await Promise.all(record.pending);
        if (dir) await this.children(record);
        this.logger.info("插件加载", { id });
      } catch (error) {
        fail(error);
        controller.abort(error);
      } finally {
        finish();
      }
    });
    await complete;
    if (["failed", "blocked"].includes(record.status)) {
      for (const child of this.records.values())
        if (child.parent === record && child.status === "active")
          await this.stop(child.id, true);
      await record.fork.dispose();
      await record.execution?.close();
    }
    return record;
  }
  async stop(id: string, internal = false, reason?: string) {
    const record = this.records.get(id);
    if (!record) throw Error("插件不存在");
    if (record.manifest.builtin && !internal) throw Error("内置插件不可卸载");
    if (record.stopping) return record.stopping;
    record.stopping = (async () => {
    record.controller?.abort(Error("插件已停用"));
    for (const child of this.records.values())
      if (child.parent === record && child.status === "active")
        await this.stop(child.id, true, "父插件未启用：" + id);
    await record.fork?.dispose();
    await record.execution?.close();
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
    })();
    return record.stopping;
  }
  async action(id: string, action: string) {
    return this.serial(async () => {
      if (this.closing) throw Error("核心正在关闭");
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
