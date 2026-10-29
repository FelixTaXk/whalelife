/** Compile-only contract checks. Never run against production or alter frozen plugins. */
import type { Context, ModelConnection, MemoryRecord, PluginServices } from "whalelife";

export function checkPublicTypes(ctx: Context) {
  const connection: ModelConnection = ctx.models.connection("configured-model");
  ctx.logger.info("selected model", { id: connection.id });
  const result: Promise<MemoryRecord> = ctx.memory.recordExperience("session", {
    event_id: "stable-id", text: "completed", outcome: "succeeded",
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
