import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { ContextBuilder } from "@memory/contextBuilder";
import type { MemoryRepository } from "@persistence/memoryRepository";
import type { PermissionService } from "@permissions/permissionService";
import type { ApprovalBroker } from "@permissions/approvalBroker";
import type { ToolRegistry } from "@tool-registry/toolRegistry";
import type { ToolExecutionContext } from "@tool-registry/types";
import { successResult, toBlockedToolResult } from "@tool-registry/types";
import type {
  ChatMessage,
  RoutedChatSubmitRequest,
  ModelOption,
  StreamEvent,
  ToolCallRecord,
  ToolResultRecord
} from "@shared/types";
import type { JsonRecord } from "@shared/json";
import type { LlmService } from "@providers/providerService";
import type { ProviderMessage } from "@providers/interfaces/provider";
import { buildSystemPrompt } from "@prompts/promptLoader";
import { buildPromptEnvelope } from "@providers/context/promptEnvelope";
import { SessionStateLedger, injectSessionStateMessage } from "./sessionStateLedger";
import {
  canonicalizeProviderTools,
  normalizeToolCall
} from "./toolCallNormalizer";
import {
  ConsecutiveToolCallGuard,
  RepeatedReadToolGuard,
  sameTurnDuplicateToolResult,
  toolCallFingerprint,
  toolInputLooksMalformed,
} from "./toolLoopGuards";
export { ConsecutiveToolCallGuard, RepeatedReadToolGuard, toolInputLooksMalformed } from "./toolLoopGuards";
import {
  buildRuntimeGates,
  firstIncompleteRuntimeGate,
  hasRuntimeGate,
  runtimeGateProgressMemory,
  updateRuntimeGatesFromToolResult,
  verifyRuntimeGates,
  type RuntimeGate,
  type RuntimeGateVerification
} from "./runtimeGates";
import {
  buildAssistantToolBridgeMessage,
  buildRuntimeControlMessage,
  buildToolMessage,
  compactProviderMessagesForLoop,
  createPatternDecision,
  eventMessageStatus,
  finalReviewAfterLoopGuidanceInstruction,
  makeMessage,
  shouldForceFinalReviewAfterLoopGuidance,
  shouldStopStalledNoToolContinuation,
  toolLimitsForRequest,
  usesRawAssistantStreaming,
} from "./agentRunHelpers";
import { getGatedFinalAnswerRepair, PostEditVerificationTracker, shouldStopFinalAnswerRepair } from "./finalAnswerRepair";
import { parseTextToolCalls, type TextToolCall } from "./textToolCallParser";
export { getGatedFinalAnswerRepair, PostEditVerificationTracker } from "./finalAnswerRepair";

export interface AgentGraphCallbacks {
  onToken: (delta: string) => void;
  onThinking: (delta: string) => void;
  onToolCall: (call: ToolCallRecord) => void;
  onPermissionRequest: (call: ToolCallRecord, reason: string) => void;
  onToolResult: (result: ToolResultRecord) => void;
  onError: (message: string) => void;
}

export interface AgentGraphInput {
  request: RoutedChatSubmitRequest;
  messages: ChatMessage[];
  systemPrompt: string;
  signal?: AbortSignal;
}

interface GraphRunContext {
  sessionId: string;
  messages: ChatMessage[];
  enabledSkills: string[];
}

type ToolExecutionStreamItem =
  | {
      type: "permission_request";
      call: ToolCallRecord;
      reason: string;
    }
  | {
      type: "tool_result";
      result: ToolResultRecord;
    };

const GraphState = Annotation.Root({
  providerMessages: Annotation<ProviderMessage[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  errors: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => []
  })
});

type AgentState = typeof GraphState.State;

const MAX_TOOL_LOOP_ITERATIONS = 40;

export class AgentGraphRunner {
  constructor(
    private readonly llm: LlmService,
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionService,
    private readonly approvals: ApprovalBroker,
    private readonly contextBuilder: ContextBuilder,
    private readonly memory: MemoryRepository,
    private readonly toolContext: ToolExecutionContext
  ) {}

