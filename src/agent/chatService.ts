import type { JsonRecord } from "@shared/json";
import type {
  AttachmentMetadata,
  ChatMessage,
  ChatSession,
  ChatSubmitRequest,
} from "@shared/types";
import { parseAgentCommandInput } from "../commands";
import { routeAgentKind } from "./intentRouter";
import {
  createTitleFromPrompt,
  type ChatRepository
} from "@persistence/chatRepository";
import type { SkillRegistry } from "@skills-system/skillRegistry";
import type { AgentGraphRunner } from "./agentGraph";
import {
  ChatTurnStreamer,
  type StreamEmitter
} from "@interface/streaming/chatTurnStreamer";

const defaultAbortSignal = (): AbortSignal => new AbortController().signal;

const attachmentFromRecord = (
  value: Record<string, unknown>
): AttachmentMetadata | null => {
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.size !== "number"
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
    ...(typeof value.textPreview === "string"
      ? { textPreview: value.textPreview }
      : {}),
  };
};

const messageAttachments = (message: ChatMessage): AttachmentMetadata[] => {
  if (message.attachments?.length) return message.attachments;

  const metadataAttachments = message.metadata.attachments;
  if (!Array.isArray(metadataAttachments)) return [];

  return metadataAttachments.flatMap((attachment): AttachmentMetadata[] => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      return [];
    }

    const parsed = attachmentFromRecord(attachment);
    return parsed ? [parsed] : [];
  });
};

const messageInput = (
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
  options: {
    status?: ChatMessage["status"];
  } = {}
) => ({
  sessionId,
  role,
  content,
  status: options.status ?? "complete",
  createdAt: new Date().toISOString(),
  metadata: {}
});

export class ChatService {
  private readonly turnStreamer: ChatTurnStreamer;

  constructor(
    private readonly chats: ChatRepository,
    private readonly skills: SkillRegistry,
    graph: AgentGraphRunner
  ) {
    this.turnStreamer = new ChatTurnStreamer(
      chats,
      graph,
      (request) => this.enabledSkillInstructions(request)
    );
  }

  async submit(
    request: ChatSubmitRequest,
    emit: StreamEmitter,
    signal: AbortSignal = defaultAbortSignal()
  ): Promise<string> {
    const session = await this.ensureSession(request, emit);

    const skillContext = this.skills.buildContext({
      prompt: request.prompt,
      ...(request.selectedSkillIds
        ? { selectedSkillIds: request.selectedSkillIds }
        : {}),
      ...(request.model.contextWindow
        ? { contextWindow: request.model.contextWindow }
        : {}),
      ...(request.agentKind ? { agentId: request.agentKind } : {})
    });

    const userMessage = this.chats.addMessage({
      ...messageInput(session.id, "user", request.prompt),
      metadata: {
        ...(request.command
          ? { command: request.command.name, rawCommand: request.command.raw }
          : {}),
        ...(request.selectedSkillIds?.length
          ? { selectedSkillIds: request.selectedSkillIds }
          : {}),
        ...(skillContext.references.length
          ? {
              skillContext: {
                budgetTokens: skillContext.budgetTokens,
                usedTokens: skillContext.usedTokens,
                warnings: skillContext.warnings.map((warning): JsonRecord => ({
                  severity: warning.severity,
                  code: warning.code,
                  message: warning.message,
                  ...(warning.skillId ? { skillId: warning.skillId } : {}),
                  ...(warning.path ? { path: warning.path } : {})
                })),
                heatmap: skillContext.heatmap.map((item): JsonRecord => ({
                  skillId: item.skillId,
                  skillName: item.skillName,
                  mode: item.mode,
                  path: item.path,
                  type: item.type,
                  tokenEstimate: item.tokenEstimate,
                  size: item.size,
                  injected: item.injected
                })),
                snapshots: skillContext.snapshots.map((snapshot): JsonRecord => ({
                  id: snapshot.id,
                  name: snapshot.name,
                  source: snapshot.source,
                  trustLevel: snapshot.trustLevel,
                  version: snapshot.version,
                  packageHash: snapshot.packageHash,
                  injection: snapshot.injection,
                  injectedFiles: snapshot.injectedFiles,
                  contextTokens: snapshot.contextTokens,
                  score: snapshot.score,
                  matchedTerms: snapshot.matchedTerms
                })),
                references: skillContext.references.map((reference): JsonRecord => ({
                  id: reference.id,
                  name: reference.name,
                  description: reference.description,
                  mode: reference.mode,
                  tokenEstimate: reference.tokenEstimate,
                  score: reference.score,
                  matchedTerms: reference.matchedTerms,
                  injection: reference.injection,
                  reason: reference.reason,
                  packageHash: reference.packageHash,
                  injectedFiles: reference.injectedFiles,
                  warnings: (reference.warnings ?? []).map((warning): JsonRecord => ({
                    severity: warning.severity,
                    code: warning.code,
                    message: warning.message,
                    ...(warning.skillId ? { skillId: warning.skillId } : {}),
                    ...(warning.path ? { path: warning.path } : {})
                  }))
                }))
              }
            }
          : {})
      },
      attachments: request.attachments
    });

    this.skills.markUsed(skillContext.references.map((reference) => reference.id));

    await emit({ type: "message_created", message: userMessage });

    await this.runAssistantTurn(
      {
        ...request,
        sessionId: session.id
      },
      emit,
      signal
    );

    return session.id;
  }

