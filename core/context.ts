import type { PluginLogger, ToolsAPI, LLMAPI, MemoryAPI, ApprovalAPI, ChannelAPI, PluginWeb,
  ModelsAPI, PersonasAPI, SessionAPI, PluginConfig, PluginServices, PluginEvents, Disposable,
  PluginStatus } from "./plugin-api.ts";
export type * from "./plugin-api.ts";
export type { IncomingMessageData as IncomingMessage } from "./plugin-api.ts";
export { PLUGIN_API_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from "./plugin-compatibility.ts";
export interface PluginModule { id?: string; apply(ctx: Context): unknown | Promise<unknown>; }
export interface Context {
  readonly apiVersion: string;
  logger: PluginLogger;
  tools: ToolsAPI;
  llm: LLMAPI;
  memory: MemoryAPI;
  approval: ApprovalAPI;
  channels: ChannelAPI;
  web: PluginWeb;
  signal: AbortSignal;
  models: ModelsAPI;
  personas: PersonasAPI;
  sessions: SessionAPI;
  config: PluginConfig;
  provide<T>(name: string, value: T): void;
  get<Name extends keyof PluginServices>(name: Name, strict?: true): PluginServices[Name];
  get<Name extends keyof PluginServices>(name: Name, strict: false): PluginServices[Name] | undefined;
  get<Name extends keyof PluginServices>(name: Name, strict: boolean): PluginServices[Name] | undefined;
  /** Legacy dynamically named third-party services; supply T or augment PluginServices for typing. */
  get<T = any>(name: string, strict?: boolean): T;
  effect<T extends Disposable>(fn: () => T): T;
  on<Name extends keyof PluginEvents>(name: Name, fn: (payload: PluginEvents[Name]) => unknown | Promise<unknown>): () => void;
  on<Payload = unknown>(name: string, fn: (payload: Payload) => unknown | Promise<unknown>): () => void;
  emit<Payload>(name: string, payload: Payload): void;
  plugin(module: PluginModule | PromiseLike<PluginModule>): Promise<PluginStatus>;
}
