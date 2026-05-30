import type { JsonRecord, JsonValue } from "@shared/json";
import type { ModelOption, ProviderName, ToolCallRecord } from "@shared/types";

export type ProviderRole = "system" | "user" | "assistant" | "tool";

export interface ProviderMessage {
  role: ProviderRole;
  content: string;
  name?: string;
}

export interface ProviderToolSpec {
  name: string;
  description: string;
  parameters: JsonRecord;
  risk: string;
}

export interface ProviderRequest {
  model: ModelOption;
  instructions?: string;
  messages: ProviderMessage[];
  tools: ProviderToolSpec[];
}

export type ProviderStreamEvent =
  | { type: "token"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; call: ToolCallRecord }
  | { type: "error"; error: string }
  | { type: "done" };

export interface LlmProvider {
  readonly name: ProviderName;
  listModels: () => ModelOption[];
  stream: (
    request: ProviderRequest,
    signal?: AbortSignal
  ) => AsyncGenerator<ProviderStreamEvent>;
}

export interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface NormalizedToolPayload {
  name: string;
  arguments: JsonRecord;
  raw: JsonValue;
}