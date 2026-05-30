import { createHash, randomUUID } from "node:crypto";
import { asJsonRecord } from "@shared/json";
import type { JsonRecord } from "@shared/json";
import type { ToolCallRecord } from "@shared/types";
import type { ProviderMessage, ProviderRequest } from "@providers/interfaces/provider";
import { normalizeToolCall } from "@providers/shared/toolNormalization";

export type OpenAiCompatibleRole = "system" | "user" | "assistant" | "tool";

export interface OpenAiCompatibleFunctionDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface OpenAiCompatibleToolDefinition {
  type: "function";
  function: OpenAiCompatibleFunctionDefinition;
}

export interface OpenAiCompatibleFunctionCall {
  name: string;
  arguments: string;
}

export interface OpenAiCompatibleToolCall {
  id: string;
  type: "function";
  function: OpenAiCompatibleFunctionCall;
}

export type OpenAiCompatibleMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAiCompatibleToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name?: string;
    };

export interface PendingOpenAiToolCall {
  id: string;
  index: number;
  name: string;
  argumentsText: string;
}

export interface OpenAiToolNameMapper {
  toProviderName: (internalName: string) => string;
  toInternalName: (providerName: string) => string;
}

const OPENAI_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_LENGTH = 8;

export const isOpenAiCompatibleToolName = (name: string): boolean =>
  OPENAI_TOOL_NAME_PATTERN.test(name);

export const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const readArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const hashToolName = (name: string): string =>
  createHash("sha256").update(name).digest("hex").slice(0, HASH_LENGTH);

const toSafeToolNameBase = (name: string): string => {
  const base = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_");
  return base.length > 0 ? base : "tool";
};

const appendToolNameHash = (base: string, originalName: string): string => {
  const suffix = `_${hashToolName(originalName)}`;
  const prefixLength = Math.max(1, 64 - suffix.length);
  return `${base.slice(0, prefixLength)}${suffix}`;
};

const buildProviderToolName = (
  internalName: string,
  usedProviderNames: ReadonlySet<string>
): string => {
  const base = toSafeToolNameBase(internalName);
  const preferred = isOpenAiCompatibleToolName(internalName)
    ? internalName
    : base;

  if (isOpenAiCompatibleToolName(preferred) && !usedProviderNames.has(preferred)) {
    return preferred;
  }

  let candidate = appendToolNameHash(base, internalName);
  let collisionIndex = 1;

  while (usedProviderNames.has(candidate)) {
    const suffix = `_${hashToolName(`${internalName}:${collisionIndex}`)}`;
    candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    collisionIndex += 1;
  }

  return candidate;
};

export const createOpenAiToolNameMapper = (
  tools: readonly Pick<ProviderRequest["tools"][number], "name">[]
): OpenAiToolNameMapper => {
  const internalToProvider = new Map<string, string>();
  const providerToInternal = new Map<string, string>();
  const usedProviderNames = new Set<string>();

  for (const tool of tools) {
    const internalName = tool.name;
    if (internalToProvider.has(internalName)) continue;

    const providerName = buildProviderToolName(internalName, usedProviderNames);
    internalToProvider.set(internalName, providerName);
    providerToInternal.set(providerName, internalName);
    usedProviderNames.add(providerName);
  }

  return {
    toProviderName: (internalName: string): string => {
      const mapped = internalToProvider.get(internalName);
      if (mapped) return mapped;
      return isOpenAiCompatibleToolName(internalName)
        ? internalName
        : buildProviderToolName(internalName, usedProviderNames);
    },
    toInternalName: (providerName: string): string =>
      providerToInternal.get(providerName) ?? providerName
  };
};

export const toInternalToolCallName = (
  name: string,
  mapper?: OpenAiToolNameMapper
): string => mapper?.toInternalName(name) ?? name;

export const toProviderToolCallName = (
  name: string,
  mapper?: OpenAiToolNameMapper
): string => mapper?.toProviderName(name) ?? name;

export const toInternalToolCall = (
  call: ToolCallRecord,
  mapper?: OpenAiToolNameMapper
): ToolCallRecord => ({
  ...call,
  name: toInternalToolCallName(call.name, mapper)
});

const parseJsonRecord = (value: string): JsonRecord | undefined => {
  if (!value.trim()) return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    const record = asJsonRecord(parsed);
    return Object.keys(record).length > 0 ? record : { value };
  } catch {
    return { value };
  }
};

const stringifyToolArguments = (value: unknown): string => {
  if (value === undefined || value === null) return "{}";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
    return JSON.stringify({ value });
  }

  return JSON.stringify(value);
};

const isProviderRole = (role: string): role is OpenAiCompatibleRole =>
  role === "system" || role === "user" || role === "assistant" || role === "tool";

const readToolCalls = (record: JsonRecord): unknown[] => {
  const direct = readArray(record.toolCalls);
  if (direct.length > 0) return direct;

  const snakeCase = readArray(record.tool_calls);
  if (snakeCase.length > 0) return snakeCase;

  const metadata = asJsonRecord(record.metadata);
  const metadataCamel = readArray(metadata.toolCalls);
  if (metadataCamel.length > 0) return metadataCamel;

  return readArray(metadata.tool_calls);
};

const readToolCallId = (record: JsonRecord): string => {
  const direct = readString(record.toolCallId) || readString(record.tool_call_id);
  if (direct) return direct;

  const metadata = asJsonRecord(record.metadata);
  return readString(metadata.toolCallId) || readString(metadata.tool_call_id);
};

