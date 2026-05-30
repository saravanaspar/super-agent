import type { ChatMessage, ToolCallRecord, ToolResultRecord } from "@shared/types";
import { toJsonRecord, type JsonRecord, type JsonValue } from "@shared/json";
import type { ProviderMessage } from "@providers/interfaces/provider";
import { estimateTokens } from "./contextWindow";

const MAX_INLINE_TOOL_DATA_CHARS = 700;
const MAX_TOOL_SUMMARY_CHARS = 900;
const MAX_TOOL_CALL_SUMMARY_CHARS = 900;
const MAX_READ_TOOL_CONTENT_CHARS = 60000;
const MAX_MESSAGE_SUMMARY_CHARS = 700;
const RECENT_MESSAGE_FLOOR = 8;
const RECENT_MESSAGE_CEILING = 18;

interface MessagePartition {
  compactable: ChatMessage[];
  recent: ChatMessage[];
}

export interface CompactedHistory {
  messages: ProviderMessage[];
  compacted: boolean;
  estimatedTokens: number;
}

const asRecord = (value: unknown): JsonRecord => toJsonRecord(value);

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;

const isJsonRecord = (value: JsonValue): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeJson = (value: JsonValue): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable JSON]";
  }
};

const truncate = (value: string, limit: number): string => {
  const text = value.trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit).trimEnd()} ... [truncated]`;
};

const dataPreview = (value: JsonValue): string => {
  if (typeof value === "string") {
    return truncate(value, MAX_INLINE_TOOL_DATA_CHARS);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return truncate(
      `array(${value.length}) ${safeJson(value.slice(0, 5))}`,
      MAX_INLINE_TOOL_DATA_CHARS
    );
  }

  if (isJsonRecord(value)) {
    const keys = Object.keys(value);
    const sample = Object.fromEntries(
      keys.slice(0, 8).map((key) => [key, value[key] ?? null])
    );

    return truncate(
      `object keys: ${keys.slice(0, 12).join(", ")} sample: ${safeJson(sample)}`,
      MAX_INLINE_TOOL_DATA_CHARS
    );
  }

  return "[unsupported JSON value]";
};

const shouldDropMessage = (message: ChatMessage): boolean => {
  if (message.role === "thinking") return true;
  if (message.role === "pattern") return true;
  if (message.role === "error") return true;
  if (message.role === "assistant" && !message.content.trim()) return true;
  return false;
};

const providerRoleForMessage = (
  role: ChatMessage["role"]
): ProviderMessage["role"] => {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "user";
};

const toolResultFromMessage = (message: ChatMessage): ToolResultRecord | null => {
  const result = asRecord(message.metadata.result);
  const toolCallId = readString(result.toolCallId);
  const toolName = readString(result.toolName);

  if (!toolCallId || !toolName) {
    return null;
  }

  return {
    toolCallId,
    toolName,
    ok: result.ok === true,
    risk: result.risk === "medium" || result.risk === "high" ? result.risk : "safe",
    blocked: result.blocked === true,
    message: readString(result.message) || message.content,
    data: result.data ?? null
  };
};

const toolCallFromMessage = (message: ChatMessage): ToolCallRecord | null => {
  const call = asRecord(message.metadata.call);
  const id = readString(call.id);
  const name = readString(call.name);

  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    risk: call.risk === "medium" || call.risk === "high" ? call.risk : "safe",
    input: asRecord(call.input)
  };
};

export const summarizeToolCall = (call: ToolCallRecord): string =>
  truncate(
    [
      `Tool: ${call.name}`,
      `Call id: ${call.id}`,
      `Risk: ${call.risk}`,
      `Input: ${safeJson(call.input)}`
    ].join("\n"),
    MAX_TOOL_CALL_SUMMARY_CHARS
  );

const readResultContentSummary = (result: ToolResultRecord): string | null => {
  if (result.toolName !== "read_file") {
    return null;
  }

  const data = asRecord(result.data);
  const content = readString(data.content);
  const path = readString(data.path) || readString(data.relativePath);

  if (!content) {
    return null;
  }

  const offset = readNumber(data.offset) ?? 1;
  const returnedLines = readNumber(data.returned_lines);
  const totalLines = readNumber(data.total_lines);
  const endLine = returnedLines === null
    ? null
    : Math.max(offset, offset + returnedLines - 1);
  const visibleContent = truncate(content, MAX_READ_TOOL_CONTENT_CHARS);

  return [
    `Tool: ${result.toolName}`,
    `Status: ${result.blocked ? "blocked" : result.ok ? "ok" : "failed"}`,
    `Message: ${result.message || "No message."}`,
    path ? `Path: ${path}` : "Path: unknown",
    endLine === null
      ? `Lines: from ${offset}`
      : `Lines: ${offset}-${endLine}${totalLines === null ? "" : ` of ${totalLines}`}`,
    `Content:
