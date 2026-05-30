import { contextBridge, ipcRenderer } from "electron";
import type { SuperAgentApi } from "@shared/ipc";
import type { LibraryData, ProviderModelsUpdatedEvent, StreamEvent } from "@shared/types";

const nextStreamId = (): string => crypto.randomUUID();

const api: SuperAgentApi = {
  getBootstrapState: () => ipcRenderer.invoke("app:bootstrap"),

  listMessages: (sessionId) => ipcRenderer.invoke("chat:messages", sessionId),

  searchSessions: (query) => ipcRenderer.invoke("chat:search", query),

  renameSession: (sessionId, title) =>
    ipcRenderer.invoke("chat:rename-session", sessionId, title),

  deleteSession: (sessionId) =>
    ipcRenderer.invoke("chat:delete-session", sessionId),

  setSessionPinned: (sessionId, pinned) =>
    ipcRenderer.invoke("chat:set-session-pinned", sessionId, pinned),

  setSessionWorkspaceDirectory: (sessionId, workspaceDirectory) =>
    ipcRenderer.invoke(
      "chat:set-session-workspace-directory",
      sessionId,
      workspaceDirectory
    ),

  submitChat: (request, handlers) => {
    const streamId = nextStreamId();
    const channel = `chat:stream:${streamId}`;

    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: StreamEvent
    ) => handlers.onEvent(payload);

    ipcRenderer.on(channel, listener);

    void ipcRenderer.invoke("chat:submit", streamId, request).catch(
      (error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Chat submission failed";

        handlers.onEvent({
          type: "error",
          message: {
            id: streamId,
            sessionId: request.sessionId ?? "",
            role: "error",
            content: message,
            status: "failed",
            createdAt: new Date().toISOString(),
            metadata: {}
          },
          error: message
        });
      }
    );

    return () => {
      ipcRenderer.removeListener(channel, listener);
      void ipcRenderer.invoke("chat:cancel", streamId);
    };
  },

  regenerate: (sessionId, request, handlers) => {
    const streamId = nextStreamId();
    const channel = `chat:stream:${streamId}`;

    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: StreamEvent
    ) => handlers.onEvent(payload);

    ipcRenderer.on(channel, listener);

    void ipcRenderer
      .invoke("chat:regenerate", streamId, { sessionId, request })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Regenerate failed";

        handlers.onEvent({
          type: "error",
          message: {
            id: streamId,
            sessionId,
            role: "error",
            content: message,
            status: "failed",
            createdAt: new Date().toISOString(),
            metadata: {}
          },
          error: message
        });
      });

    return () => {
      ipcRenderer.removeListener(channel, listener);
      void ipcRenderer.invoke("chat:cancel", streamId);
    };
  },

  getLibrary: () => ipcRenderer.invoke("library:get"),

  addMcpConnector: (request) => ipcRenderer.invoke("mcp:add-connector", request),

  updateSkill: (skill) => ipcRenderer.invoke("library:update-skill", skill),

  validateSkillImport: (skill) => ipcRenderer.invoke("library:validate-skill-import", skill),

  importSkill: (skill) => ipcRenderer.invoke("library:import-skill", skill),

  exportSkill: (skillId) => ipcRenderer.invoke("library:export-skill", skillId),

  deleteSkill: (skillId) => ipcRenderer.invoke("library:delete-skill", skillId),

  createSkillProposal: (request) => ipcRenderer.invoke("library:create-skill-proposal", request),

  createSkillPatchProposal: (request) => ipcRenderer.invoke("library:create-skill-patch-proposal", request),

  listSkillProposals: (skillId) => ipcRenderer.invoke("library:list-skill-proposals", skillId),

  applySkillProposal: (proposalId, acceptedPaths) => ipcRenderer.invoke("library:apply-skill-proposal", { proposalId, acceptedPaths }),

  rejectSkillProposal: (proposalId) => ipcRenderer.invoke("library:reject-skill-proposal", proposalId),

  listSkillSnapshots: (skillId) => ipcRenderer.invoke("library:list-skill-snapshots", skillId),

  restoreSkillSnapshot: (snapshotId) => ipcRenderer.invoke("library:restore-skill-snapshot", snapshotId),

  runSkillEvals: (request) => ipcRenderer.invoke("library:run-skill-evals", request),

  listSkillEvalRuns: (skillId) => ipcRenderer.invoke("library:list-skill-eval-runs", skillId),

  updateSkillLifecycle: (skillId, action) => ipcRenderer.invoke("library:update-skill-lifecycle", { skillId, action }),

  installSkillFromGitHub: (request) => ipcRenderer.invoke("library:install-skill-github", request),

  searchSkillRegistry: (request) => ipcRenderer.invoke("library:search-skill-registry", request),

  installSkillFromRegistry: (request) => ipcRenderer.invoke("library:install-skill-registry", request),

  verifySkill: (skillId) => ipcRenderer.invoke("library:verify-skill", skillId),

  verifyAllSkills: () => ipcRenderer.invoke("library:verify-all-skills"),

  updateAllSkills: () => ipcRenderer.invoke("library:update-all-skills"),

  adaptSkillImport: (request) => ipcRenderer.invoke("library:adapt-skill-import", request),

  getSkillCredentials: (skillId) => ipcRenderer.invoke("library:get-skill-credentials", skillId),

  saveSkillCredentials: (request) => ipcRenderer.invoke("library:save-skill-credentials", request),

  exportSkillAuditLog: (request) => ipcRenderer.invoke("library:export-skill-audit", request ?? {}),

  verifySkillAuditExport: (payload) => ipcRenderer.invoke("library:verify-skill-audit-export", payload),

  getSettings: () => ipcRenderer.invoke("settings:get"),

  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),

  validateProvider: (provider, settings) =>
    ipcRenderer.invoke("settings:validate-provider", provider, settings),

  getProviderHealth: (provider, settings) =>
    ipcRenderer.invoke("provider:health", provider, settings),

  onProviderModelsUpdated: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: ProviderModelsUpdatedEvent
    ) => handler(payload);

    ipcRenderer.on("provider-models:updated", listener);

    return () => {
      ipcRenderer.removeListener("provider-models:updated", listener);
    };
  },

  onLibraryUpdated: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: LibraryData) => {
      handler(payload);
    };

    ipcRenderer.on("library:updated", listener);

    return () => {
      ipcRenderer.removeListener("library:updated", listener);
    };
  },

  selectWorkspaceDirectory: () =>
    ipcRenderer.invoke("workspace:select-directory"),

  setWorkspaceDirectory: (workspaceDirectory) =>
    ipcRenderer.invoke("workspace:set-directory", workspaceDirectory),

  runWorkspaceCommand: (request) => ipcRenderer.invoke("workspace:run", request),

  getWorkspaceLogs: () => ipcRenderer.invoke("workspace:logs"),

  getWorkspaceStatus: () => ipcRenderer.invoke("workspace:status"),

  getWorkspaceSnapshot: () => ipcRenderer.invoke("workspace:snapshot:get"),

  approveToolCall: (toolCallId, approved, grantScope) =>
    ipcRenderer.invoke("permission:approve", toolCallId, approved, grantScope)
};

contextBridge.exposeInMainWorld("superAgent", api);