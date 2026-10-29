import type { Logger } from "./logger.ts";
import type { ChannelAPI } from "./channels.ts";
export type { Origin, OriginDetails } from "./provenance.ts";
export type { ChannelAPI, ChannelAdapter, ChannelHandle, IncomingMessage, OutgoingMessage, ChannelResult } from "./channels.ts";
export interface Context {
  logger: Logger;
  tools: any;
  llm: any;
  memory: any;
  approval: any;
  channels: ChannelAPI;
  web: any;
  config: any;
  provide(name: string, value: any): void;
  get(name: string, strict?: boolean): any;
  effect(fn: () => any): any;
  on(name: string, fn: (...args: any[]) => any): any;
  plugin(module: any): Promise<any>;
}