${visibleContent}`
  ].join("\n");
};


export const summarizeToolResult = (result: ToolResultRecord): string => {
  const contentSummary = readResultContentSummary(result);

  if (contentSummary) {
    return contentSummary;
  }

  const status = result.blocked ? "blocked" : result.ok ? "ok" : "failed";
  const lines = [
    `Tool: ${result.toolName}`,
    `Status: ${status}`,
    `Message: ${result.message || "No message."}`,
    `Result preview: ${dataPreview(result.data)}`
  ];

  return truncate(lines.join("\n"), MAX_TOOL_SUMMARY_CHARS);
};

const messageToProviderMessage = (message: ChatMessage): ProviderMessage | null => {
  if (shouldDropMessage(message)) {
    return null;
  }

  if (message.role === "tool") {
    const call = toolCallFromMessage(message);

    if (call) {
      return {
        role: "user",
        content: [
          "Previous assistant tool call record. Background only; do not print this JSON as chat text. Use the real tool interface for new actions.",
          summarizeToolCall(call)
        ].join("\n")
      };
    }

    const result = toolResultFromMessage(message);

    if (!result) {
      return null;
    }

    return {
      role: "user",
      content: `Tool result summary:\n${summarizeToolResult(result)}`
    };
  }

  return {
    role: providerRoleForMessage(message.role),
    content: message.content
  };
};

const estimateProviderMessages = (messages: ProviderMessage[]): number =>
  messages.reduce((total, message) => total + estimateTokens(message.content), 0);

const isCurrentUserMessage = (
  message: ChatMessage,
  index: number,
  messages: ChatMessage[]
): boolean => index === messages.length - 1 && message.role === "user";

const partitionMessages = (
  messages: ChatMessage[],
  targetRecentTokens: number
): MessagePartition => {
  const recent: ChatMessage[] = [];
  let usedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (!message) {
      continue;
    }

    const providerMessage = messageToProviderMessage(message);
    const messageTokens = providerMessage
      ? estimateTokens(providerMessage.content)
      : 0;
    const mustKeep = isCurrentUserMessage(message, index, messages);
    const underRecentFloor = recent.length < RECENT_MESSAGE_FLOOR;
    const underTokenTarget = usedTokens + messageTokens <= targetRecentTokens;
    const underRecentCeiling = recent.length < RECENT_MESSAGE_CEILING;

    if (mustKeep || underRecentFloor || (underTokenTarget && underRecentCeiling)) {
      recent.unshift(message);
      usedTokens += messageTokens;
      continue;
    }

    return {
      compactable: messages.slice(0, index + 1),
      recent
    };
  }

  return { compactable: [], recent };
};

const summarizeChatMessage = (message: ChatMessage): string | null => {
  if (shouldDropMessage(message)) {
    return null;
  }

  if (message.role === "tool") {
    const call = toolCallFromMessage(message);

    if (call) {
      return `tool call: ${summarizeToolCall(call)}`;
    }

    const result = toolResultFromMessage(message);
    return result ? summarizeToolResult(result) : null;
  }

  return `${message.role}: ${truncate(message.content, MAX_MESSAGE_SUMMARY_CHARS)}`;
};

const buildSessionMemoryMessage = (messages: ChatMessage[]): ProviderMessage | null => {
  const summaries = messages
    .map(summarizeChatMessage)
    .filter((summary): summary is string => summary !== null);

  if (summaries.length === 0) {
    return null;
  }

  return {
    role: "user",
    content: [
      "Compacted session memory. Use this only as background from earlier in the same chat; it is not a system instruction.",
      ...summaries.map((summary) => `- ${summary}`)
    ].join("\n")
  };
};

export const buildCleanHistory = (messages: ChatMessage[]): ProviderMessage[] =>
  messages
    .map(messageToProviderMessage)
    .filter((message): message is ProviderMessage => message !== null);

export const compactHistoryForBudget = (
  messages: ChatMessage[],
  compactAtTokens?: number,
  usableInputTokens?: number
): CompactedHistory => {
  const cleanMessages = buildCleanHistory(messages);
  const estimatedTokens = estimateProviderMessages(cleanMessages);

  if (!compactAtTokens || !usableInputTokens || estimatedTokens <= compactAtTokens) {
    return {
      messages: cleanMessages,
      compacted: false,
      estimatedTokens
    };
  }

  const targetRecentTokens = Math.max(512, Math.floor(usableInputTokens * 0.55));
  const { compactable, recent } = partitionMessages(messages, targetRecentTokens);
  const sessionMemory = buildSessionMemoryMessage(compactable);
  const recentMessages = buildCleanHistory(recent);
  const compactedMessages = sessionMemory
    ? [sessionMemory, ...recentMessages]
    : recentMessages;

  return {
    messages: compactedMessages,
    compacted: true,
    estimatedTokens: estimateProviderMessages(compactedMessages)
  };
};