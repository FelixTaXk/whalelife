import { decision } from "./permission.ts";
import type { Logger } from "./logger.ts";
import { randomUUID, createHash } from "node:crypto";
import { pluginOrigin } from "./provenance.ts";
import { receiptSnapshot, type ToolTurn } from "./tool-retention.ts";
export class Tools {
  entries = new Map<string, any>();
  logger: Logger;
  overrides: any;
  observe?: (event: any) => Promise<void>;
  private persisted = new WeakMap<object, { ok: boolean; result: unknown; transient: true }>();
  constructor(logger: Logger, overrides: any = {}) {
    this.logger = logger;
    this.overrides = { remember_fact: "full", ...overrides };
  }
  register(tool: any, signal?: AbortSignal) {
    return this.add(tool, signal, false);
  }
  registerTransient(tool: any, signal?: AbortSignal) {
    return this.add(tool, signal, true);
  }
  private add(tool: any, signal: AbortSignal | undefined, transientResult: boolean) {
    signal?.throwIfAborted();
    if (this.entries.has(tool.name)) throw Error("工具重名：" + tool.name);
    const origin = pluginOrigin(tool.owner || "core", tool.origin);
    const controller = new AbortController();
    const entry = { ...tool, origin, transientResult, signal: signal
      ? AbortSignal.any([signal, controller.signal]) : controller.signal };
    this.entries.set(tool.name, entry);
    const dispose = () => {
      controller.abort(Error("工具已停用"));
      if (this.entries.get(tool.name) === entry) this.entries.delete(tool.name);
      signal?.removeEventListener("abort", dispose);
    };
    signal?.addEventListener("abort", dispose, { once: true });
    return dispose;
  }
  list() {
    return [...this.entries.values()].map(({ name, description, schema }) => ({
      type: "function",
      function: {
        name,
        description,
        parameters: schema.type
          ? schema
          : {
              type: "object",
              properties: schema,
              required: Object.keys(schema),
              additionalProperties: false,
            },
      },
    }));
  }
  stored(result: any) { return this.persisted.get(result) ?? result; }
  async call(name: string, args: any, session: any, callId = randomUUID(), turn: ToolTurn = { transient: false }) {
    const tool = this.entries.get(name);
    if (tool?.transientResult || session.transientContext) turn.transient = true;
    const storedName = turn.transient && !tool ? "[未注册工具]" : name;
    const report = async (ok: boolean, result: any, receipt: unknown = null) => {
      const returned = { ok, result };
      const stored = turn.transient ? { ok, result: receipt, transient: true as const } : returned;
      if (turn.transient) this.persisted.set(returned, stored as any);
      try {
        await this.observe?.({
          id: turn.transient ? "temporary_" + createHash("sha256").update(callId).digest("hex") : callId,
          name: storedName,
          source: tool?.owner || "core",
          origin: { ...(tool?.origin ?? { plugin: "core" }), action: tool?.origin?.action ?? "工具调用" },
          session: turn.transient ? { ...session, transientContext: true } : session,
          ok,
          result: stored.result,
          ...(turn.transient ? { transient: true } : {}),
        });
      } catch (error) {
        this.logger.warn("工具经历记录失败", { name: storedName, error: turn.transient ? "临时调用的记录失败" : error });
      }
      return returned;
    };
    try {
      if (!tool) throw Error("工具不存在");
      const signal = AbortSignal.any([tool.signal, ...(session.signal ? [session.signal] : [])]);
      signal.throwIfAborted();
      const verdict = decision(
        session.permission,
        tool.danger ?? "ask",
        this.overrides[name],
      );
      this.logger.info("工具权限判定", {
        name,
        verdict,
        args: turn.transient ? "[临时参数不记录]" : JSON.stringify(args).slice(0, 120),
      });
      if (verdict !== "allow")
        throw Error(
          verdict === "ask"
            ? "需要审批；M0 暂不支持审批，请修改权限后重启"
            : "工具已关闭",
        );
      signal.throwIfAborted();
      const result = await tool.run(args, { ...session, signal, ...(turn.transient ? { transientContext: true } : {}) });
      // Cancellation cannot undo a completed external operation or replace its true result.
      if (tool.transientResult) {
        if (!result || typeof result !== "object" || !Object.hasOwn(result, "content") || !Object.hasOwn(result, "receipt"))
          throw Error("临时工具必须返回content和receipt");
        const receipt = receiptSnapshot(result.receipt);
        return report(true, result.content, receipt);
      }
      return report(true, result);
    } catch (error: any) {
      const message = turn.transient ? "临时工具调用失败，未保存原始错误；外部动作结果请通过插件回执核对，不要自动重试。" : error?.message ?? String(error);
      this.logger.error("工具调用失败", { name: storedName, error: turn.transient ? message : error });
      return report(false, message);
    }
  }
}
