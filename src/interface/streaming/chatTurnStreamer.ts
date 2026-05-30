import type {
  ChatMessage,
  RoutedChatSubmitRequest,
  StreamEvent
} from "@shared/types";
import type { ChatRepository } from "@persistence/chatRepository";
import type { AgentGraphRunner } from "@agent/agentGraph";
import {
  ChatStreamMessageWriter,
  messageInput
} from "@interface/streaming/chatStreamMessageWriter";

export type StreamEmitter = (
  event: StreamEvent
) => boolean | void | Promise<boolean | void>;

type GraphRunContext = {
  sessionId: string;
  messages: ChatMessage[];
  enabledSkills: string[];
};

type GraphAdapter = {
  stream?: (
    request: RoutedChatSubmitRequest,
    context: GraphRunContext,
    signal: AbortSignal
  ) => AsyncIterable<StreamEvent>;
  run?: (
    request: RoutedChatSubmitRequest,
    context: GraphRunContext,
    signal: AbortSignal
  ) => AsyncIterable<StreamEvent>;
};

const UI_DELTA_FLUSH_MS = 150;
const DB_FLUSH_MS = 500;
const MAX_DELTA_EVENT_CHARS = 4096;
const MAX_VISIBLE_THINKING_CHARS = 24000;
const THINKING_TRUNCATION_NOTICE =
  "\n\n[Thinking stream truncated in the UI for renderer stability. The agent kept running normally.]";
const NO_FINAL_RESPONSE_FALLBACK =
  "No final response was provided. The run ended after tool activity; review the tool output above or regenerate.";

const shouldUseRawProviderMode = (
  request: RoutedChatSubmitRequest
): boolean => {
  const provider = String(request.model.provider ?? "").toLowerCase();

  return provider.includes("nvidia") || provider.includes("groq");
};

const createEphemeralMessage = (
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
  options: {
    status?: ChatMessage["status"];
    metadata?: ChatMessage["metadata"];
  } = {}
): ChatMessage => ({
  id: crypto.randomUUID(),
  sessionId,
  role,
  content,
  status: options.status ?? "streaming",
  createdAt: new Date().toISOString(),
  metadata: {
    ...(options.metadata ?? {}),
    ephemeral: true
  }
});

const chunkText = (value: string, maxChars: number): string[] => {
  if (value.length <= maxChars) {
    return value.length > 0 ? [value] : [];
  }

  const chunks: string[] = [];

  for (let index = 0; index < value.length; index += maxChars) {
    chunks.push(value.slice(index, index + maxChars));
  }

  return chunks;
};

const appendBoundedThinking = (
  current: string,
  delta: string,
  alreadyTruncated: boolean
): {
  nextContent: string;
  visibleDelta: string;
  truncated: boolean;
  suppressedChars: number;
} => {
  if (!delta) {
    return {
      nextContent: current,
      visibleDelta: "",
      truncated: alreadyTruncated,
      suppressedChars: 0
    };
  }

  if (alreadyTruncated || current.length >= MAX_VISIBLE_THINKING_CHARS) {
    return {
      nextContent: current,
      visibleDelta: "",
      truncated: true,
      suppressedChars: delta.length
    };
  }

  const remaining = MAX_VISIBLE_THINKING_CHARS - current.length;

  if (delta.length <= remaining) {
    return {
      nextContent: current + delta,
      visibleDelta: delta,
      truncated: false,
      suppressedChars: 0
    };
  }

  const visiblePart = delta.slice(0, remaining);
  const notice =
    current.includes(THINKING_TRUNCATION_NOTICE) || visiblePart.includes(THINKING_TRUNCATION_NOTICE)
      ? ""
      : THINKING_TRUNCATION_NOTICE;
  const visibleDelta = visiblePart + notice;

  return {
    nextContent: current + visibleDelta,
    visibleDelta,
    truncated: true,
    suppressedChars: delta.length - visiblePart.length
  };
};

export class ChatTurnStreamer {
  private readonly messages: ChatStreamMessageWriter;

  constructor(
    private readonly chats: ChatRepository,
    private readonly graph: AgentGraphRunner,
    private readonly enabledSkillInstructions: (
      request: RoutedChatSubmitRequest
    ) => string[]
  ) {
    this.messages = new ChatStreamMessageWriter(chats);
  }

