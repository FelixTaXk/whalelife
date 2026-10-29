import type { ModelConfig, ModelType } from "./model-config.ts";
import type { Sessions } from "./session.ts";
import { safeId } from "./memory.ts";
import { pluginOrigin, type OriginDetails } from "./provenance.ts";
import type { Permission } from "./permission.ts";

export type ModelChoice = { id: string; name: string; model: string; type: ModelType; provider: string; context_window: number | null; callable: boolean };
export type PersonaChoice = { id: string; name: string; model: string | null };
export type SessionRun = { sessionId: string; persona: string; text: string; permission?: Permission; origin?: OriginDetails; signal?: AbortSignal; onChunk?: (text: string) => void };
export interface SessionAPI {
  list(): Promise<any[]>;
  create(name?: string): Promise<string>;
  context(id: string, persona: string): Promise<any>;
  run(input: SessionRun): Promise<any>;
}
export function pluginServices(config: any, modelConfig: ModelConfig, sessions: Sessions, memory: any) {
  return {
    models: { list(type?: ModelType): ModelChoice[] {
      const snapshot = modelConfig.snapshot();
      return snapshot.models.filter((m: any) => (!type || m.type === type) && m.enabled && !m.configuration_error && snapshot.providers.find((p: any) => p.id === m.provider)?.enabled !== false)
        .map((m: any) => ({ id: m.id, name: m.name, model: m.model, type: m.type, provider: m.provider, context_window: m.context_window, callable: m.type === "chat" }));
    } },
    personas: { list(): PersonaChoice[] { return modelConfig.snapshot().personas; } },
    sessions: { plugin(owner: string, signal: AbortSignal): SessionAPI {
      const check = () => signal.throwIfAborted();
      const route = (id: string, persona: string, permission?: Permission, origin?: OriginDetails, extra?: AbortSignal) => {
        check(); safeId(id);
        const p = config.personas?.[persona];
        if (!p) throw Error("请明确选择存在的人格");
        if (permission && !["off", "ask", "full"].includes(permission)) throw Error("权限无效");
        return { channel: "plugin", account: owner, peer: id, persona, permission: permission ?? p.permission ?? "off",
          origin: pluginOrigin(owner, origin), signal: extra ? AbortSignal.any([signal, extra]) : signal };
      };
      return {
        async list() { check(); return Object.entries<any>(await memory.listSessionMeta()).filter(([, s]) => !s.deleted).map(([id, s]) => ({ id, name: s.name || id, updatedAt: s.updatedAt })); },
        async create(name = "") { check(); if (typeof name !== "string" || name.length > 100) throw Error("会话名称最长100字");
          const id = "plugin_" + crypto.randomUUID().replaceAll("-", ""); await memory.saveSessionMeta(id, { ...(name ? { name } : {}) }); return id; },
        context(id, persona) { return sessions.contextStatus(id, route(id, persona)); },
        async run(input) {
          const resolved = route(input.sessionId, input.persona, input.permission, input.origin, input.signal);
          const meta = await memory.sessionMeta(input.sessionId);
          if (!meta || meta.deleted) throw Error("请先创建或选择有效会话");
          return sessions.chat(input.sessionId, input.text, input.onChunk ?? (() => {}), undefined, input.persona, resolved);
        },
      };
    } },
  };
}
