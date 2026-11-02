/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { PluginLogger, ToolsAPI, LLMAPI, MemoryAPI, ApprovalAPI, ChannelAPI, PluginWeb,
  ModelsAPI, PersonasAPI, SessionAPI, PluginConfig, PluginServices, PluginEvents, Disposable,
  PluginStatus, OptionalService } from "./plugin-api.ts";
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
  /** Observe a service declared in optionalDepends, without creating a mandatory dependency. */
  optional<Name extends keyof PluginServices>(name: Name, onChange: (binding: OptionalService<PluginServices[Name]> | undefined) => unknown | Promise<unknown>): () => void;
  optional<T = unknown>(name: string, onChange: (binding: OptionalService<T> | undefined) => unknown | Promise<unknown>): () => void;
  effect<T extends Disposable>(fn: () => T): T;
  on<Name extends keyof PluginEvents>(name: Name, fn: (payload: PluginEvents[Name]) => unknown | Promise<unknown>): () => void;
  on<Payload = unknown>(name: string, fn: (payload: Payload) => unknown | Promise<unknown>): () => void;
  emit<Payload>(name: string, payload: Payload): void;
  plugin(module: PluginModule | PromiseLike<PluginModule>): Promise<PluginStatus>;
}
