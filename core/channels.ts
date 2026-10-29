import { createHash, randomUUID } from "node:crypto";
import { safeId } from "./memory.ts";
import type { Memory } from "./memory.ts";
import type { Sessions } from "./session.ts";
import type { Permission } from "./permission.ts";
import { validateOrigin, type Origin } from "./provenance.ts";

export type ChannelRoute = {
  channel: string;
  account: string;
  peer: string;
  sender?: string;
  messageId?: string;
  persona: string;
  permission: Permission;
  signal?: AbortSignal;
  origin?: Origin;
};
export type IncomingMessage = {
  peer: string;
  sender: string;
  messageId: string;
  text: string;
};
export type OutgoingMessage = {
  channel: string;
  account: string;
  peer: string;
  sessionId: string;
  text: string;
  deliveryId: string;
  replyTo?: string;
};
export type ChannelAdapter = {
  id: string;
  name?: string;
  account: string;
  persona?: string;
  permission?: Permission;
  send(message: OutgoingMessage, options: { signal: AbortSignal }): Promise<void>;
};
export type ChannelResult = {
  sessionId: string;
  messageId: string;
  deliveryId: string;
  status: "sent" | "generated" | "generation_failed" | "delivery_failed" | "uncertain";
  text?: string;
  error?: string;
  duplicate?: boolean;
};
export type ReceiveOptions = { signal?: AbortSignal };
export type SendMessage = { peer: string; messageId: string; text: string };
export interface ChannelHandle {
  receive(message: IncomingMessage, options?: ReceiveOptions): Promise<ChannelResult>;
  bind(peer: string, sessionId: string): Promise<string>;
  retry(peer: string, messageId: string, options?: ReceiveOptions & { direction?: "in" | "out" }): Promise<ChannelResult>;
  send(message: SendMessage, options?: ReceiveOptions): Promise<ChannelResult>;
  context(peer: string): Promise<any>;
  dispose(): void;
}
export interface ChannelAPI {
  register(adapter: ChannelAdapter): ChannelHandle;
  send(target: SendMessage & { channel: string; account: string }, options?: ReceiveOptions): Promise<ChannelResult>;
}
type Registration = {
  adapter: ChannelAdapter;
  owner: string;
  controller: AbortController;
  handle: ChannelHandle;
};
type Receipt = {
  type: "channel_receipt";
  channel_key: string;
  external_message_id: string;
  direction: "in" | "out";
  fingerprint: string;
  status: "pending" | ChannelResult["status"];
  delivery_id: string;
  text?: string;
  error?: string;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identifier(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value))
    throw Error(label + " 无效（1–200 字，不能含控制字符）");
  return value;
}
function messageText(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 16000)
    throw Error("消息必须为 1–16000 字纯文本");
  return value;
}

