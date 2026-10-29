import type { Logger } from "./logger.ts";
import type { ChannelAPI } from "./channels.ts";
import type { PluginWeb } from "./plugin-web.ts";
import type { ModelChoice, PersonaChoice, SessionAPI } from "./plugin-services.ts";
import type { ModelType } from "./model-config.ts";
export type { PluginWeb, PluginHandler, PageOptions, PluginPage } from "./plugin-web.ts";
export type { ModelChoice, PersonaChoice, SessionAPI, SessionRun } from "./plugin-services.ts";
export type { Origin, OriginDetails } from "./provenance.ts";
export type { ChannelAPI, ChannelAdapter, ChannelHandle, IncomingMessage, OutgoingMessage, ChannelResult } from "./channels.ts";
export interface Context {
  logger: Logger;
  tools: any;
  llm: any;
  memory: any;
  approval: any;
  channels: ChannelAPI;
  web: PluginWeb;
  signal: AbortSignal;
  models: { list(type?: ModelType): ModelChoice[] };
  personas: { list(): PersonaChoice[] };
  sessions: SessionAPI;
  config: any;
  provide(name: string, value: any): void;
  get(name: string, strict?: boolean): any;
  effect(fn: () => any): any;
  on(name: string, fn: (...args: any[]) => any): any;
  emit(name: string, payload: any): void;
  plugin(module: any): Promise<any>;
}
