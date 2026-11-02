/** Compile-only contract checks. Never run against production or alter frozen plugins. */
import type { Context, ModelConnection, MemoryRecord, PluginServices, SessionDocument, ChatMessage, ChatReply } from "whalelife";

export function checkPublicTypes(ctx: Context) {
  if (typeof ctx.optional === "function") {
    const remove: () => void = ctx.optional<{ read(signal: AbortSignal): Promise<string> }>("example-media", async binding => {
      if (!binding) return;
      const result: string = await binding.service.read(binding.signal);
      binding.effect(() => ctx.on("plugin:example:event", () => result));
      // @ts-expect-error optional services retain their declared shape
      binding.service.privateInternal();
    });
    remove();
    ctx.optional("models", binding => {
      binding?.service.list();
      // @ts-expect-error typed optional lookup cannot reveal core configuration internals
      binding?.service.config;
    });
  }
  if (typeof ctx.tools.registerTransient === "function") {
    const dispose = ctx.tools.registerTransient<{ ref: string }, { text: string }, { action: string }>({
      name: "temporary_reader", description: "Read this turn only", schema: { ref: { type: "string" } },
      run(args, session) {
        const temporary: boolean | undefined = session.transientContext;
        void temporary;
        return { content: { text: args.ref }, receipt: { action: "read" } };
      },
    });
    dispose();
  }
  const protocolMessage: ChatMessage = { role: "assistant", content: null, reasoning_content: "provider protocol data" };
  const protocolReply: ChatReply = { text: "", toolCalls: [], reasoning_content: "provider protocol data" };
  void protocolMessage; void protocolReply;
  const current: Promise<string> = ctx.sessions.current();
  const reply: Promise<string> = ctx.sessions.run({ text: "continue current Web session" });
  const transient: Promise<string> = ctx.sessions.runTransient({ text: "temporary plugin context", origin: { action: "检查" } });
  const queued: Promise<string> = ctx.sessions.enqueue({ text: "ordered input", priority: 0, signal: ctx.signal });
  const queuedTransient: Promise<string> = ctx.sessions.enqueueTransient({ text: "temporary opportunity", key: "opportunity", beforeRun: async () => true });
  void queued; void queuedTransient;
  const excluded: Promise<{ excluded: number }> = ctx.memory.excludeInputs("session", ["exact-input-id"]);
  ctx.memory.readSession("session", 100, "before-message-id");
  void current; void reply; void transient; void excluded;
  const document: Promise<SessionDocument<{ items: string[] }>> = ctx.memory.readDocument("session", "intents");
  const saved: Promise<SessionDocument<{ items: string[] }>> = ctx.memory.saveDocument("session", {
    key: "intents", revision: null, data: { items: [] },
  });
  void document; void saved;
  // @ts-expect-error document writes require an explicit revision for conflict detection
  ctx.memory.saveDocument("session", { key: "intents", data: [] });
  const connection: ModelConnection = ctx.models.connection("configured-model");
  ctx.logger.info("selected model", { id: connection.id });
  const result: Promise<MemoryRecord> = ctx.memory.recordExperience("session", {
    event_id: "stable-id", text: "completed", outcome: "succeeded",
    occurred_at: "2026-10-30T08:00:00+08:00",
  });
  void result;
  ctx.on("memory/updated", ({ session }) => { const id: string = session; void id; });
  const tools: PluginServices["tools"] = ctx.get("tools");
  void tools;
  const custom = ctx.get<{ greet(name: string): string }>("custom");
  const greeting: string = custom.greet("name");
  void greeting;
  // @ts-expect-error logger implementation and secrets are not plugin contracts
  ctx.logger.secrets;
  // @ts-expect-error memory implementation internals cannot be accessed
  ctx.memory.update("session", () => {});
  // @ts-expect-error LLM implementation providers are not exposed
  ctx.llm.providers;
  // @ts-expect-error typed service lookup preserves the public boundary
  ctx.get("logger").dir;
  // @ts-expect-error optional service lookup does not expose internal fields
  ctx.get("logger", false)?.secrets;
  // @ts-expect-error a computed strict flag must retain the same public service shape
  ctx.get("logger", Math.random() > 0.5)?.dir;
  // @ts-expect-error session.run returns final text, not the internal Sessions object
  const internalSession: { services: unknown } = ctx.sessions.run({ sessionId: "s", persona: "p", text: "hello" });
  void internalSession;
}
