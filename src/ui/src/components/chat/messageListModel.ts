import type { ChatMessage } from "@shared/types";

export interface Turn {
  user: ChatMessage;
  events: ChatMessage[];
}

export type TimelineEntry =
  | { kind: "progress"; message: ChatMessage }
  | { kind: "waiting" }
  | { kind: "thinking"; messages: ChatMessage[]; active: boolean }
  | { kind: "tools"; messages: ChatMessage[]; active: boolean }
  | { kind: "message"; message: ChatMessage };

export const labelByRole: Record<ChatMessage["role"], string> = {
  user: "You",
  assistant: "Super Agent",
  thinking: "Thinking",
  progress: "Progress",
  pattern: "Pattern Decision",
  tool: "Tool",
  error: "Error",
};

export const metadataString = (message: ChatMessage, key: string): string => {
  const value = message.metadata[key];
  return typeof value === "string" ? value : "";
};

export const isInternalMessage = (message: ChatMessage): boolean =>
  metadataString(message, "visibility") === "internal" ||
  (message.role === "progress" &&
    (typeof message.metadata.nextAction === "string" ||
      Array.isArray(message.metadata.files) ||
      Array.isArray(message.metadata.criteria)));

export const isPatternDecision = (message: ChatMessage): boolean =>
  message.role === "pattern" ||
  metadataString(message, "kind") === "pattern_decision";

export const isEmptyStreamingAssistant = (message: ChatMessage): boolean =>
  message.role === "assistant" &&
  message.status === "streaming" &&
  message.content.trim().length === 0;

export const visibleMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.filter(
    (message) =>
      !isInternalMessage(message) &&
      !isPatternDecision(message) &&
      !isEmptyStreamingAssistant(message),
  );

export const buildTurns = (
  messages: ChatMessage[],
): { beforeTurns: ChatMessage[]; turns: Turn[] } => {
  const beforeTurns: ChatMessage[] = [];
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const message of visibleMessages(messages)) {
    if (message.role === "user") {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { user: message, events: [] };
      continue;
    }

    if (!currentTurn) {
      beforeTurns.push(message);
      continue;
    }

    currentTurn.events.push(message);
  }

  if (currentTurn) turns.push(currentTurn);
  return { beforeTurns, turns };
};

export const parseTime = (value: string): number => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Date.now();
};

export const latestTurnTime = (turn: Turn): number =>
  [turn.user, ...turn.events].reduce(
    (latest, message) => Math.max(latest, parseTime(message.createdAt)),
    0,
  );

export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const remainingSeconds = seconds % 60;

  if (hours > 0) return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
};

export const hasRunActivity = (turn: Turn): boolean =>
  turn.events.some(
    (message) =>
      message.role !== "assistant" || message.content.trim().length > 0,
  );

export const timelineMessages = (turn: Turn): ChatMessage[] =>
  [...turn.events].sort(
    (a, b) => parseTime(a.createdAt) - parseTime(b.createdAt),
  );

export const countToolCalls = (messages: ChatMessage[]): number =>
  messages.filter((message) => typeof message.metadata.call === "object")
    .length;

export const isFinalMessage = (message: ChatMessage): boolean =>
  message.role === "assistant" || message.role === "error";

export const emptyAssistantFallback =
  "No final response was provided. The run ended after tool activity; review the tool output above or regenerate.";

export const isVisibleProgress = (message: ChatMessage): boolean =>
  message.role === "progress" &&
  metadataString(message, "visibility") !== "internal";

export const timelineEntries = (turn: Turn, active: boolean): TimelineEntry[] => {
  const messages = timelineMessages(turn);
  const progressMessages: ChatMessage[] = [];
  const thinkingMessages: ChatMessage[] = [];
  const toolMessages: ChatMessage[] = [];
  const finalMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "thinking") {
      thinkingMessages.push(message);
      continue;
    }

    if (message.role === "tool") {
      toolMessages.push(message);
      continue;
    }

    if (isVisibleProgress(message)) {
      progressMessages.push(message);
      continue;
    }

    if (isFinalMessage(message)) {
      finalMessages.push(message);
    }
  }

  const entries: TimelineEntry[] = [];

  for (const message of progressMessages) {
    entries.push({ kind: "progress", message });
  }

  if (thinkingMessages.length > 0) {
    entries.push({
      kind: "thinking",
      messages: thinkingMessages,
      active: active && finalMessages.length === 0,
    });
  }

  if (
    active &&
    progressMessages.length === 0 &&
    thinkingMessages.length === 0 &&
    toolMessages.length === 0 &&
    finalMessages.length === 0
  ) {
    entries.push({ kind: "waiting" });
  }

  if (toolMessages.length > 0) {
    entries.push({
      kind: "tools",
      messages: toolMessages,
      active: active && finalMessages.length === 0,
    });
  }

  for (const message of finalMessages) {
    entries.push({ kind: "message", message });
  }

  return entries;
};