const toOpenAiCompatibleToolCall = (
  value: unknown,
  mapper?: OpenAiToolNameMapper
): OpenAiCompatibleToolCall | null => {
  const record = asJsonRecord(value);
  const fn = asJsonRecord(record.function);
  const id = readString(record.id) || randomUUID();
  const name = readString(record.name) || readString(fn.name);

  if (!name) return null;

  const input =
    record.input !== undefined
      ? record.input
      : fn.arguments !== undefined
        ? fn.arguments
        : record.arguments;

  return {
    id,
    type: "function",
    function: {
      name: toProviderToolCallName(name, mapper),
      arguments: stringifyToolArguments(input)
    }
  };
};

const runtimeInstructionAsUser = (content: string): string =>
  [
    "Runtime instruction from the local agent controller:",
    content
  ].join("\n");

const detachedToolResultAsUser = (
  message: Extract<OpenAiCompatibleMessage, { role: "tool" }>
): OpenAiCompatibleMessage => ({
  role: "user",
  content: [
    `Local tool result${message.name ? ` (${message.name})` : ""}:`,
    message.content
  ].join("\n")
});

export const normalizeOpenAiCompatibleMessageOrder = (
  messages: OpenAiCompatibleMessage[]
): OpenAiCompatibleMessage[] => {
  const normalized: OpenAiCompatibleMessage[] = [];
  const pendingToolCallIds = new Set<string>();
  let seenNonSystemMessage = false;

  for (const message of messages) {
    if (message.role === "system") {
      if (!seenNonSystemMessage) {
        normalized.push(message);
      } else if (message.content.trim()) {
        normalized.push({
          role: "user",
          content: runtimeInstructionAsUser(message.content)
        });
      }

      continue;
    }

    seenNonSystemMessage = true;

    if (message.role === "assistant") {
      pendingToolCallIds.clear();

      for (const call of message.tool_calls ?? []) {
        pendingToolCallIds.add(call.id);
      }

      normalized.push(message);
      continue;
    }

    if (message.role === "tool") {
      if (pendingToolCallIds.has(message.tool_call_id)) {
        pendingToolCallIds.delete(message.tool_call_id);
        normalized.push(message);
      } else {
        normalized.push(detachedToolResultAsUser(message));
      }

      continue;
    }

    pendingToolCallIds.clear();
    normalized.push(message);
  }

  return normalized;
};

export const toOpenAiCompatibleMessages = (
  messages: ProviderMessage[],
  mapper?: OpenAiToolNameMapper
): OpenAiCompatibleMessage[] => {
  const result: OpenAiCompatibleMessage[] = [];

  for (const value of messages) {
    const record = asJsonRecord(value);
    const role = readString(record.role);

    if (!isProviderRole(role)) continue;

    const content = readString(record.content);

    if (role === "system" || role === "user") {
      result.push({ role, content });
      continue;
    }

    if (role === "assistant") {
      const toolCalls = readToolCalls(record)
        .map((call) => toOpenAiCompatibleToolCall(call, mapper))
        .filter((call): call is OpenAiCompatibleToolCall => call !== null);

      if (toolCalls.length > 0) {
        result.push({
          role,
          content: content.length > 0 ? content : null,
          tool_calls: toolCalls
        });
      } else {
        result.push({ role, content });
      }

      continue;
    }

    const toolCallId = readToolCallId(record);
    if (!toolCallId) continue;

    const name = readString(record.name);
    const message: OpenAiCompatibleMessage = {
      role,
      content,
      tool_call_id: toolCallId
    };

    if (name) message.name = toProviderToolCallName(name, mapper);
    result.push(message);
  }

  return normalizeOpenAiCompatibleMessageOrder(result);
};

export const toOpenAiCompatibleTools = (
  tools: ProviderRequest["tools"],
  mapper?: OpenAiToolNameMapper
): OpenAiCompatibleToolDefinition[] =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: toProviderToolCallName(tool.name, mapper),
      description: tool.description,
      parameters: tool.parameters
    }
  }));

const readToolCallDeltaIndex = (
  record: JsonRecord,
  fallback: number
): number => readNumber(record.index) ?? fallback;

export const applyOpenAiToolCallDelta = (
  pending: Map<number, PendingOpenAiToolCall>,
  rawCall: unknown,
  fallbackIndex: number
): void => {
  const record = asJsonRecord(rawCall);
  const fn = asJsonRecord(record.function);
  const index = readToolCallDeltaIndex(record, fallbackIndex);
  const current = pending.get(index) ?? {
    id: readString(record.id) || randomUUID(),
    index,
    name: "",
    argumentsText: ""
  };

  const id = readString(record.id);
  const name = readString(fn.name) || readString(record.name);
  const argumentsDelta = readString(fn.arguments) || readString(record.arguments);

  pending.set(index, {
    ...current,
    id: id || current.id,
    name: name || current.name,
    argumentsText: current.argumentsText + argumentsDelta
  });
};

export const flushOpenAiToolCalls = (
  pending: Map<number, PendingOpenAiToolCall>,
  mapper?: OpenAiToolNameMapper
): ToolCallRecord[] => {
  const calls = [...pending.values()].sort((a, b) => a.index - b.index);
  pending.clear();

  return calls
    .filter((call) => call.name.length > 0)
    .map((call) => {
      const normalized = normalizeToolCall({
        name: toInternalToolCallName(call.name, mapper),
        arguments: parseJsonRecord(call.argumentsText) ?? {}
      });

      return {
        ...normalized,
        id: call.id || normalized.id || randomUUID()
      };
    });
};

export const openAiToolCallKey = (call: ToolCallRecord): string =>
  JSON.stringify({ id: call.id, name: call.name, input: call.input });

export const readOpenAiFinishReason = (choice: JsonRecord): string =>
  readString(choice.finish_reason) || readString(choice.finishReason);

export const readOpenAiErrorMessage = (record: JsonRecord): string => {
  const error = asJsonRecord(record.error);

  return (
    readString(error.message) ||
    readString(record.error) ||
    readString(record.message)
  );
};
