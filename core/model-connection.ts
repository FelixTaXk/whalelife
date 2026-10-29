import type { ModelType } from "./model-config.ts";

/** Public metadata; never contains a credential or connection address. */
export type ModelChoice = {
  id: string;
  name: string;
  model: string;
  type: ModelType;
  provider: string;
  context_window: number | null;
  /** Whether the core dialogue client can execute this entry. */
  callable: boolean;
};

/** A selected configuration snapshot for trusted plugin backend code only. */
export type ModelConnection = {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly type: ModelType;
  readonly provider_id: string;
  readonly provider_name: string;
  readonly protocol: string;
  readonly base_url: string;
  readonly api_key: string;
  readonly timeout_seconds: number;
  readonly proxy_url: string;
  readonly parameters: Record<string, unknown>;
  readonly dimensions: number | null;
  readonly context_window: number | null;
};

export interface ModelsAPI {
  list(type?: ModelType): ModelChoice[];
  /** Explicit configuration ID, never a default or bare provider model name. */
  connection(modelConfigId: string): ModelConnection;
}
