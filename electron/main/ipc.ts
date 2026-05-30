import { statSync } from "node:fs";
import { resolve } from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { z } from "zod";
import type { AppRuntime } from "@settings/appRuntime";
import type {
  ApprovalGrantScope,
  AgentKind,
  AppSettings,
  ChatSession,
  ChatSubmitRequest,
  McpConnectorInstallRequest,
  PermissionMode,
  ProviderName,
  SkillAuditExport,
  SkillCredentialSaveRequest,
  SkillImportRequest,
  SkillPatchRequest,
  SkillProposalCreateRequest,
  SkillUpdateRequest,
  ThemeMode
} from "@shared/types";
import type { WorkspaceCommandRequest } from "@shared/ipc";

interface RegeneratePayload {
  sessionId: string;
  request: Omit<ChatSubmitRequest, "sessionId" | "prompt">;
}

const providerNameSchema = z.enum([
  "groq",
  "nvidia",
  "ollama",
  "llamaCpp",
  "stub"
] satisfies [ProviderName, ProviderName, ProviderName, ProviderName, ProviderName]);

const permissionModeSchema = z.enum([
  "ask_every_time",
  "allow_safe_tools",
  "manual_approval",
  "full_access",
  "deny_tools"
] satisfies [PermissionMode, PermissionMode, PermissionMode, PermissionMode, PermissionMode]);

const approvalGrantScopeSchema = z.enum([
  "once",
  "session_tool",
  "session_exact_command"
] satisfies [ApprovalGrantScope, ApprovalGrantScope, ApprovalGrantScope]);

const agentKindSchema = z.enum([
  "general",
  "browser",
  "desktop",
  "coding"
] satisfies [AgentKind, AgentKind, AgentKind, AgentKind]);

const modelOptionSchema = z.object({
  provider: providerNameSchema,
  model: z.string().min(1).max(400),
  label: z.string().min(1).max(400),
  supportsThinking: z.boolean(),
  contextWindow: z.number().finite().positive().optional(),
  maxOutputTokens: z.number().finite().positive().optional()
}).strict();

const attachmentSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
  size: z.number().finite().nonnegative(),
  textPreview: z.string().max(120000).optional()
}).strict();

const commandInvocationSchema = z.object({
  name: z.enum(["goal", "review"]),
  raw: z.string().min(1).max(20000),
  input: z.string().max(20000),
  goal: z.string().max(20000),
  reviewTarget: z.string().max(20000).optional()
}).strict();

const chatSubmitRequestSchema = z.object({
  sessionId: z.string().min(1).max(200).nullable(),
  prompt: z.string().min(1).max(200000),
  model: modelOptionSchema,
  permissionMode: permissionModeSchema,
  agentKind: agentKindSchema.optional(),
  attachments: z.array(attachmentSchema).max(20),
  command: commandInvocationSchema.nullable().optional(),
  selectedSkillIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  responseStreamingEnabled: z.boolean().optional()
}).strict();

const regenerateRequestSchema = chatSubmitRequestSchema
  .omit({ sessionId: true, prompt: true })
  .strict();

const mcpConnectorInstallSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(2000),
  bearerToken: z.string().max(20000).optional(),
  autoStart: z.boolean().optional()
}).strict() satisfies z.ZodType<McpConnectorInstallRequest>;

const skillFileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(1000000),
  encoding: z.enum(["base64"]).optional()
}).strict();

const skillUpdateSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  instructions: z.string().min(1).max(120000),
  enabled: z.boolean(),
  autoRouting: z.boolean().optional(),
  files: z.array(skillFileSchema).max(80).optional(),
  version: z.string().max(100).nullable().optional()
}).strict();



const skillProposalCreateSchema = z.object({
  skillId: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(300),
  reason: z.string().min(1).max(2000),
  source: z.enum(["agent", "user", "tool"]).optional(),
  operation: z.enum(["create", "update", "delete"]).optional(),
  files: z.array(skillFileSchema).min(1).max(80)
}).strict();