  async run(
    request: RoutedChatSubmitRequest,
    emit: StreamEmitter,
    signal: AbortSignal
  ): Promise<void> {
    if (!request.sessionId) {
      throw new Error("Assistant turn requires a persisted session.");
    }

    const sessionId = request.sessionId;
    const rawProviderMode = shouldUseRawProviderMode(request);
    const liveStreaming = request.responseStreamingEnabled !== false;
    const runAbort = new AbortController();
    let streamOpen = true;

    const abortRun = (): void => {
      if (!runAbort.signal.aborted) {
        runAbort.abort();
      }
    };

    const externalAbortListener = (): void => {
      abortRun();
    };

    signal.addEventListener("abort", externalAbortListener, { once: true });

    const safeEmit = async (event: StreamEvent): Promise<boolean> => {
      if (!streamOpen || runAbort.signal.aborted) {
        return false;
      }

      try {
        const result = await emit(event);

        if (result === false) {
          streamOpen = false;
          abortRun();
          return false;
        }

        return true;
      } catch {
        streamOpen = false;
        abortRun();
        return false;
      }
    };

    const writerEmit = async (event: StreamEvent): Promise<void> => {
      await safeEmit(event);
    };

    const assistantMessage = rawProviderMode
      ? createEphemeralMessage(sessionId, "assistant", "", {
          status: "streaming",
          metadata: {
            visibility: "user",
            timelineKind: "final"
          }
        })
      : this.chats.addMessage(
          messageInput(sessionId, "assistant", "", {
            status: "streaming",
            metadata: {
              visibility: "user",
              timelineKind: "final"
            }
          })
        );

    if (!(await safeEmit({ type: "message_created", message: assistantMessage }))) {
      signal.removeEventListener("abort", externalAbortListener);
      return;
    }

    let thinkingMessage: ChatMessage | null = null;
    let assistantContent = "";
    let thinkingContent = "";
    let assistantDirty = false;
    let thinkingDirty = false;
    let thinkingTruncated = false;
    let suppressedThinkingChars = 0;
    let lastAssistantPersist = 0;
    let lastThinkingPersist = 0;
    let lastAssistantUiEmit = 0;
    let lastThinkingUiEmit = 0;
    let hadGraphError = false;
    let emittedAssistantLength = 0;
    let emittedThinkingLength = 0;

    const shouldPersist = (lastPersistedAt: number): boolean =>
      Date.now() - lastPersistedAt >= DB_FLUSH_MS;

    const shouldEmitUi = (lastEmittedAt: number): boolean =>
      Date.now() - lastEmittedAt >= UI_DELTA_FLUSH_MS;

    const ensureThinkingMessage = async (): Promise<ChatMessage | null> => {
      if (thinkingMessage) {
        return thinkingMessage;
      }

      if (rawProviderMode) {
        thinkingMessage = createEphemeralMessage(sessionId, "thinking", "", {
          status: "streaming",
          metadata: {
            visibility: "user",
            timelineKind: "thinking",
            label: "Thinking",
            truncated: false,
            maxVisibleChars: MAX_VISIBLE_THINKING_CHARS
          }
        });

        if (!(await safeEmit({ type: "message_created", message: thinkingMessage }))) {
          return null;
        }

        return thinkingMessage;
      }

      thinkingMessage = await this.messages.createThinkingMessage(
        sessionId,
        writerEmit
      );

      return streamOpen ? thinkingMessage : null;
    };

    const flushAssistantContent = (force = false): void => {
      if (rawProviderMode) return;
      if (!assistantDirty) return;
      if (!force && !shouldPersist(lastAssistantPersist)) return;

      this.chats.updateMessageContent(
        assistantMessage.id,
        assistantContent,
        "streaming"
      );

      assistantDirty = false;
      lastAssistantPersist = Date.now();
    };

    const flushThinkingContent = (force = false): void => {
      if (rawProviderMode) return;
      if (!thinkingMessage || !thinkingDirty) return;
      if (!force && !shouldPersist(lastThinkingPersist)) return;

      this.chats.updateMessageContent(
        thinkingMessage.id,
        thinkingContent,
        "streaming"
      );

      thinkingDirty = false;
      lastThinkingPersist = Date.now();
    };

    const emitAssistantDeltaChunks = async (
      delta: string
    ): Promise<boolean> => {
      for (const chunk of chunkText(delta, MAX_DELTA_EVENT_CHARS)) {
        if (
          !(await safeEmit({
            type: "assistant_delta",
            messageId: assistantMessage.id,
            delta: chunk,
            phase: "final"
          }))
        ) {
          return false;
        }
      }

      return true;
    };

    const emitThinkingDeltaChunks = async (
      messageId: string,
      delta: string
    ): Promise<boolean> => {
      for (const chunk of chunkText(delta, MAX_DELTA_EVENT_CHARS)) {
        if (
          !(await safeEmit({
            type: "thinking_delta",
            messageId,
            delta: chunk
          }))
        ) {
          return false;
        }
      }

      return true;
    };

    const emitBufferedAssistant = async (
      force = false
    ): Promise<boolean> => {
      const delta = assistantContent.slice(emittedAssistantLength);

      if (!delta) return true;
      if (!force && liveStreaming && !shouldEmitUi(lastAssistantUiEmit)) {
        return true;
      }
      if (!force && !liveStreaming) return true;

      if (!(await emitAssistantDeltaChunks(delta))) {
        return false;
      }

      emittedAssistantLength = assistantContent.length;
      lastAssistantUiEmit = Date.now();
      return true;
    };

    const emitBufferedThinking = async (
      force = false
    ): Promise<boolean> => {
      const delta = thinkingContent.slice(emittedThinkingLength);

      if (!delta) return true;
      if (!force && liveStreaming && !shouldEmitUi(lastThinkingUiEmit)) {
        return true;
      }
      if (!force && !liveStreaming) return true;

      const message = await ensureThinkingMessage();

      if (!message) {
        return false;
      }

      if (!(await emitThinkingDeltaChunks(message.id, delta))) {
        return false;
      }

      emittedThinkingLength = thinkingContent.length;
      lastThinkingUiEmit = Date.now();
      return true;
    };

    const flushBufferedOutput = async (): Promise<boolean> => {
      if (!(await emitBufferedThinking(true))) {
        return false;
      }

      if (!(await emitBufferedAssistant(true))) {
        return false;
      }

      flushThinkingContent(true);
      flushAssistantContent(true);
      return true;
    };

    const appendAssistantDelta = async (delta: string): Promise<boolean> => {
      if (!delta) return true;

      assistantContent += delta;
      assistantDirty = true;

      if (!(await emitBufferedAssistant(false))) {
        return false;
      }

      flushAssistantContent(false);
      return true;
    };

    const appendThinkingDelta = async (delta: string): Promise<boolean> => {
      if (!delta) return true;

      const bounded = appendBoundedThinking(
        thinkingContent,
        delta,
        thinkingTruncated
      );

      thinkingContent = bounded.nextContent;
      thinkingTruncated = bounded.truncated;
      suppressedThinkingChars += bounded.suppressedChars;

      if (!bounded.visibleDelta) {
        return true;
      }

      thinkingDirty = true;

      if (!(await emitBufferedThinking(false))) {
        return false;
      }

      flushThinkingContent(false);
      return true;
    };

    const persistRawAssistantOnce = (
      status: ChatMessage["status"]
    ): void => {
      if (!rawProviderMode) return;
      if (!assistantContent.trim()) return;

      this.chats.addMessage(
        messageInput(sessionId, "assistant", assistantContent, {
          status,
          metadata: {
            visibility: "user",
            timelineKind: "final"
          }
        })
      );
    };

    const persistRawThinkingOnce = (
      status: ChatMessage["status"]
    ): void => {
      if (!rawProviderMode) return;
      if (!thinkingContent.trim()) return;

      this.chats.addMessage(
        messageInput(sessionId, "thinking", thinkingContent, {
          status,
          metadata: {
            visibility: "user",
            timelineKind: "thinking",
            label: "Thinking",
            truncated: thinkingTruncated,
            maxVisibleChars: MAX_VISIBLE_THINKING_CHARS,
            suppressedChars: suppressedThinkingChars
          }
        })
      );
    };

    const completeStreamingMessages = (): void => {
      if (rawProviderMode) {
        persistRawThinkingOnce("complete");
        persistRawAssistantOnce("complete");
        return;
      }

      this.chats.updateMessageStatus(assistantMessage.id, "complete");

      if (thinkingMessage) {
        this.chats.updateMessageStatus(thinkingMessage.id, "complete");
      }
    };

    const failStreamingMessages = (): void => {
      if (rawProviderMode) {
        persistRawThinkingOnce("failed");
        persistRawAssistantOnce("failed");
        return;
      }

      this.markStreamingMessagesFailed(assistantMessage, thinkingMessage);
    };

    const stopBecauseClientClosed = (): void => {
      streamOpen = false;
      abortRun();
      failStreamingMessages();
    };

    try {
      for await (const event of this.runGraph(request, runAbort.signal)) {
        if (!streamOpen || runAbort.signal.aborted) {
          stopBecauseClientClosed();
          return;
        }

        if (event.type === "turn_started") {
          if (
            !(await safeEmit({
              ...event,
              assistantMessageId: assistantMessage.id
            }))
          ) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "assistant_delta" || event.type === "final_delta") {
          if (!(await appendAssistantDelta(event.delta))) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (
          event.type === "reasoning_summary_delta" ||
          event.type === "thinking_delta"
        ) {
          if (!(await appendThinkingDelta(event.delta))) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "reasoning_raw_delta") {
          if (!(await appendThinkingDelta(event.delta))) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "pattern_decision") {
          if (!(await flushBufferedOutput())) {
            stopBecauseClientClosed();
            return;
          }

          await this.messages.emitPatternDecision(
            sessionId,
            event.decision,
            writerEmit
          );

          if (!streamOpen) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "plan_delta") {
          if (!(await flushBufferedOutput())) {
            stopBecauseClientClosed();
            return;
          }

          await this.messages.emitProgress(
            sessionId,
            {
              id: `plan-${crypto.randomUUID()}`,
              sessionId,
              role: "progress",
              content: event.delta,
              status: "complete",
              createdAt: new Date().toISOString(),
              metadata: {
                visibility: "user",
                timelineKind: "plan",
                label: "Plan"
              }
            },
            writerEmit
          );

          if (!streamOpen) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "progress") {
          if (!(await flushBufferedOutput())) {
            stopBecauseClientClosed();
            return;
          }

          await this.messages.emitProgress(sessionId, event.message, writerEmit);

          if (!streamOpen) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "tool_call" || event.type === "tool_started") {
          if (!(await flushBufferedOutput())) {
            stopBecauseClientClosed();
            return;
          }

          await this.messages.emitToolCall(sessionId, event.call, writerEmit);

          if (!streamOpen) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "permission_request") {
          if (!(await flushBufferedOutput())) {
            stopBecauseClientClosed();
            return;
          }

          if (!(await safeEmit(event))) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "tool_result" || event.type === "tool_completed") {
          if (!(await flushBufferedOutput())) {
            stopBecauseClientClosed();
            return;
          }

          await this.messages.emitToolResult(sessionId, event.result, writerEmit);

          if (!streamOpen) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "error") {
          hadGraphError = true;

          if (!(await flushBufferedOutput())) {
            stopBecauseClientClosed();
            return;
          }

          await this.messages.emitError(sessionId, event.error, writerEmit);

          if (!streamOpen) {
            stopBecauseClientClosed();
            return;
          }

          continue;
        }

        if (event.type === "turn_completed") {
          if (!(await flushBufferedOutput())) {
            stopBecauseClientClosed();
            return;
          }

          if (
            !(await safeEmit({
              ...event,
              assistantMessageId: assistantMessage.id
            }))
          ) {
            stopBecauseClientClosed();
            return;
          }
        }
      }

      if (!(await flushBufferedOutput())) {
        stopBecauseClientClosed();
        return;
      }

      if (hadGraphError) {
        failStreamingMessages();
        return;
      }

      if (!assistantContent.trim()) {
        if (!(await appendAssistantDelta(NO_FINAL_RESPONSE_FALLBACK))) {
          stopBecauseClientClosed();
          return;
        }

        if (!(await flushBufferedOutput())) {
          stopBecauseClientClosed();
          return;
        }
      }

      completeStreamingMessages();

      if (
        !(await safeEmit({
          type: "turn_completed",
          sessionId,
          assistantMessageId: assistantMessage.id
        }))
      ) {
        return;
      }

      await safeEmit({
        type: "done",
        sessionId,
        assistantMessageId: assistantMessage.id
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Agent execution failed.";

      if (streamOpen) {
        await flushBufferedOutput();
      }

      failStreamingMessages();

      if (streamOpen) {
        await this.messages.emitError(sessionId, message, writerEmit);
      }
    } finally {
      signal.removeEventListener("abort", externalAbortListener);
    }
  }

  private async *runGraph(
    request: RoutedChatSubmitRequest,
    signal: AbortSignal
  ): AsyncIterable<StreamEvent> {
    if (!request.sessionId) return;

    const sessionId = request.sessionId;
    const context: GraphRunContext = {
      sessionId,
      messages: this.chats.listMessages(sessionId),
      enabledSkills: this.enabledSkillInstructions(request)
    };

    const adapter = this.graph as unknown as GraphAdapter;
    const stream =
      typeof adapter.stream === "function"
        ? adapter.stream(request, context, signal)
        : adapter.run?.(request, context, signal);

    if (!stream) {
      throw new Error("Agent graph does not expose a stream or run method.");
    }

    for await (const event of stream) {
      yield event;
    }
  }

  private markStreamingMessagesFailed(
    assistantMessage: ChatMessage,
    thinkingMessage: ChatMessage | null
  ): void {
    this.chats.updateMessageStatus(assistantMessage.id, "failed");

    if (thinkingMessage) {
      this.chats.updateMessageStatus(thinkingMessage.id, "failed");
    }
  }
}