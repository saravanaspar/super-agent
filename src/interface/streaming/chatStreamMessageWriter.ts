import type {
  AgenticPatternDecision,
  ChatMessage,
  ToolCallRecord,
  ToolResultRecord
} from "@shared/types";
import type { JsonRecord } from "@shared/json";
import { redactSensitiveJson, redactSensitiveText } from "@shared/redaction";
import type {
  ChatMessageInput,
  ChatRepository
} from "@persistence/chatRepository";
import type { StreamEmitter } from "@interface/streaming/chatTurnStreamer";

const currentTimestamp = (): string => new Date().toISOString();

export const messageInput = (
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
  options: {
    status?: ChatMessage["status"];
    metadata?: JsonRecord;
  } = {}
): ChatMessageInput => ({
  sessionId,
  role,
  content,
  status: options.status ?? "complete",
  createdAt: currentTimestamp(),
  metadata: options.metadata ?? {}
});

const toolCallToJson = (call: ToolCallRecord): JsonRecord => ({
  id: call.id,
  name: call.name,
  risk: call.risk,
  input: redactSensitiveJson(call.input)
});

const toolResultToJson = (result: ToolResultRecord): JsonRecord => ({
  toolCallId: result.toolCallId,
  toolName: result.toolName,
  ok: result.ok,
  risk: result.risk,
  blocked: result.blocked,
  message: redactSensitiveText(result.message),
  data: redactSensitiveJson(result.data)
});

const getToolResultStatus = (
  result: ToolResultRecord
): ChatMessage["status"] => {
  if (result.blocked) return "blocked";
  return result.ok ? "complete" : "failed";
};

const compactPatternDecision = (
  decision: AgenticPatternDecision
): JsonRecord => ({
  path: decision.path.selected,
  flow: decision.flow.selected,
  tooling: decision.tooling.selected,
  execution: decision.execution.selected,
  priority: decision.priority.selected,
  agents: decision.agents.selected,
  selectedPatterns: decision.selectedPatterns,
  visibility: "internal",
  timelineKind: "pattern_decision"
});

const shouldDisplayProgress = (message: ChatMessage): boolean =>
  message.content.trim().length > 0 && message.metadata.visibility !== "internal";

export class ChatStreamMessageWriter {
  constructor(private readonly chats: ChatRepository) {}

  async createThinkingMessage(
    sessionId: string,
    emit: StreamEmitter
  ): Promise<ChatMessage> {
    const message = this.chats.addMessage(
      messageInput(sessionId, "thinking", "", {
        status: "streaming",
        metadata: {
          visibility: "internal",
          timelineKind: "reasoning_summary"
        }
      })
    );

    await emit({ type: "message_created", message });
    return message;
  }

  async emitPatternDecision(
    sessionId: string,
    decision: AgenticPatternDecision,
    emit: StreamEmitter
  ): Promise<void> {
    const message = this.chats.addMessage(
      messageInput(sessionId, "pattern", "Agentic pattern decision recorded.", {
        metadata: compactPatternDecision(decision)
      })
    );

    await emit({
      type: "pattern_decision",
      message,
      decision
    });
  }

  async emitProgress(
    sessionId: string,
    source: ChatMessage,
    emit: StreamEmitter
  ): Promise<void> {
    if (!shouldDisplayProgress(source)) return;

    const message = this.chats.addMessage(
      messageInput(sessionId, "progress", source.content.trim(), {
        status: source.status,
        metadata: {
          ...source.metadata,
          visibility: "user",
          timelineKind:
            typeof source.metadata.timelineKind === "string"
              ? source.metadata.timelineKind
              : "progress",
          label:
            typeof source.metadata.label === "string"
              ? source.metadata.label
              : "Progress"
        }
      })
    );

    await emit({ type: "progress", message });
  }

  async emitToolCall(
    sessionId: string,
    call: ToolCallRecord,
    emit: StreamEmitter
  ): Promise<void> {
    const message = this.chats.addMessage(
      messageInput(sessionId, "tool", `Calling ${call.name}`, {
        metadata: {
          visibility: "user",
          timelineKind: "tool",
          call: toolCallToJson(call)
        }
      })
    );

    await emit({
      type: "tool_started",
      message,
      call
    });
    await emit({
      type: "tool_call",
      message,
      call
    });
  }

  async emitToolResult(
    sessionId: string,
    result: ToolResultRecord,
    emit: StreamEmitter
  ): Promise<void> {
    const safeResult: ToolResultRecord = {
      ...result,
      message: redactSensitiveText(result.message),
      data: redactSensitiveJson(result.data)
    };
    const message = this.chats.addMessage(
      messageInput(sessionId, "tool", safeResult.message, {
        status: getToolResultStatus(safeResult),
        metadata: {
          visibility: "user",
          timelineKind: "tool",
          result: toolResultToJson(safeResult)
        }
      })
    );

    await emit({
      type: "tool_completed",
      message,
      result: safeResult
    });
    await emit({
      type: "tool_result",
      message,
      result: safeResult
    });
  }

  async emitError(
    sessionId: string,
    error: string,
    emit: StreamEmitter
  ): Promise<void> {
    const message = this.chats.addMessage(
      messageInput(sessionId, "error", error, {
        status: "failed",
        metadata: {
          visibility: "user",
          timelineKind: "error"
        }
      })
    );

    await emit({
      type: "error",
      message,
      error
    });
  }
}