const skillPatchOperationSchema = z.object({
  op: z.enum(["create", "update", "delete", "rename"]),
  path: z.string().min(1).max(500),
  content: z.string().max(500000).optional(),
  toPath: z.string().min(1).max(500).optional()
}).strict();

const skillPatchSchema = z.object({
  skillId: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  reason: z.string().min(1).max(2000),
  operations: z.array(skillPatchOperationSchema).min(1).max(80),
  source: z.enum(["agent", "user", "tool"]).optional()
}).strict();

const skillImportSchema = z.object({
  filename: z.string().min(1).max(500),
  dataBase64: z.string().min(1).max(40000000),
  installMode: z.enum(["replace", "copy"]).optional()
}).strict();


const skillEvalOutputSchema = z.object({
  id: z.string().min(1).max(200),
  output: z.string().max(200000)
}).strict();

const skillEvalRunSchema = z.object({
  skillId: z.string().min(1).max(200),
  outputs: z.array(skillEvalOutputSchema).max(100).optional(),
  baselineRunId: z.string().min(1).max(200).optional()
}).strict();

const skillLifecycleSchema = z.object({
  skillId: z.string().min(1).max(200),
  action: z.enum(["pin", "unpin", "archive", "restore"])
}).strict();

const skillGitHubInstallSchema = z.object({
  url: z.string().url().max(2000),
  installMode: z.enum(["replace", "copy"]).optional(),
  skillPath: z.string().min(1).max(500).optional()
}).strict();

const skillRegistrySearchSchema = z.object({
  registryUrl: z.string().url().max(2000),
  query: z.string().max(200).optional()
}).strict();

const skillRegistryInstallSchema = z.object({
  registryUrl: z.string().url().max(2000),
  entryId: z.string().min(1).max(300),
  installMode: z.enum(["replace", "copy"]).optional()
}).strict();

const skillAdapterFileSchema = z.object({
  path: z.string().min(1).max(800),
  content: z.string().max(1000000),
  encoding: z.enum(["base64"]).optional()
}).strict();

const skillImportAdapterSchema = z.object({
  layout: z.enum(["claude", "codex", "openclaw", "hermes", "auto"]),
  files: z.array(skillAdapterFileSchema).min(1).max(1000)
}).strict();

const skillCredentialSaveSchema = z.object({
  skillId: z.string().min(1).max(200),
  env: z.record(z.string().min(1).max(200), z.string().max(20000)).optional(),
  files: z.record(z.string().min(1).max(500), z.string().max(2000)).optional()
}).strict() satisfies z.ZodType<SkillCredentialSaveRequest>;

const auditExportRequestSchema = z.object({
  skillId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(1000).optional()
}).strict();

const auditExportPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  scope: z.object({ skillId: z.string().optional(), limit: z.number().int().min(1).max(1000) }).strict(),
  events: z.array(z.unknown()).max(2000),
  firstHash: z.string().nullable(),
  lastHash: z.string().nullable(),
  exportHash: z.string()
}).passthrough() as z.ZodType<SkillAuditExport>;

const regeneratePayloadSchema = z.object({
  sessionId: z.string().min(1).max(200),
  request: regenerateRequestSchema
}).strict();


