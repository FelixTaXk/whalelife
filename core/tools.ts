import { decision } from "./permission.ts";
import type { Logger } from "./logger.ts";
import { randomUUID } from "node:crypto";
import { pluginOrigin } from "./provenance.ts";
export class Tools {
  entries = new Map<string, any>();
  logger: Logger;
  overrides: any;
  observe?: (event: any) => Promise<void>;
  constructor(logger: Logger, overrides: any = {}) {
    this.logger = logger;
    this.overrides = { remember_fact: "full", ...overrides };
  }
  register(tool: any, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.entries.has(tool.name)) throw Error("工具重名：" + tool.name);
    const origin = pluginOrigin(tool.owner || "core", tool.origin);
    const controller = new AbortController();
    const entry = { ...tool, origin, signal: signal
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
  async call(name: string, args: any, session: any, callId = randomUUID()) {
    const tool = this.entries.get(name);
    const report = async (ok: boolean, result: any) => {
      try {
        await this.observe?.({
          id: callId,
          name,
          source: tool?.owner || "core",
          origin: { ...(tool?.origin ?? { plugin: "core" }), action: tool?.origin?.action ?? "工具调用" },
          session,
          ok,
          result,
        });
      } catch (error) {
        this.logger.warn("工具经历记录失败", { name, error });
      }
      return { ok, result };
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
        args: JSON.stringify(args).slice(0, 120),
      });
      if (verdict !== "allow")
        throw Error(
          verdict === "ask"
            ? "需要审批；M0 暂不支持审批，请修改权限后重启"
            : "工具已关闭",
        );
      signal.throwIfAborted();
      const result = await tool.run(args, { ...session, signal });
      // Cancellation cannot undo a completed external operation or replace its true result.
      return report(true, result);
    } catch (error: any) {
      this.logger.error("工具调用失败", { name, error });
      return report(false, error?.message ?? String(error));
    }
  }
}