/** Text transport boundary. All model, tool, history and token handling stays in Sessions. */
export class Channels {
  memory: Memory;
  sessions: Sessions;
  config: any;
  private registrations = new Map<string, Registration>();
  private flights = new Map<string, { fingerprint?: string; promise: Promise<ChannelResult> }>();
  private sessionQueues = new Map<string, Promise<unknown>>();
  private transportQueues = new Map<string, Promise<unknown>>();
  private bindingQueue: Promise<unknown> = Promise.resolve();
  constructor(memory: Memory, sessions: Sessions, config: any) {
    this.memory = memory;
    this.sessions = sessions;
    this.config = config;
  }
  private registrationKey(id: string, account: string) {
    return JSON.stringify([id, account]);
  }
  private alive(reg: Registration, signal?: AbortSignal) {
    if (reg.controller.signal.aborted || this.registrations.get(this.registrationKey(reg.adapter.id, reg.adapter.account)) !== reg)
      throw Error("渠道已停用，请使用重新注册后的接口");
    signal?.throwIfAborted();
    if (this.sessions.memoryMaintenance) throw Error("记忆恢复中，请稍后重试");
  }
  private policy(adapter: Pick<ChannelAdapter, "id" | "account" | "persona" | "permission">) {
    const channel = this.config.channels?.[adapter.id];
    const configured = channel?.accounts?.[adapter.account] ?? channel;
    const persona = adapter.persona ?? configured?.persona;
    const item = this.config.personas?.[persona];
    if (typeof persona !== "string" || !Object.hasOwn(this.config.personas ?? {}, persona) || !item)
      throw Error("渠道必须配置有效人格");
    const permission = adapter.permission ?? configured?.permission ?? item.permission ?? "off";
    if (!["off", "ask", "full"].includes(permission)) throw Error("渠道权限无效");
    return { persona, permission: permission as Permission };
  }
  private route(reg: Registration, peer: string, message?: IncomingMessage, signal?: AbortSignal): ChannelRoute {
    return {
      channel: reg.adapter.id, account: reg.adapter.account, peer,
      sender: message?.sender, messageId: message?.messageId,
      origin: { plugin: reg.owner, channel: reg.adapter.id, platform: reg.adapter.name ?? reg.adapter.id },
      ...this.policy(reg.adapter), signal,
    };
  }
  private key(reg: Registration, peer: string) {
    return hash([reg.adapter.id, reg.adapter.account, peer]);
  }
  private operation<T>(reg: Registration, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    this.alive(reg, signal);
    // Restore checks this set; the marker cannot collide with a valid session ID.
    const marker = "channel:" + randomUUID();
    this.sessions.blockedSessions.add(marker);
    return Promise.resolve().then(fn).finally(() => this.sessions.blockedSessions.delete(marker));
  }
  private resolve(reg: Registration, peer: string, target?: string): Promise<string> {
    const job = this.bindingQueue.then(async () => {
      this.alive(reg);
      const key = this.key(reg, peer);
      const entries = Object.entries(await this.memory.listSessionMeta());
      const matches = entries.filter(([, meta]) => meta?.channel_bindings?.[key]);
      if (matches.length > 1) throw Error("渠道绑定冲突，请检查记忆备份");
      if (matches.length) {
        const [id, meta] = matches[0];
        const binding = meta.channel_bindings[key];
        if (binding.channel !== reg.adapter.id || binding.account !== reg.adapter.account || binding.peer !== peer)
          throw Error("渠道绑定损坏，请检查记忆备份");
        if (meta.deleted) throw Error("渠道绑定的会话已删除，不能自动重建");
        if (binding.owner !== reg.owner) throw Error("渠道绑定属于其他插件");
        if (target && target !== id) throw Error("渠道已绑定会话；当前版本不支持迁移已绑定路由");
        return id;
      }
      const id = target ?? "ch_" + key;
      const meta = await this.memory.serial(() => this.memory.sessionMeta(id));
      if (meta?.deleted) throw Error("渠道绑定的会话已删除，不能自动重建");
      if (target && !meta) throw Error("显式绑定的会话不存在");
      if (!target && meta) throw Error("渠道会话 ID 已被占用");
      if (this.sessions.blockedSessions.has(id)) throw Error("会话维护中，请稍后重试");
      this.alive(reg);
      await this.memory.saveSessionMeta(id, {
        channel_bindings: {
          ...meta?.channel_bindings,
          [key]: { channel: reg.adapter.id, account: reg.adapter.account, peer, owner: reg.owner },
        },
      });
      return id;
    });
    this.bindingQueue = job.catch(() => {});
    return job;
  }
  private result(id: string, receipt: Receipt, duplicate = false): ChannelResult {
    return {
      sessionId: id, messageId: receipt.external_message_id, deliveryId: receipt.delivery_id,
      status: receipt.status === "pending" ? "uncertain" : receipt.status,
      ...(receipt.text === undefined ? {} : { text: receipt.text }),
      ...(receipt.error ? { error: receipt.error } : {}),
      ...(receipt.status === "pending" ? { error: "上次生成被中断，可能已执行工具；不会自动重放，请人工核对" } : {}),
      ...(duplicate ? { duplicate: true } : {}),
    };
  }
  private async receipt(id: string, key: string, messageId: string, direction: "in" | "out"): Promise<Receipt | undefined> {
    return (await this.memory.serial(() => this.memory.readSession(id))).findLast((row: any) =>
      row.type === "channel_receipt" && row.channel_key === key &&
      row.external_message_id === messageId && row.direction === direction,
    );
  }
  private save(id: string, route: ChannelRoute, receipt: Receipt) {
    return this.memory.appendEvent({
      ...receipt, session: id, channel: route.channel, account: route.account, peer: route.peer,
    });
  }
  private single(reg: Registration, peer: string, messageId: string, direction: "in" | "out", fingerprint: string | undefined, fn: () => Promise<ChannelResult>) {
    const key = JSON.stringify([this.key(reg, peer), messageId, direction]);
    const current = this.flights.get(key);
    if (current) {
      if (fingerprint && current.fingerprint && fingerprint !== current.fingerprint)
        return Promise.reject(Error("相同消息 ID 的内容不一致"));
      return current.promise.then((result) => ({ ...result, duplicate: true }));
    }
    const promise = fn().finally(() => {
      if (this.flights.get(key)?.promise === promise) this.flights.delete(key);
    });
    this.flights.set(key, { fingerprint, promise });
    return promise;
  }
  private queue<T>(queues: Map<string, Promise<unknown>>, id: string, fn: () => Promise<T>): Promise<T> {
    const promise = (queues.get(id) ?? Promise.resolve()).then(fn);
    const tail = promise.catch(() => {});
    queues.set(id, tail);
    void tail.finally(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return promise;
  }
  private tracked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const operations = this.sessions.channelOperations;
    operations.set(id, (operations.get(id) ?? 0) + 1);
    return Promise.resolve().then(fn).finally(() => {
      const remaining = (operations.get(id) ?? 1) - 1;
      if (remaining) operations.set(id, remaining);
      else operations.delete(id);
    });
  }
  private async deliver(reg: Registration, id: string, route: ChannelRoute, receipt: Receipt, signal: AbortSignal) {
    return this.queue(this.transportQueues, id, async () => {
    if (this.sessions.blockedSessions.has(id))
      throw Error("会话正在处理，请稍后重试发送");
    let called = false;
    try {
      const meta = await this.memory.serial(() => this.memory.sessionMeta(id));
      if (meta?.deleted) throw Error("会话已删除");
      this.alive(reg, signal);
      called = true;
      await reg.adapter.send({
        channel: route.channel, account: route.account, peer: route.peer, sessionId: id,
        text: receipt.text!, deliveryId: receipt.delivery_id,
        ...(receipt.direction === "in" ? { replyTo: receipt.external_message_id } : {}),
      }, { signal });
      // A confirmed transport completion is recorded even if disposal happened meanwhile.
      const sent: Receipt = { ...receipt, status: "sent", error: undefined };
      await this.save(id, route, sent);
      if (receipt.direction === "out") {
        try {
          await this.sessions.services.memoryEngine?.experience(id, "channel:" + reg.owner, {
            event_id: receipt.delivery_id, outcome: "succeeded",
            origin: { ...route.origin, action: "发送消息" },
            text: Array.from("已通过 " + route.channel + " 向 " + route.peer + " 发送文本：" + receipt.text!).slice(0, 500).join(""),
          });
        } catch (error: any) {
          // Projection failure must never turn a confirmed delivery into a resend.
          this.sessions.services.logger.warn("渠道发送已确认，经历投影失败", { error });
        }
      }
      return this.result(id, sent);
    } catch (error: any) {
      const failed: Receipt = {
        ...receipt, status: "delivery_failed",
        error: (called ? "发送结果可能不确定；重试可能重复投递：" : "尚未调用发送：") + error.message,
      };
      try {
        await this.save(id, route, failed);
      } catch (storageError: any) {
        failed.status = "uncertain";
        failed.error += "；投递回执保存失败：" + storageError.message;
      }
      return this.result(id, failed);
    }
    });
  }
  private incoming(reg: Registration, input: IncomingMessage | SendMessage, options: ReceiveOptions, direction: "in" | "out") {
    this.alive(reg, options.signal);
    if (!input || typeof input !== "object") throw Error("消息无效");
    for (const key of ["persona", "permission", "session", "sessionId", "owner", "channel", "account", "origin", "platform", "action"])
      if (Object.hasOwn(input, key)) throw Error("消息不能指定路由策略：" + key);
    const peer = identifier(input.peer, "peer"), messageId = identifier(input.messageId, "messageId"), text = messageText(input.text);
    const sender = direction === "in" ? identifier((input as IncomingMessage).sender, "sender") : undefined;
    const message = { peer, sender: sender ?? reg.adapter.account, messageId, text };
    const fingerprint = hash([sender, text]);
    const signal = AbortSignal.any([reg.controller.signal, ...(options.signal ? [options.signal] : [])]);
    return this.single(reg, peer, messageId, direction, fingerprint, () => this.operation(reg, signal, async () => {
      const id = await this.resolve(reg, peer);
      return this.tracked(id, () => {
      const run = async () => {
      const route = this.route(reg, peer, message, signal), key = this.key(reg, peer);
      const previous = await this.receipt(id, key, messageId, direction);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Error("相同消息 ID 的内容不一致");
        return this.result(id, previous, true);
      }
      this.alive(reg, signal);
      if ((direction === "in" && this.sessions.locks.has(id)) || this.sessions.blockedSessions.has(id))
        throw Error("会话正在处理，请稍后重试");
      let receipt: Receipt = {
        type: "channel_receipt", channel_key: key, external_message_id: messageId, direction,
        fingerprint, delivery_id: "delivery_" + hash([key, messageId, direction]), status: "pending",
      };
      await this.save(id, route, receipt);
      let response = text;
      if (direction === "in") {
        try {
          response = await this.generate(id, text, route);
        } catch (error: any) {
          receipt = { ...receipt, status: "generation_failed", error: error.message };
          await this.save(id, route, receipt);
          return this.result(id, receipt);
        }
      }
      receipt = { ...receipt, status: "generated", text: response };
      await this.save(id, route, receipt);
      return this.deliver(reg, id, route, receipt, signal);
      };
      return direction === "in" ? this.queue(this.sessionQueues, id, run) : run();
      });
    }));
  }
  private generate(id: string, text: string, route: ChannelRoute, onChunk: (text: string) => void = () => {}, onContext?: (value: any) => void, expectedPersona?: string) {
    route.signal?.throwIfAborted();
    return this.sessions.chat(id, text, onChunk, onContext, expectedPersona, route);
  }
  /** Web keeps its explicit session and streaming protocol, sharing the trusted dispatch path. */
  web(id: string, text: string, onChunk: (text: string) => void, onContext?: (value: any) => void, expectedPersona?: string) {
    safeId(id);
    return this.generate(id, text, { channel: "web", account: "local", peer: id,
      origin: { plugin: "core", channel: "web", platform: "控制台" },
      ...this.policy({ id: "web", account: "local" }) }, onChunk, onContext, expectedPersona);
  }
  register(adapter: ChannelAdapter, owner = "core"): ChannelHandle {
    if (!adapter || !/^[a-z][a-z0-9-]{0,39}$/.test(adapter.id) || adapter.id === "web")
      throw Error("渠道 ID 无效或保留");
    identifier(adapter.account, "account");
    validateOrigin({ plugin: owner, ...(adapter.name === undefined ? {} : { platform: adapter.name }) });
    if (typeof adapter.send !== "function") throw Error("渠道需要 send 文本发送函数");
    this.policy(adapter);
    const key = this.registrationKey(adapter.id, adapter.account);
    if (this.registrations.has(key)) throw Error("渠道账号已注册");
    const reg = { adapter: { ...adapter }, owner, controller: new AbortController() } as Registration;
    const handle: ChannelHandle = {
      receive: (message, options = {}) => this.incoming(reg, message, options, "in"),
      send: (message, options = {}) => this.incoming(reg, message, options, "out"),
      bind: (peer, id) => this.operation(reg, undefined, () => this.resolve(reg, identifier(peer, "peer"), safeId(id))),
      context: (peer) => this.operation(reg, undefined, async () => {
        identifier(peer, "peer");
        return this.sessions.contextStatus(await this.resolve(reg, peer), this.route(reg, peer));
      }),
      retry: (peer, messageId, options = {}) => {
        this.alive(reg, options.signal);
        identifier(peer, "peer"); identifier(messageId, "messageId");
        const direction = options.direction ?? "in";
        if (!["in", "out"].includes(direction)) throw Error("发送方向无效");
        const signal = AbortSignal.any([reg.controller.signal, ...(options.signal ? [options.signal] : [])]);
        return this.single(reg, peer, messageId, direction, undefined, () => this.operation(reg, signal, async () => {
          const id = await this.resolve(reg, peer), route = this.route(reg, peer, undefined, signal);
          return this.tracked(id, async () => {
          const receipt = await this.receipt(id, this.key(reg, peer), messageId, direction);
          if (!receipt) throw Error("没有可重试的消息");
          if (receipt.status === "sent") return this.result(id, receipt, true);
          if (!["generated", "delivery_failed"].includes(receipt.status) || typeof receipt.text !== "string")
            throw Error("没有已保存的最终回复；不能重放模型或工具");
          return this.deliver(reg, id, route, receipt, signal);
          });
        }));
      },
      dispose: () => {
        reg.controller.abort(Error("渠道已停用"));
        if (this.registrations.get(key) === reg) this.registrations.delete(key);
      },
    };
    reg.handle = handle;
    this.registrations.set(key, reg);
    return handle;
  }
  plugin(owner: string, onDispose: (dispose: () => void) => void): ChannelAPI {
    let active = true;
    const handles = new Set<ChannelHandle>();
    const guard = () => { if (!active) throw Error("插件渠道接口已停用"); };
    onDispose(() => { active = false; for (const handle of handles) handle.dispose(); });
    return {
      register: (adapter) => {
        guard();
        const handle = this.register(adapter, owner);
        handles.add(handle);
        return handle;
      },
      send: (target, options) => {
        guard();
        const reg = this.registrations.get(this.registrationKey(target.channel, target.account));
        if (!reg || reg.owner !== owner) throw Error("只能使用本插件注册的渠道账号");
        return reg.handle.send({ peer: target.peer, messageId: target.messageId, text: target.text }, options);
      },
    };
  }
}