type RuntimeWithSessionWorkspace = AppRuntime & {
  setSessionWorkspaceDirectory?: (
    sessionId: string,
    workspaceDirectory: string | null
  ) => ChatSession;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (
  record: Record<string, unknown>,
  key: string,
  fallback: string
): string => {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
};

const readBoolean = (
  record: Record<string, unknown>,
  key: string,
  fallback: boolean
): boolean => {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
};

const parseTheme = (value: unknown, fallback: ThemeMode): ThemeMode => {
  if (value === "light" || value === "dark" || value === "system") return value;
  return fallback;
};

const parseProvider = (
  value: unknown,
  fallback: ProviderName
): ProviderName => {
  if (
    value === "groq" ||
    value === "nvidia" ||
    value === "ollama" ||
    value === "llamaCpp" ||
    value === "stub"
  ) {
    return value;
  }

  return fallback;
};

const parseSettings = (
  value: unknown,
  fallback: AppSettings
): AppSettings => {
  if (!isRecord(value)) return fallback;

  return {
    theme: parseTheme(value.theme, fallback.theme),
    defaultProvider: parseProvider(
      value.defaultProvider,
      fallback.defaultProvider
    ),
    defaultModel: readString(value, "defaultModel", fallback.defaultModel),
    groqApiKey: readString(value, "groqApiKey", fallback.groqApiKey),
    groqBaseUrl: readString(value, "groqBaseUrl", fallback.groqBaseUrl),
    nvidiaApiKey: readString(value, "nvidiaApiKey", fallback.nvidiaApiKey),
    nvidiaBaseUrl: readString(value, "nvidiaBaseUrl", fallback.nvidiaBaseUrl),
    ollamaBaseUrl: readString(value, "ollamaBaseUrl", fallback.ollamaBaseUrl),
    llamaCppBaseUrl: readString(
      value,
      "llamaCppBaseUrl",
      fallback.llamaCppBaseUrl
    ),
    agentOutsideWorkspaceAccess: readBoolean(
      value,
      "agentOutsideWorkspaceAccess",
      fallback.agentOutsideWorkspaceAccess
    ),
    agentPrivateNetworkAccess: readBoolean(
      value,
      "agentPrivateNetworkAccess",
      fallback.agentPrivateNetworkAccess
    ),
    agentShellSandboxEnabled: readBoolean(
      value,
      "agentShellSandboxEnabled",
      fallback.agentShellSandboxEnabled
    ),
    agentStreamingEnabled: readBoolean(
      value,
      "agentStreamingEnabled",
      fallback.agentStreamingEnabled
    )
  };
};

const assertNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
};

const parseNullableString = (
  value: unknown,
  label: string
): string | null => {
  if (value === null || value === undefined) return null;
  return assertNonEmptyString(value, label);
};

const parseChatSubmitRequest = (value: unknown): ChatSubmitRequest =>
  chatSubmitRequestSchema.parse(value) as ChatSubmitRequest;

const parseRegeneratePayload = (value: unknown): RegeneratePayload =>
  regeneratePayloadSchema.parse(value) as RegeneratePayload;

const parseSkillUpdate = (value: unknown): SkillUpdateRequest =>
  skillUpdateSchema.parse(value);

const parseSkillImport = (value: unknown): SkillImportRequest =>
  skillImportSchema.parse(value);

const parseSkillProposalCreate = (value: unknown): SkillProposalCreateRequest =>
  skillProposalCreateSchema.parse(value);

const parseSkillPatch = (value: unknown): SkillPatchRequest =>
  skillPatchSchema.parse(value);

const isMissingPathError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const parseExistingWorkspaceDirectory = (value: unknown): string => {
  const directory = resolve(assertNonEmptyString(value, "Workspace directory"));

  try {
    const stat = statSync(directory);

    if (!stat.isDirectory()) {
      throw new Error("Workspace directory must be an existing directory.");
    }
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new Error(`Workspace directory no longer exists: ${directory}`, {
        cause: error
      });
    }

    throw error;
  }

  return directory;
};

const parseWorkspaceCommandRequest = (
  value: unknown
): WorkspaceCommandRequest => {
  if (!isRecord(value)) throw new Error("Workspace command must be an object.");

  const command = value.command;
  if (
    command !== "navigate" &&
    command !== "click" &&
    command !== "type" &&
    command !== "snapshot" &&
    command !== "status"
  ) {
    throw new Error("Workspace command is not supported.");
  }

  const permissionMode = value.permissionMode;
  if (
    permissionMode !== "ask_every_time" &&
    permissionMode !== "allow_safe_tools" &&
    permissionMode !== "manual_approval" &&
    permissionMode !== "full_access" &&
    permissionMode !== "deny_tools"
  ) {
    throw new Error("Workspace command permission mode is invalid.");
  }

  return {
    command,
    input: isRecord(value.input) ? value.input : {},
    permissionMode
  };
};

