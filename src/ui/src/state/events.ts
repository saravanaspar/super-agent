import type { ChatMessage, ChatSession, StreamEvent } from "@shared/types";

const insertThinkingMessage = (
  messages: ChatMessage[],
  message: ChatMessage
): ChatMessage[] => {
  const existing = messages.some((item) => item.id === message.id);

  if (existing) {
    return messages.map((item) => (item.id === message.id ? message : item));
  }

  let streamingAssistantIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];

    if (!item) continue;

    if (item.role === "assistant" && item.status === "streaming") {
      streamingAssistantIndex = index;
      break;
    }
  }

  if (streamingAssistantIndex < 0) return [...messages, message];

  return [
    ...messages.slice(0, streamingAssistantIndex),
    message,
    ...messages.slice(streamingAssistantIndex)
  ];
};

export const upsertMessage = (
  messages: ChatMessage[],
  message: ChatMessage
): ChatMessage[] => {
  if (message.role === "thinking") {
    return insertThinkingMessage(messages, message);
  }

  const exists = messages.some((item) => item.id === message.id);
  return exists
    ? messages.map((item) => (item.id === message.id ? message : item))
    : [...messages, message];
};

export const upsertSession = (
  sessions: ChatSession[],
  session: ChatSession
): ChatSession[] => {
  const filtered = sessions.filter((item) => item.id !== session.id);
  return [session, ...filtered];
};

const appendDelta = (
  messages: ChatMessage[],
  messageId: string,
  delta: string
): ChatMessage[] =>
  messages.map((message) =>
    message.id === messageId
      ? { ...message, content: message.content + delta }
      : message
  );

export const applyStreamEvent = (
  messages: ChatMessage[],
  event: StreamEvent
): ChatMessage[] => {
  if (
    event.type === "message_created" ||
    event.type === "pattern_decision" ||
    event.type === "progress" ||
    event.type === "tool_call" ||
    event.type === "tool_started" ||
    event.type === "tool_result" ||
    event.type === "tool_completed" ||
    event.type === "error"
  ) {
    return event.message ? upsertMessage(messages, event.message) : messages;
  }

  if (
    event.type === "assistant_delta" ||
    event.type === "final_delta" ||
    event.type === "thinking_delta" ||
    event.type === "reasoning_summary_delta" ||
    event.type === "plan_delta"
  ) {
    return appendDelta(messages, event.messageId, event.delta);
  }

  if (event.type === "reasoning_raw_delta" || event.type === "turn_started") {
    return messages;
  }

  if (event.type === "done" || event.type === "turn_completed") {
    return messages.map((message) =>
      message.status === "streaming"
        ? { ...message, status: "complete" }
        : message
    );
  }

  return messages;
};

export const removeAfterLastUser = (
  messages: ChatMessage[]
): ChatMessage[] => {
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  return lastUser < 0 ? messages : messages.slice(0, lastUser + 1);
};