  async *stream(
    request: RoutedChatSubmitRequest,
    context: GraphRunContext,
    signal: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const rawStreaming = usesRawAssistantStreaming(request.model);
    const systemPrompt = buildSystemPrompt(
      request.agentKind,
      context.enabledSkills.join("\n\n")
    );

    const input: AgentGraphInput = {
      request,
      messages: context.messages,
      systemPrompt,
      signal
    };

    const initialState = await this.initializeGraphState(input);
    const sessionId = request.sessionId ?? "";
    const providerTools = canonicalizeProviderTools(
      this.registry.toProviderTools()
    );
    const commandLabel = request.command ? `/${request.command.name}` : null;
    const runtimeGates = buildRuntimeGates({
      request,
      messages: context.messages,
      workspaceDir: this.toolContext.workspaceDir
    });

    yield {
      type: "pattern_decision",
      decision: createPatternDecision(
        providerTools,
        runtimeGates,
        rawStreaming
      ),
      message: makeMessage(
        sessionId,
        "pattern",
        commandLabel
          ? `${commandLabel} command accepted. Runtime gate enabled.`
          : hasRuntimeGate(runtimeGates, "evidence")
            ? "Evidence workflow detected. Deterministic verification enabled."
            : rawStreaming
              ? "Raw assistant streaming enabled for this provider."
              : hasRuntimeGate(runtimeGates, "review")
                ? "Review workflow detected. Review completeness checks enabled."
                : "Agentic pattern decision recorded.",
        "complete",
        { visibility: "internal", timelineKind: "pattern_decision" }
      )
    };

    yield {
      type: "turn_started",
      sessionId,
      assistantMessageId: ""
    };

    yield* this.streamToolLoop(input, initialState, runtimeGates);
  }

  async run(
    input: AgentGraphInput,
    callbacks: AgentGraphCallbacks
  ): Promise<AgentState> {
    const runtimeGates = buildRuntimeGates({
      request: input.request,
      messages: input.messages,
      workspaceDir: this.toolContext.workspaceDir
    });
    const initialState = await this.initializeGraphState(input);

    for await (const event of this.streamToolLoop(
      input,
      initialState,
      runtimeGates
    )) {
      this.forwardEventToCallbacks(event, callbacks);
    }

    return initialState;
  }

  private async initializeGraphState(
    input: AgentGraphInput
  ): Promise<AgentState> {
    const graph = new StateGraph(GraphState)
      .addNode("memory_context", () => this.memoryNode(input))
      .addNode("prompt_context", state => this.promptNode(state))
      .addEdge(START, "memory_context")
      .addEdge("memory_context", "prompt_context")
      .addEdge("prompt_context", END)
      .compile();

    return graph.invoke({});
  }

  private memoryNode(input: AgentGraphInput): Partial<AgentState> {
    const context = this.contextBuilder.build(
      input.messages,
      this.memory.listRecent(5)
    );

    const envelope = buildPromptEnvelope({
      systemPrompt: input.systemPrompt,
      model: input.request.model,
      messages: input.messages,
      memories: context.longTermMemory,
      tools: canonicalizeProviderTools(this.registry.toProviderTools())
    });

    return { providerMessages: envelope.messages };
  }

  private promptNode(state: AgentState): Partial<AgentState> {
    return { providerMessages: state.providerMessages };
  }

  private textToolCallToRecord(call: TextToolCall): ToolCallRecord {
    const rawCall: ToolCallRecord = {
      id: call.id ?? `text-tool-${crypto.randomUUID()}`,
      name: call.name,
      input: call.input,
      risk: this.registry.get(call.name)?.risk ?? "medium"
    };

    return normalizeToolCall(this.registry, rawCall);
  }