const setSessionWorkspaceDirectory = (
  runtime: AppRuntime,
  sessionId: string,
  workspaceDirectory: string | null
): ChatSession => {
  const method = (runtime as RuntimeWithSessionWorkspace)
    .setSessionWorkspaceDirectory;

  if (!method) {
    throw new Error(
      "AppRuntime.setSessionWorkspaceDirectory is not implemented."
    );
  }

  return method.call(runtime, sessionId, workspaceDirectory);
};

export const registerIpcHandlers = (runtime: AppRuntime): void => {
  ipcMain.handle("app:bootstrap", () => runtime.getBootstrapState());

  ipcMain.handle("chat:messages", (_event, sessionId: unknown) =>
    runtime.listMessages(assertNonEmptyString(sessionId, "Session ID"))
  );

  ipcMain.handle("chat:search", (_event, query: unknown) =>
    runtime.searchSessions(typeof query === "string" ? query.slice(0, 200) : "")
  );

  ipcMain.handle(
    "chat:rename-session",
    (_event, sessionId: unknown, title: unknown) =>
      runtime.renameSession(
        assertNonEmptyString(sessionId, "Session ID"),
        assertNonEmptyString(title, "Session title").slice(0, 120)
      )
  );

  ipcMain.handle("chat:delete-session", (_event, sessionId: unknown) =>
    runtime.deleteSession(assertNonEmptyString(sessionId, "Session ID"))
  );

  ipcMain.handle(
    "chat:set-session-pinned",
    (_event, sessionId: unknown, pinned: unknown) =>
      runtime.setSessionPinned(
        assertNonEmptyString(sessionId, "Session ID"),
        pinned === true
      )
  );

  ipcMain.handle(
    "chat:set-session-workspace-directory",
    (_event, sessionId: unknown, workspaceDirectory: unknown) =>
      setSessionWorkspaceDirectory(
        runtime,
        assertNonEmptyString(sessionId, "Session ID"),
        parseNullableString(workspaceDirectory, "Workspace directory")
      )
  );

  ipcMain.handle(
    "chat:submit",
    (event, streamId: unknown, request: unknown) => {
      runtime.submitChat(
        assertNonEmptyString(streamId, "Stream ID"),
        event.sender,
        parseChatSubmitRequest(request)
      );
      return { ok: true };
    }
  );

  ipcMain.handle(
    "chat:regenerate",
    (event, streamId: unknown, rawPayload: unknown) => {
      const payload = parseRegeneratePayload(rawPayload);
      runtime.regenerate(
        assertNonEmptyString(streamId, "Stream ID"),
        event.sender,
        payload.sessionId,
        payload.request
      );
      return { ok: true };
    }
  );

  ipcMain.handle("chat:cancel", (event, streamId: unknown) => {
    runtime.cancel(assertNonEmptyString(streamId, "Stream ID"), event.sender);
    return { ok: true };
  });

  ipcMain.handle("library:get", () => runtime.getLibrary());

  ipcMain.handle("mcp:add-connector", (_event, rawRequest: unknown) =>
    runtime.addMcpConnector(mcpConnectorInstallSchema.parse(rawRequest))
  );

  ipcMain.handle("library:update-skill", (_event, rawSkill: unknown) =>
    runtime.updateSkill(parseSkillUpdate(rawSkill))
  );

  ipcMain.handle("library:validate-skill-import", (_event, rawSkill: unknown) =>
    runtime.previewSkillImport(parseSkillImport(rawSkill))
  );

  ipcMain.handle("library:import-skill", (_event, rawSkill: unknown) =>
    runtime.importSkill(parseSkillImport(rawSkill))
  );

  ipcMain.handle("library:export-skill", (_event, rawSkillId: unknown) =>
    runtime.exportSkill(assertNonEmptyString(rawSkillId, "Skill ID"))
  );

  ipcMain.handle("library:delete-skill", (_event, rawSkillId: unknown) => {
    runtime.deleteSkill(assertNonEmptyString(rawSkillId, "Skill ID"));
  });

  ipcMain.handle("library:create-skill-proposal", (_event, rawRequest: unknown) =>
    runtime.createSkillProposal(parseSkillProposalCreate(rawRequest))
  );

  ipcMain.handle("library:create-skill-patch-proposal", (_event, rawRequest: unknown) =>
    runtime.createSkillPatchProposal(parseSkillPatch(rawRequest))
  );

  ipcMain.handle("library:list-skill-proposals", (_event, rawSkillId: unknown) =>
    runtime.listSkillProposals(typeof rawSkillId === "string" && rawSkillId.trim() ? rawSkillId : undefined)
  );

  ipcMain.handle("library:apply-skill-proposal", (_event, rawRequest: unknown) => {
    if (typeof rawRequest === "string") {
      return runtime.applySkillProposal(assertNonEmptyString(rawRequest, "Proposal ID"));
    }
    const request = z.object({
      proposalId: z.string().trim().min(1),
      acceptedPaths: z.array(z.string().trim().min(1)).optional()
    }).parse(rawRequest);
    return runtime.applySkillProposal(request.proposalId, request.acceptedPaths);
  });

  ipcMain.handle("library:reject-skill-proposal", (_event, rawProposalId: unknown) =>
    runtime.rejectSkillProposal(assertNonEmptyString(rawProposalId, "Proposal ID"))
  );

  ipcMain.handle("library:list-skill-snapshots", (_event, rawSkillId: unknown) =>
    runtime.listSkillSnapshots(assertNonEmptyString(rawSkillId, "Skill ID"))
  );

  ipcMain.handle("library:restore-skill-snapshot", (_event, rawSnapshotId: unknown) =>
    runtime.restoreSkillSnapshot(assertNonEmptyString(rawSnapshotId, "Snapshot ID"))
  );

  ipcMain.handle("library:run-skill-evals", (_event, rawRequest: unknown) =>
    runtime.runSkillEvals(skillEvalRunSchema.parse(rawRequest))
  );

  ipcMain.handle("library:list-skill-eval-runs", (_event, rawSkillId: unknown) =>
    runtime.listSkillEvalRuns(assertNonEmptyString(rawSkillId, "Skill ID"))
  );

  ipcMain.handle("library:update-skill-lifecycle", (_event, rawRequest: unknown) => {
    const request = skillLifecycleSchema.parse(rawRequest);
    return runtime.updateSkillLifecycle(request.skillId, request.action);
  });

  ipcMain.handle("library:install-skill-github", (_event, rawRequest: unknown) =>
    runtime.installSkillFromGitHub(skillGitHubInstallSchema.parse(rawRequest))
  );

  ipcMain.handle("library:search-skill-registry", (_event, rawRequest: unknown) =>
    runtime.searchSkillRegistry(skillRegistrySearchSchema.parse(rawRequest))
  );

  ipcMain.handle("library:install-skill-registry", (_event, rawRequest: unknown) =>
    runtime.installSkillFromRegistry(skillRegistryInstallSchema.parse(rawRequest))
  );

  ipcMain.handle("library:verify-skill", (_event, rawSkillId: unknown) =>
    runtime.verifySkill(assertNonEmptyString(rawSkillId, "Skill ID"))
  );

  ipcMain.handle("library:verify-all-skills", () => runtime.verifyAllSkills());

  ipcMain.handle("library:update-all-skills", () => runtime.updateAllSkills());

  ipcMain.handle("library:adapt-skill-import", (_event, rawRequest: unknown) =>
    runtime.adaptSkillImport(skillImportAdapterSchema.parse(rawRequest))
  );

  ipcMain.handle("library:get-skill-credentials", (_event, rawSkillId: unknown) =>
    runtime.getSkillCredentials(assertNonEmptyString(rawSkillId, "Skill ID"))
  );

  ipcMain.handle("library:save-skill-credentials", (_event, rawRequest: unknown) =>
    runtime.saveSkillCredentials(skillCredentialSaveSchema.parse(rawRequest))
  );

  ipcMain.handle("library:export-skill-audit", (_event, rawRequest: unknown) => {
    const request = auditExportRequestSchema.parse(rawRequest ?? {});
    return runtime.exportSkillAuditLog(request.skillId, request.limit);
  });

  ipcMain.handle("library:verify-skill-audit-export", (_event, rawPayload: unknown) =>
    runtime.verifySkillAuditExport(auditExportPayloadSchema.parse(rawPayload))
  );

  ipcMain.handle("settings:get", () => runtime.getSettings());

  ipcMain.handle("settings:save", (_event, rawSettings: unknown) => {
    const settings = parseSettings(rawSettings, runtime.getSettings());
    return runtime.saveSettings(settings);
  });

  ipcMain.handle(
    "settings:validate-provider",
    (_event, rawProvider: unknown, rawSettings: unknown) => {
      const currentSettings = runtime.getSettings();
      const provider = parseProvider(
        rawProvider,
        currentSettings.defaultProvider
      );
      const settings = parseSettings(rawSettings, currentSettings);
      return runtime.validateProvider(provider, settings);
    }
  );

  ipcMain.handle(
    "provider:health",
    (_event, rawProvider: unknown, rawSettings: unknown) => {
      const currentSettings = runtime.getSettings();
      const provider = parseProvider(
        rawProvider,
        currentSettings.defaultProvider
      );
      const settings = parseSettings(rawSettings, currentSettings);
      return runtime.getProviderHealth(provider, settings);
    }
  );

  ipcMain.handle("workspace:select-directory", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select project directory",
      defaultPath: runtime.getWorkspaceDirectory(),
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const directory = result.filePaths[0];
    await runtime.setWorkspaceDirectory(directory);
    return directory;
  });

  ipcMain.handle("workspace:set-directory", async (_event, workspaceDirectory: unknown) => {
    const directory = parseExistingWorkspaceDirectory(workspaceDirectory);

    await runtime.setWorkspaceDirectory(directory);
    return directory;
  });

  ipcMain.handle("workspace:run", async (event, rawRequest: unknown) =>
    runtime.runWorkspaceCommand(
      parseWorkspaceCommandRequest(rawRequest),
      async (call, reason) => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        const options = {
          type: "warning" as const,
          buttons: ["Deny", "Allow"],
          defaultId: 0,
          cancelId: 0,
          title: "Approve workspace action",
          message: `Allow ${call.name}?`,
          detail: reason
        };
        const result = owner
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options);

        return { approved: result.response === 1, grantScope: "once" };
      }
    )
  );

  ipcMain.handle("workspace:logs", () => runtime.getWorkspaceLogs());

  ipcMain.handle("workspace:status", () => {
    const status = runtime.getWorkspaceStatus();

    return {
      ...status,
      workspaceDirectory: runtime.getWorkspaceDirectory()
    };
  });

  ipcMain.handle("workspace:snapshot:get", () =>
    runtime.getWorkspaceSnapshot()
  );

  ipcMain.handle(
    "permission:approve",
    (
      event,
      toolCallId: unknown,
      approved: unknown,
      grantScope: unknown
    ) => {
      const normalizedGrantScope = approvalGrantScopeSchema.catch("once").parse(
        grantScope
      );

      return {
        approved: runtime.approveToolCallFromSender(
          assertNonEmptyString(toolCallId, "Tool call ID"),
          approved === true,
          event.sender,
          normalizedGrantScope
        ),
        grantScope: normalizedGrantScope
      };
    }
  );
};
