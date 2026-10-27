import type { Logger } from "./logger.ts";
export interface Context {
  logger: Logger;
  tools: any;
  llm: any;
  memory: any;
  approval: any;
  channels: any;
  web: any;
  config: any;
  provide(name: string, value: any): void;
  get(name: string, strict?: boolean): any;
  effect(fn: () => any): any;
  on(name: string, fn: (...args: any[]) => any): any;
  plugin(module: any): Promise<any>;
}