  private async *streamToolLoop(
    input: AgentGraphInput,
    state: AgentState,
    runtimeGates: RuntimeGate[]
  ): AsyncIterable<StreamEvent> {
    let providerMessages = state.providerMessages;
    const sessionId = input.request.sessionId ?? "";
    const rawStreaming = usesRawAssistantStreaming(input.request.model);
    const gatedMode = runtimeGates.length > 0;
    const toolLimits = toolLimitsForRequest(input.request, runtimeGates);
    const toolCallGuard = new ConsecutiveToolCallGuard(
      toolLimits.maxDuplicateToolCalls
    );
    const repeatedReadGuard = new RepeatedReadToolGuard();
    const stalledNoToolContinuations = new Map<string, number>();
    const finalAnswerRepairCounts = new Map<string, number>();
    const postEditRepairCounts = new Map<string, number>();
    const postEditVerificationTracker = new PostEditVerificationTracker();
    const sessionStateLedger = new SessionStateLedger({
      request: input.request,
      messages: input.messages,
      workspaceDir: this.toolContext.workspaceDir
    });

    let loopIterations = 0;

    while (true) {
      loopIterations += 1;

      if (loopIterations > MAX_TOOL_LOOP_ITERATIONS) {
        const error = [
          "Tool loop stopped because the provider kept requesting more actions without finishing.",
          "Use the collected evidence or regenerate after switching to a stronger structured tool-calling model."
        ].join(" ");

        yield {
          type: "error",
          error,
          message: makeMessage(sessionId, "error", error, "failed", {
            visibility: "user",
            timelineKind: "error"
          })
        };

        return;
      }

      if (input.signal?.aborted) {
        return;
      }

      providerMessages = compactProviderMessagesForLoop(
        providerMessages,
        input.request.model
      );

      const sessionStateMessage = sessionStateLedger.buildMessage({
        runtimeVerifications: verifyRuntimeGates(runtimeGates)
      });
      const providerMessagesForCall = injectSessionStateMessage(
        providerMessages,
        sessionStateMessage
      );
      let assistantText = "";
      const toolCalls: ToolCallRecord[] = [];
      const providerTools = canonicalizeProviderTools(
        this.registry.toProviderTools()
      );
      let failed = false;

      try {
        const stream = this.llm.stream(
          {
            model: input.request.model,
            instructions: input.systemPrompt,
            messages: providerMessagesForCall,
            tools: providerTools
          },
          input.signal
        );

        for await (const event of stream) {
          if (input.signal?.aborted) {
            return;
          }

          if (event.type === "thinking") {
            if (rawStreaming) {
              yield {
                type: "reasoning_raw_delta",
                delta: event.delta
              };
            } else {
              yield {
                type: "reasoning_summary_delta",
                messageId: "",
                delta: event.delta
              };
            }
          } else if (event.type === "token") {
            assistantText += event.delta;
          } else if (event.type === "tool_call") {
            const call = normalizeToolCall(this.registry, event.call);

            toolCalls.push(call);

            yield {
              type: "tool_started",
              call,
              message: makeMessage(sessionId, "tool", `Calling ${call.name}`)
            };
          } else if (event.type === "error") {
            failed = true;

            yield {
              type: "error",
              error: event.error,
              message: makeMessage(sessionId, "error", event.error, "failed")
            };
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown provider error";

        failed = true;

        yield {
          type: "error",
          error: message,
          message: makeMessage(sessionId, "error", message, "failed")
        };
      }

      if (failed) {
        return;
      }

      if (toolCalls.length === 0) {
        const textToolCalls = parseTextToolCalls(assistantText);

        if (textToolCalls.length > 0) {
          assistantText = "";

          for (const textToolCall of textToolCalls) {
            const call = this.textToolCallToRecord(textToolCall);

            toolCalls.push(call);

            yield {
              type: "tool_started",
              call,
              message: makeMessage(sessionId, "tool", `Calling ${call.name}`)
            };
          }
        }
      }

      if (toolCalls.length === 0) {
        const blockingGate = firstIncompleteRuntimeGate(runtimeGates);

        if (blockingGate) {
          yield this.runtimeGateProgressEvent(sessionId, blockingGate);

          if (
            shouldStopStalledNoToolContinuation(
              stalledNoToolContinuations,
              blockingGate.kind,
              blockingGate.nextAction,
              assistantText
            )
          ) {
            const error = [
              `${blockingGate.kind} gate is still incomplete, but the model stopped making useful tool calls.`,
              "The final answer was blocked to prevent unsupported completion.",
              blockingGate.summary,
              "Try a provider with stronger structured tool-calling if this repeats."
            ].join(" ");

            yield {
              type: "error",
              error,
              message: makeMessage(sessionId, "error", error, "failed", {
                visibility: "user",
                timelineKind: "error"
              })
            };

            return;
          }

          providerMessages = this.appendRuntimeContinuation(
            providerMessages,
            blockingGate.continuationMessage,
            input.request.model
          );

          continue;
        }

        const postEditRepair = postEditVerificationTracker.getFinalAnswerRepair(assistantText);

        if (postEditRepair) {
          const count = (postEditRepairCounts.get(postEditRepair.reason) ?? 0) + 1;
          postEditRepairCounts.set(postEditRepair.reason, count);

          if (count > 2) {
            const error = [
              "Post-edit verification gate did not complete.",
              postEditRepair.reason,
              postEditVerificationTracker.summary(),
              "The final answer was blocked to avoid claiming an unverified edit succeeded."
            ].join(" ");

            yield {
              type: "error",
              error,
              message: makeMessage(sessionId, "error", error, "failed", {
                visibility: "user",
                timelineKind: "error"
              })
            };

            return;
          }

          providerMessages = this.appendRuntimeContinuation(
            providerMessages,
            postEditRepair.continuationMessage,
            input.request.model
          );

          continue;
        }

        if (rawStreaming && !gatedMode && assistantText.trim()) {
          yield* this.emitFinalAnswer(assistantText);
          return;
        }

        const finalVerifications = verifyRuntimeGates(runtimeGates);
        const finalAnswerRepair = getGatedFinalAnswerRepair(
          finalVerifications,
          assistantText
        );

        if (finalAnswerRepair) {
          if (shouldStopFinalAnswerRepair(finalAnswerRepairCounts, finalAnswerRepair)) {
            const error = [
              `${finalAnswerRepair.kind} gate completed, but the model did not produce an acceptable final answer.`,
              finalAnswerRepair.reason,
              "The draft was blocked to avoid presenting a plan or empty response as completed work.",
              "Try a provider with stronger instruction following if this repeats."
            ].join(" ");

            yield {
              type: "error",
              error,
              message: makeMessage(sessionId, "error", error, "failed", {
                visibility: "user",
                timelineKind: "error"
              })
            };

            return;
          }

          providerMessages = this.appendRuntimeContinuation(
            providerMessages,
            finalAnswerRepair.continuationMessage,
            input.request.model
          );

          continue;
        }

        for (const verification of finalVerifications) {
          if (verification.complete) {
            yield this.runtimeGateProgressEvent(sessionId, verification);
          }
        }

        yield* this.emitFinalAnswer(assistantText);
        return;
      }

      stalledNoToolContinuations.clear();

      const toolResults: ToolResultRecord[] = [];
      const toolCallsById = new Map(toolCalls.map(call => [call.id, call]));

      for await (const item of this.executeToolCalls(
        input,
        toolCalls,
        toolCallGuard,
        repeatedReadGuard
      )) {
        if (item.type === "permission_request") {
          yield {
            type: "permission_request",
            call: item.call,
            reason: item.reason
          };

          continue;
        }

        toolResults.push(item.result);
        sessionStateLedger.recordToolResult(
          toolCallsById.get(item.result.toolCallId) ?? null,
          item.result
        );
        updateRuntimeGatesFromToolResult(runtimeGates, item.result);
        postEditVerificationTracker.record(
          toolCallsById.get(item.result.toolCallId) ?? null,
          item.result
        );

        yield {
          type: "tool_completed",
          result: item.result,
          message: makeMessage(
            sessionId,
            "tool",
            item.result.message,
            eventMessageStatus(item.result)
          )
        };
      }

      const gateVerifications = verifyRuntimeGates(runtimeGates);
      const blockingGate =
        gateVerifications.find(verification => !verification.complete) ?? null;

      if (blockingGate) {
        providerMessages = this.appendRuntimeGateContinuation(
          providerMessages,
          assistantText,
          toolCalls,
          toolResults,
          blockingGate,
          input.request.model
        );
      } else if (shouldForceFinalReviewAfterLoopGuidance(gateVerifications, toolResults)) {
        providerMessages = compactProviderMessagesForLoop(
          [
            ...providerMessages,
            buildAssistantToolBridgeMessage(assistantText, toolCalls),
            ...toolResults.map(buildToolMessage),
            buildRuntimeControlMessage(finalReviewAfterLoopGuidanceInstruction())
          ],
          input.request.model
        );
      } else {
        providerMessages = compactProviderMessagesForLoop(
          [
            ...providerMessages,
            buildAssistantToolBridgeMessage(assistantText, toolCalls),
            ...toolResults.map(buildToolMessage)
          ],
          input.request.model
        );
      }

      for (const result of toolResults) {
        if (result.ok) {
          this.memory.add("tool", `${result.toolName}: ${result.message}`);
        }
      }

      for (const verification of gateVerifications) {
        yield this.runtimeGateProgressEvent(sessionId, verification);
        this.memory.add(
          verification.kind,
          runtimeGateProgressMemory(verification)
        );
      }

      if (blockingGate) {
        continue;
      }
    }
  }

  private *emitFinalAnswer(assistantText: string): Iterable<StreamEvent> {
    if (!assistantText.trim()) {
      return;
    }

    yield {
      type: "assistant_delta",
      messageId: "",
      delta: assistantText,
      phase: "final"
    };
  }

  private async *executeToolCalls(
    input: AgentGraphInput,
    toolCalls: ToolCallRecord[],
    toolCallGuard: ConsecutiveToolCallGuard,
    repeatedReadGuard: RepeatedReadToolGuard
  ): AsyncIterable<ToolExecutionStreamItem> {
    const sameTurnFingerprints = new Set<string>();

    for (const originalCall of toolCalls) {
      const call = normalizeToolCall(this.registry, originalCall);
      const fingerprint = toolCallFingerprint(call);

      if (sameTurnFingerprints.has(fingerprint)) {
        yield {
          type: "tool_result",
          result: sameTurnDuplicateToolResult(call)
        };
        continue;
      }

      sameTurnFingerprints.add(fingerprint);

      if (!this.registry.get(call.name)) {
        const unknownResult = this.unknownToolResult(call);
        yield {
          type: "tool_result",
          result: toolCallGuard.recordResult(call, unknownResult)
        };
        continue;
      }

      const readRepeatDecision = repeatedReadGuard.check(call);

      if (!readRepeatDecision.allowed) {
        const repeatedReadData: JsonRecord = {
          input: call.input,
          guard: readRepeatDecision.kind,
          duplicate_read: true,
          content_returned: false,
          previous_result_still_valid: true,
          allowed_next_actions: ["search", "edit", "final"]
        };

        if (readRepeatDecision.path) {
          repeatedReadData.path = readRepeatDecision.path;
        }

        if (readRepeatDecision.kind === "covered_read") {
          repeatedReadData.nextAction =
            "This read was already covered. Reuse previous content, grep/search line numbers, edit directly, or produce the final answer.";
        }

        const softResult = successResult(
          readRepeatDecision.reason ?? "Repeated unchanged read skipped; previous result is still valid.",
          repeatedReadData
        );

        yield {
          type: "tool_result",
          result: {
            toolCallId: call.id,
            toolName: call.name,
            risk: call.risk,
            ...softResult
          }
        };
        continue;
      }

      const repeatDecision = toolCallGuard.check(call);

      if (!repeatDecision.allowed) {
        if (repeatDecision.kind === "idempotent_no_progress") {
          const softResult = successResult(
            repeatDecision.reason ?? "Repeated no-progress tool call skipped; previous result is still valid.",
            {
              input: call.input,
              duplicate_tool_call: true,
              no_progress: true,
              content_returned: false,
              previous_result_still_valid: true,
              allowed_next_actions: ["search_different_pattern", "edit", "verify", "final"],
              nextAction: "This exact search/list/context result was already returned. Use the previous result, change the query/range, edit directly, verify differently, or produce the final answer."
            }
          );

          yield {
            type: "tool_result",
            result: {
              toolCallId: call.id,
              toolName: call.name,
              risk: call.risk,
              ...softResult
            }
          };
          continue;
        }

        if (repeatDecision.kind === "repeated_failure") {
          yield {
            type: "tool_result",
            result: {
              toolCallId: call.id,
              toolName: call.name,
              risk: call.risk,
              ok: false,
              blocked: false,
              message: repeatDecision.reason ?? "Repeated failed tool call skipped; previous failure is still valid.",
              data: {
                input: call.input,
                no_progress: true,
                previous_failure_still_valid: true,
                allowed_next_actions: ["search", "edit_different_input", "verify", "final"],
                nextAction: "Do not retry this failed tool call unchanged. Change the input or strategy, inspect existing evidence, or produce the final answer."
              }
            }
          };
          continue;
        }

        const blockedResult = toBlockedToolResult(
          call,
          repeatDecision.reason ?? "Repeated tool call stopped after multiple unchanged attempts.",
          call.input
        );

        yield {
          type: "tool_result",
          result: toolCallGuard.recordResult(call, blockedResult)
        };
        continue;
      }

      if (toolInputLooksMalformed(call.input)) {
        const malformedResult = toBlockedToolResult(
          call,
          [
            "Malformed tool call rejected.",
            "The tool input contains raw assistant/tool markup instead of clean parameters.",
            "Issue a clean tool call. For source edits, keep code only inside content/replacement fields and avoid embedding tool XML or reasoning text."
          ].join(" "),
          call.input
        );

        yield {
          type: "tool_result",
          result: toolCallGuard.recordResult(call, malformedResult)
        };
        continue;
      }

      const decision = this.permissions.decide(
        call,
        input.request.permissionMode,
        this.toolContext.workspaceDir,
        this.toolContext.agentSettings,
        input.request.command?.name ?? null,
        input.request.sessionId
      );

      const effectiveCall = { ...call, risk: decision.effectiveRisk };

      if (!decision.allowed && decision.requiresApproval) {
        yield {
          type: "permission_request",
          call: effectiveCall,
          reason: decision.reason
        };

        const approval = await this.approvals.waitForApproval(effectiveCall.id);

        if (!approval.approved) {
          const deniedResult = toBlockedToolResult(
            effectiveCall,
            "Tool approval was denied or timed out. Do not retry this same tool call unless the user changes the request or grants approval.",
            effectiveCall.input
          );

          yield {
            type: "tool_result",
            result: toolCallGuard.recordResult(effectiveCall, deniedResult)
          };
          continue;
        }

        this.permissions.rememberSessionGrant(
          input.request.sessionId,
          effectiveCall,
          approval.grantScope
        );
      } else if (!decision.allowed) {
        const blockedResult = toBlockedToolResult(
          effectiveCall,
          decision.reason,
          effectiveCall.input
        );

        yield {
          type: "tool_result",
          result: toolCallGuard.recordResult(effectiveCall, blockedResult)
        };
        continue;
      }

      const rawResult = await this.registry.execute(effectiveCall, this.toolContext);
      repeatedReadGuard.recordResult(rawResult);
      const result = toolCallGuard.recordResult(effectiveCall, rawResult);

      yield {
        type: "tool_result",
        result
      };
    }
  }

  private unknownToolResult(call: ToolCallRecord): ToolResultRecord {
    const availableTools = this.registry.list().map((tool) => tool.name);
    const preview = availableTools.slice(0, 24).join(", ");
    const suffix = availableTools.length > 24
      ? `, and ${availableTools.length - 24} more`
      : "";

    return toBlockedToolResult(
      call,
      [
        `Unknown tool: ${call.name}.`,
        `Available tools include: ${preview}${suffix}.`,
        "Choose one of the available tools exactly as named; do not invent tool names."
      ].join(" "),
      { requestedTool: call.name, availableTools }
    );
  }

  private runtimeGateProgressEvent(
    sessionId: string,
    verification: RuntimeGateVerification
  ): StreamEvent {
    return {
      type: "progress",
      message: makeMessage(
        sessionId,
        "progress",
        verification.progressMessage,
        verification.complete ? "complete" : "streaming",
        verification.metadata
      )
    };
  }

  private appendRuntimeContinuation(
    providerMessages: ProviderMessage[],
    content: string,
    model: ModelOption
  ): ProviderMessage[] {
    return compactProviderMessagesForLoop(
      [...providerMessages, buildRuntimeControlMessage(content)],
      model
    );
  }

  private appendRuntimeGateContinuation(
    providerMessages: ProviderMessage[],
    assistantText: string,
    toolCalls: ToolCallRecord[],
    toolResults: ToolResultRecord[],
    verification: RuntimeGateVerification,
    model: ModelOption
  ): ProviderMessage[] {
    const nextMessages = [
      ...providerMessages,
      buildAssistantToolBridgeMessage(assistantText, toolCalls),
      ...toolResults.map(buildToolMessage)
    ];

    if (!verification.complete) {
      nextMessages.push(
        buildRuntimeControlMessage(verification.continuationMessage)
      );
    }

    return compactProviderMessagesForLoop(nextMessages, model);
  }

  private forwardEventToCallbacks(
    event: StreamEvent,
    callbacks: AgentGraphCallbacks
  ): void {
    if (event.type === "assistant_delta") {
      callbacks.onToken(event.delta);
    } else if (
      event.type === "thinking_delta" ||
      event.type === "reasoning_summary_delta" ||
      event.type === "reasoning_raw_delta"
    ) {
      callbacks.onThinking(event.delta);
    } else if (event.type === "tool_call" || event.type === "tool_started") {
      callbacks.onToolCall(event.call);
    } else if (event.type === "permission_request") {
      callbacks.onPermissionRequest(event.call, event.reason);
    } else if (event.type === "tool_result" || event.type === "tool_completed") {
      callbacks.onToolResult(event.result);
    } else if (event.type === "error") {
      callbacks.onError(event.error);
    }
  }
}