  async regenerate(
    sessionId: string,
    request: Omit<ChatSubmitRequest, "sessionId" | "prompt">,
    emit: StreamEmitter,
    signal: AbortSignal = defaultAbortSignal()
  ): Promise<void> {
    const lastUserMessage = this.findLastUserMessage(sessionId);

    if (!lastUserMessage) {
      const errorMessage = this.chats.addMessage(
        messageInput(
          sessionId,
          "error",
          "Cannot regenerate because this chat has no user message.",
          { status: "failed" }
        )
      );

      await emit({
        type: "error",
        message: errorMessage,
        error: errorMessage.content
      });

      return;
    }

    const rawCommand =
      typeof lastUserMessage.metadata.rawCommand === "string"
        ? lastUserMessage.metadata.rawCommand
        : "";
    const parsedCommand = rawCommand ? parseAgentCommandInput(rawCommand) : null;
    const command = request.command ?? parsedCommand?.command ?? null;
    const prompt = command
      ? parsedCommand?.prompt.trim() || lastUserMessage.content
      : lastUserMessage.content;
    const previousSkillIds = Array.isArray(lastUserMessage.metadata.selectedSkillIds)
      ? lastUserMessage.metadata.selectedSkillIds.filter(
          (id): id is string => typeof id === "string"
        )
      : [];

    this.chats.deleteAssistantMessagesAfterLastUser(sessionId);

    await this.runAssistantTurn(
      {
        ...request,
        sessionId,
        prompt,
        attachments: messageAttachments(lastUserMessage),
        command,
        selectedSkillIds: request.selectedSkillIds ?? previousSkillIds
      },
      emit,
      signal
    );
  }

  private async ensureSession(
    request: ChatSubmitRequest,
    emit: StreamEmitter
  ): Promise<ChatSession> {
    if (request.sessionId) {
      const existing = this.chats.getSession(request.sessionId);

      if (existing) {
        return existing;
      }
    }

    const session = this.chats.createSession(
      createTitleFromPrompt(request.prompt)
    );

    await emit({ type: "session_created", session });
    return session;
  }

  private async runAssistantTurn(
    request: ChatSubmitRequest,
    emit: StreamEmitter,
    signal: AbortSignal
  ): Promise<void> {
    await this.turnStreamer.run(
      { ...request, agentKind: routeAgentKind(request) },
      emit,
      signal
    );
  }

  private findLastUserMessage(sessionId: string): ChatMessage | null {
    const messages = this.chats.listMessages(sessionId);

    return (
      [...messages].reverse().find((message) => message.role === "user") ?? null
    );
  }

  private enabledSkillInstructions(request: ChatSubmitRequest): string[] {
    return this.skills.buildContext({
      prompt: request.prompt,
      ...(request.selectedSkillIds
        ? { selectedSkillIds: request.selectedSkillIds }
        : {}),
      ...(request.model.contextWindow
        ? { contextWindow: request.model.contextWindow }
        : {}),
      ...(request.agentKind ? { agentId: request.agentKind } : {})
    }).promptFragments;
  }
}