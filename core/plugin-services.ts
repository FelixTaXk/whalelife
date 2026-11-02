import type { ModelConfig, ModelType } from "./model-config.ts";
import type { Sessions } from "./session.ts";
import { safeId } from "./memory.ts";
import { pluginOrigin, type OriginDetails } from "./provenance.ts";
import type { Permission } from "./permission.ts";
import type { ModelChoice, ModelsAPI } from "./model-connection.ts";
export type { ModelChoice, ModelConnection, ModelsAPI } from "./model-connection.ts";
import type { PersonaChoice, SessionAPI, SessionQueuedRun } from "./plugin-api.ts";
export type { PersonaChoice, SessionAPI, SessionRun } from "./plugin-api.ts";

export function pluginServices(config: any, modelConfig: ModelConfig, sessions: Sessions, memory: any) {
  return {
    models: { list(type?: ModelType): ModelChoice[] {
      const snapshot = modelConfig.snapshot();
      return snapshot.models.filter((m: any) => (!type || m.type === type) && m.enabled && !m.configuration_error && snapshot.providers.find((p: any) => p.id === m.provider)?.enabled !== false)
        .map((m: any) => ({ id: m.id, name: m.name, model: m.model, type: m.type, provider: m.provider, context_window: m.context_window,
          callable: m.type === "chat" && snapshot.providers.find((p: { id: string; protocol: string }) => p.id === m.provider)?.protocol === "openai-compatible" }));
    }, connection(id: string) { return modelConfig.connection(id); } } satisfies ModelsAPI,
    personas: { list(): PersonaChoice[] { return modelConfig.snapshot().personas; } },
    sessions: { plugin(owner: string, signal: AbortSignal): SessionAPI {
      const queueScope = {};
      const check = () => signal.throwIfAborted();
      const route = (id: string, persona: string, permission?: Permission, origin?: OriginDetails, extra?: AbortSignal) => {
        check(); safeId(id);
        const p = config.personas?.[persona];
        if (!p) throw Error("请明确选择存在的人格");
        if (permission && !["off", "ask", "full"].includes(permission)) throw Error("权限无效");
        return { channel: "plugin", account: owner, peer: id, persona, permission: permission ?? p.permission ?? "off",
          origin: pluginOrigin(owner, origin), signal: extra ? AbortSignal.any([signal, extra]) : signal };
      };
      const run = async (input: SessionQueuedRun, transient = false, queued = false) => {
        check();
        input = { ...input, origin: input.origin ? { ...input.origin } : undefined };
        const receivedAt = new Date().toISOString();
        const requestSignal = input.signal ? AbortSignal.any([signal, input.signal]) : signal;
        requestSignal.throwIfAborted();
        const persona = input.persona ?? config.channels.web.persona;
        const captured = sessions.captureRoute(input.sessionId ?? "current", route(input.sessionId ?? "current", persona, input.permission, input.origin, requestSignal));
        const id = input.sessionId ?? await sessions.current({}, requestSignal);
        const resolved = { ...captured, peer: id, receivedAt };
        const meta = await memory.sessionMeta(id);
        if (!meta || meta.deleted) throw Error("请先创建或选择有效会话");
        return sessions.chat(id, input.text, input.onChunk ?? (() => {}), undefined, persona, resolved, transient,
          queued ? { wait: true, priority: input.priority, key: input.key, beforeRun: input.beforeRun, scope: queueScope } : undefined);
      };
      return {
        async list() { check(); return Object.entries<any>(await memory.listSessionMeta()).filter(([, s]) => !s.deleted).map(([id, s]) => ({ id, name: s.name || id, updatedAt: s.updatedAt })); },
        create(name = "") { check(); return sessions.create(name, signal); },
        current() { check(); return sessions.current({}, signal); },
        context(id, persona) { return sessions.contextStatus(id, route(id, persona)); },
        run: (input) => run(input),
        runTransient: (input) => run(input, true),
        enqueue: (input) => run(input, false, true),
        enqueueTransient: (input) => run(input, true, true),
      };
    } },
  };
}
