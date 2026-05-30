import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalGrantScope,
  AppSettings,
  AttachmentMetadata,
  ChatSession,
  ChatMessage,
  McpConnectorInstallRequest,
  McpConnectorInstallResult,
  ModelOption,
  PermissionMode,
  ProviderModelsUpdatedEvent,
  ProviderHealthResult,
  ProviderName,
  ProviderValidationResult,
  SkillExportResult,
  SkillGitHubInstallRequest,
  SkillImportRequest,
  SkillImportValidationResult,
  SkillAuditExport,
  SkillAuditExportVerification,
  SkillCredentialReport,
  SkillCredentialSaveRequest,
  SkillEvalRunRecord,
  SkillPatchRequest,
  SkillProposalCreateRequest,
  SkillProposalRecord,
  SkillRecord,
  SkillRollbackSnapshot,
  SkillUpdateAllResult,
  SkillUpdateRequest,
  SkillVerificationResult,
  StreamEvent,
  ToolCallRecord,
  ToolResultRecord,
  WorkspaceActionLog,
  WorkspaceSnapshot,
  WorkspaceStatus,
} from "@shared/types";
import type { WorkspaceCommandRequest } from "@shared/ipc";
import { parseAgentCommandInput } from "../../commands";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { ChatArea } from "./components/ChatArea";
import { LibraryPanel } from "./components/LibraryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { WorkspacePanel } from "./components/WorkspacePanel";
import {
  applyStreamEvent,
  removeAfterLastUser,
  upsertSession,
} from "./state/events";
import { SKILL_CREATOR_BOOTSTRAP_PROMPT } from "./prompts/skillCreatorBootstrapPrompt";
import {
  defaultModelFromSettings,
  directoryLabel,
  findModel,
  initialBootstrap,
  initialSettings,
  isWorkspaceTool,
  modelsForProvider,
  readAttachment,
  removeSkillRecord,
  replaceModelsForProvider,
  sortSessions,
  upsertSkillRecord,
} from "./app/appData";

interface PendingApproval {
  call: ToolCallRecord;
  reason: string;
}

export function App() {
  const [boot, setBoot] = useState(initialBootstrap);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("allow_safe_tools");
  const [attachments, setAttachments] = useState<AttachmentMetadata[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaceStatus, setWorkspaceStatus] =
    useState<WorkspaceStatus>("idle");
  const [workspaceUrl, setWorkspaceUrl] = useState("about:blank");
  const [workspaceLogs, setWorkspaceLogs] = useState<WorkspaceActionLog[]>([]);
  const [workspaceSnapshot, setWorkspaceSnapshot] =
    useState<WorkspaceSnapshot | null>(null);
  const [workspaceDirectory, setWorkspaceDirectory] = useState<string | null>(
    null,
  );
  const [providerHealth, setProviderHealth] =
    useState<ProviderHealthResult | null>(null);
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);

  const cancelRef = useRef<null | (() => void)>(null);
  const providerHealthRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);

  const appendLocalWorkspaceLog = useCallback(
    (action: string, message: string, error?: unknown) => {
      const detail = {
        message,
        ...(error ? { error: error instanceof Error ? error.message : "Unknown error" } : {}),
      };

      setWorkspaceLogs((current) => [
        {
          id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          action,
          status: "failed",
          detail,
          createdAt: new Date().toISOString(),
        },
        ...current,
      ]);
      setWorkspaceOpen(true);
    },
    [],
  );

  const rememberSkill = useCallback((saved: SkillRecord) => {
    setBoot((state) => ({
      ...state,
      library: {
        ...state.library,
        skills: {
          ...state.library.skills,
          items: upsertSkillRecord(state.library.skills.items, saved),
        },
      },
    }));
  }, []);

  const applyProviderModelsUpdate = useCallback((event: ProviderModelsUpdatedEvent) => {
    setBoot((current) => {
      const models = replaceModelsForProvider(
        current.models,
        event.provider,
        event.models,
      );

      return {
        ...current,
        models,
        library: {
          ...current.library,
          models: {
            ...current.library.models,
            items: models,
          },
        },
      };
    });
  }, []);

  const chatModels = useMemo(
    () => modelsForProvider(boot.models, settings.defaultProvider),
    [boot.models, settings.defaultProvider],
  );

  useEffect(() => {
    void window.superAgent.getBootstrapState().then((state) => {
      setBoot({ ...state, sessions: sortSessions(state.sessions) });
      setSettings(state.settings);
      setSelectedModel(defaultModelFromSettings(state.models, state.settings));
      setWorkspaceStatus(state.workspaceStatus);
      setWorkspaceUrl(state.workspaceUrl);
      setWorkspaceDirectory(state.workspaceDirectory);
      setWorkspaceLogs(state.workspaceLogs);
      setWorkspaceSnapshot(state.workspaceSnapshot);
    });
  }, []);

  useEffect(
    () => window.superAgent.onProviderModelsUpdated(applyProviderModelsUpdate),
    [applyProviderModelsUpdate],
  );

  useEffect(
    () => window.superAgent.onLibraryUpdated((library) => {
      setBoot((current) => ({ ...current, library }));
    }),
    [],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    let cancelled = false;
    const provider = selectedModel?.provider ?? settings.defaultProvider;

    const refreshProviderHealth = async () => {
      const requestId = ++providerHealthRequestRef.current;

      try {
        const health = await window.superAgent.getProviderHealth(
          provider,
          settings,
        );

        if (!cancelled && providerHealthRequestRef.current === requestId) {
          setProviderHealth(health);
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : "Provider health check failed";

        if (!cancelled && providerHealthRequestRef.current === requestId) {
          setProviderHealth({
            provider,
            status: "offline",
            endpoint: "",
            message,
            details: {},
          });
        }
      }
    };

    void refreshProviderHealth();
    const interval = window.setInterval(
      () => void refreshProviderHealth(),
      15000,
    );

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    selectedModel?.provider,
    settings.agentStreamingEnabled,
    settings.defaultModel,
    settings.defaultProvider,
    settings.groqApiKey,
    settings.groqBaseUrl,
    settings.nvidiaApiKey,
    settings.nvidiaBaseUrl,
  ]);

  useEffect(() => {
    const stillValid =
      selectedModel &&
      selectedModel.provider === settings.defaultProvider &&
      chatModels.some(
        (model) =>
          model.provider === selectedModel.provider &&
          model.model === selectedModel.model,
      );

    if (!stillValid) {
      setSelectedModel(defaultModelFromSettings(boot.models, settings));
    }
  }, [boot.models, chatModels, selectedModel, settings]);

  useEffect(() => {
    const requestId = ++searchRequestRef.current;
    const query = searchOpen ? searchQuery : "";
    const delay = searchOpen ? 180 : 0;

    const timeout = window.setTimeout(() => {
      void window.superAgent.searchSessions(query).then((sessions) => {
        if (searchRequestRef.current !== requestId) return;
        setBoot((state) => ({ ...state, sessions: sortSessions(sessions) }));
      });
    }, delay);

    return () => window.clearTimeout(timeout);
  }, [searchOpen, searchQuery]);

  const layoutClass = useMemo(() => {
    const classNames = ["app-shell"];
    if (workspaceOpen) classNames.push("workspace-open");
    if (sidebarCollapsed) classNames.push("sidebar-collapsed");
    return classNames.join(" ");
  }, [sidebarCollapsed, workspaceOpen]);

  const refreshLibrary = async () => {
    const next = await window.superAgent.getLibrary();
    setBoot((state) => ({ ...state, library: next }));
  };

  const refreshWorkspace = async () => {
    const [status, logs, snapshot] = await Promise.all([
      window.superAgent.getWorkspaceStatus(),
      window.superAgent.getWorkspaceLogs(),
      window.superAgent.getWorkspaceSnapshot(),
    ]);

    setWorkspaceStatus(status.status);
    setWorkspaceUrl(status.url);
    setWorkspaceDirectory(status.workspaceDirectory);
    setWorkspaceLogs(logs);
    setWorkspaceSnapshot(snapshot);
  };

  const updateSession = (session: ChatSession) => {
    setBoot((state) => ({
      ...state,
      sessions: sortSessions(
        state.sessions.map((item) => (item.id === session.id ? session : item)),
      ),
    }));
  };

  const persistSessionWorkspaceDirectory = async (
    sessionId: string,
    directory: string | null,
  ) => {
    const session = await window.superAgent.setSessionWorkspaceDirectory(
      sessionId,
      directory,
    );
    updateSession(session);
  };

  const clearUnavailableSessionWorkspace = async (sessionId: string) => {
    try {
      await persistSessionWorkspaceDirectory(sessionId, null);
    } catch (error: unknown) {
      appendLocalWorkspaceLog(
        "session.workspace.clear",
        "Unable to clear the unavailable session workspace.",
        error,
      );
    }
  };

  const handleStreamEvent = (event: StreamEvent) => {
    if (event.type === "session_created") {
      setActiveSessionId(event.session.id);

      const session =
        workspaceDirectory && !event.session.workspaceDirectory
          ? { ...event.session, workspaceDirectory }
          : event.session;

      setBoot((state) => ({
        ...state,
        sessions: sortSessions(upsertSession(state.sessions, session)),
      }));

      if (workspaceDirectory && !event.session.workspaceDirectory) {
        void persistSessionWorkspaceDirectory(
          event.session.id,
          workspaceDirectory,
        );
      }
    }

    if (event.type === "permission_request") {
      setPendingApproval({ call: event.call, reason: event.reason });
    }

    if (
      event.type === "tool_result" &&
      isWorkspaceTool(event.result.toolName)
    ) {
      setWorkspaceOpen(true);
      void refreshWorkspace();
    }

    setMessages((current) => applyStreamEvent(current, event));

    if (event.type === "error") {
      setStreaming(false);
      cancelRef.current = null;
    }

    if (event.type === "done" || event.type === "turn_completed") {
      setStreaming(false);
      cancelRef.current = null;
      void refreshLibrary();
      void refreshWorkspace();
    }
  };

  const submit = () => {
    if (!selectedModel || !prompt.trim()) return;

    const parsedInput = parseAgentCommandInput(prompt);
    const nextPrompt = parsedInput.prompt;

    if (!nextPrompt) {
      return;
    }

    setLibraryOpen(false);
    setSettingsOpen(false);
    setStreaming(true);

    const request = {
      sessionId: activeSessionId,
      prompt: nextPrompt,
      model: selectedModel,
      permissionMode,
      attachments,
      command: parsedInput.command,
      selectedSkillIds,
      responseStreamingEnabled: settings.agentStreamingEnabled,
    };

    setPrompt("");
    setAttachments([]);
    setSelectedSkillIds([]);
    cancelRef.current = window.superAgent.submitChat(request, {
      onEvent: handleStreamEvent,
    });
  };

  const regenerate = () => {
    if (!selectedModel || !activeSessionId) return;

    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    const rawCommand =
      typeof lastUserMessage?.metadata.rawCommand === "string"
        ? lastUserMessage.metadata.rawCommand
        : "";
    const parsedCommand = rawCommand
      ? parseAgentCommandInput(rawCommand)
      : null;

    setMessages((current) => removeAfterLastUser(current));
    setStreaming(true);

    cancelRef.current = window.superAgent.regenerate(
      activeSessionId,
      {
        model: selectedModel,
        permissionMode,
        attachments: [],
        command: parsedCommand?.command ?? null,
        responseStreamingEnabled: settings.agentStreamingEnabled,
      },
      { onEvent: handleStreamEvent },
    );
  };

  const stop = () => {
    cancelRef.current?.();
    cancelRef.current = null;
    setStreaming(false);
  };

  const selectSession = async (sessionId: string) => {
    const requestId = ++sessionRequestRef.current;
    const session = boot.sessions.find((item) => item.id === sessionId) ?? null;

    setActiveSessionId(sessionId);
    setLibraryOpen(false);
    setSettingsOpen(false);

    const nextMessages = await window.superAgent.listMessages(sessionId);
    if (sessionRequestRef.current !== requestId) return;
    setMessages(nextMessages);

    if (session?.workspaceDirectory) {
      try {
        const directory = await window.superAgent.setWorkspaceDirectory(
          session.workspaceDirectory,
        );
        if (sessionRequestRef.current !== requestId) return;
        setWorkspaceDirectory(directory);
      } catch (error: unknown) {
        if (sessionRequestRef.current !== requestId) return;
        await clearUnavailableSessionWorkspace(sessionId);
        await refreshWorkspace();
        appendLocalWorkspaceLog(
          "session.workspace.restore",
          "Saved session workspace is unavailable.",
          error,
        );
      }
    }
  };

  const newChat = () => {
    sessionRequestRef.current += 1;
    setActiveSessionId(null);
    setMessages([]);
    setPrompt("");
    setAttachments([]);
    setSelectedSkillIds([]);
    setLibraryOpen(false);
    setSettingsOpen(false);
  };

  const renameSession = async (sessionId: string, title: string) => {
    const session = await window.superAgent.renameSession(sessionId, title);
    updateSession(session);
  };

  const deleteSession = async (sessionId: string) => {
    await window.superAgent.deleteSession(sessionId);

    setBoot((state) => ({
      ...state,
      sessions: state.sessions.filter((session) => session.id !== sessionId),
    }));

    if (activeSessionId === sessionId) {
      newChat();
    }
  };

  const togglePinSession = async (sessionId: string, pinned: boolean) => {
    const session = await window.superAgent.setSessionPinned(sessionId, pinned);
    updateSession(session);
  };

  const attach = async (files: FileList) => {
    const next = await Promise.all([...files].map(readAttachment));
    setAttachments((current) => [...current, ...next]);
  };

  const saveSettings = async (next: AppSettings) => {
    const saved = await window.superAgent.saveSettings(next);
    setSettings(saved);
    setSelectedModel(defaultModelFromSettings(boot.models, saved));
  };

  const changeSelectedModel = async (value: string) => {
    const model = findModel(chatModels, value);
    setSelectedModel(model);

    if (!model) return;

    const nextSettings: AppSettings = {
      ...settings,
      defaultProvider: model.provider,
      defaultModel: model.model,
    };

    const saved = await window.superAgent.saveSettings(nextSettings);
    setSettings(saved);
  };

  const validateProvider = async (
    provider: ProviderName,
    next: AppSettings,
  ): Promise<ProviderValidationResult> => {
    const result = await window.superAgent.validateProvider(provider, next);

    if (result.ok) {
      setBoot((current) => {
        const models = replaceModelsForProvider(
          current.models,
          provider,
          result.models,
        );

        return {
          ...current,
          models,
          library: {
            ...current.library,
            models: {
              ...current.library.models,
              items: models,
            },
          },
        };
      });

      if (provider === settings.defaultProvider) {
        const preferredModel =
          result.models.find(
            (model) => model.model === settings.defaultModel,
          ) ??
          result.models[0] ??
          null;
        setSelectedModel(preferredModel);
      }
    }

    return result;
  };

  const updateSkill = async (
    skill: SkillUpdateRequest,
  ): Promise<SkillRecord> => {
    const saved = await window.superAgent.updateSkill(skill);
    rememberSkill(saved);
    return saved;
  };

  const validateSkillImport = async (
    skill: SkillImportRequest,
  ): Promise<SkillImportValidationResult> =>
    window.superAgent.validateSkillImport(skill);

  const importSkill = async (
    skill: SkillImportRequest,
  ): Promise<SkillRecord> => {
    const saved = await window.superAgent.importSkill(skill);
    rememberSkill(saved);
    return saved;
  };

  const exportSkill = async (skillId: string): Promise<SkillExportResult> =>
    window.superAgent.exportSkill(skillId);

  const deleteSkill = async (skillId: string): Promise<void> => {
    await window.superAgent.deleteSkill(skillId);
    setSelectedSkillIds((current) => current.filter((id) => id !== skillId));
    setBoot((state) => ({
      ...state,
      library: {
        ...state.library,
        skills: {
          ...state.library.skills,
          items: removeSkillRecord(state.library.skills.items, skillId),
        },
      },
    }));
  };


  const createSkillProposal = async (
    request: SkillProposalCreateRequest,
  ): Promise<SkillProposalRecord> => window.superAgent.createSkillProposal(request);

  const createSkillPatchProposal = async (
    request: SkillPatchRequest,
  ): Promise<SkillProposalRecord> => window.superAgent.createSkillPatchProposal(request);

  const listSkillProposals = async (
    skillId?: string,
  ): Promise<SkillProposalRecord[]> => window.superAgent.listSkillProposals(skillId);

  const applySkillProposal = async (proposalId: string, acceptedPaths?: string[]): Promise<SkillRecord> => {
    const saved = await window.superAgent.applySkillProposal(proposalId, acceptedPaths);
    rememberSkill(saved);
    return saved;
  };

  const rejectSkillProposal = async (proposalId: string): Promise<SkillProposalRecord> =>
    window.superAgent.rejectSkillProposal(proposalId);

  const listSkillSnapshots = async (skillId: string): Promise<SkillRollbackSnapshot[]> =>
    window.superAgent.listSkillSnapshots(skillId);

  const restoreSkillSnapshot = async (snapshotId: string): Promise<SkillRecord> => {
    const saved = await window.superAgent.restoreSkillSnapshot(snapshotId);
    rememberSkill(saved);
    return saved;
  };

  const listSkillEvalRuns = async (skillId: string): Promise<SkillEvalRunRecord[]> =>
    window.superAgent.listSkillEvalRuns(skillId);

  const installSkillFromGitHub = async (request: SkillGitHubInstallRequest): Promise<SkillRecord> => {
    const saved = await window.superAgent.installSkillFromGitHub(request);
    rememberSkill(saved);
    return saved;
  };

  const verifySkill = async (skillId: string): Promise<SkillVerificationResult> =>
    window.superAgent.verifySkill(skillId);

  const verifyAllSkills = async (): Promise<SkillVerificationResult[]> =>
    window.superAgent.verifyAllSkills();

  const updateAllSkills = async (): Promise<SkillUpdateAllResult> =>
    window.superAgent.updateAllSkills();

  const getSkillCredentials = async (skillId: string): Promise<SkillCredentialReport> =>
    window.superAgent.getSkillCredentials(skillId);

  const saveSkillCredentials = async (request: SkillCredentialSaveRequest): Promise<SkillCredentialReport> =>
    window.superAgent.saveSkillCredentials(request);

  const exportSkillAuditLog = async (request?: { skillId?: string; limit?: number }): Promise<SkillAuditExport> =>
    window.superAgent.exportSkillAuditLog(request);

  const verifySkillAuditExport = async (payload: SkillAuditExport): Promise<SkillAuditExportVerification> =>
    window.superAgent.verifySkillAuditExport(payload);

  const updateSkillLifecycle = async (skillId: string, action: "pin" | "unpin" | "archive" | "restore"): Promise<SkillRecord> => {
    const saved = await window.superAgent.updateSkillLifecycle(skillId, action);
    rememberSkill(saved);
    return saved;
  };

  const addMcpConnector = async (
    request: McpConnectorInstallRequest,
  ): Promise<McpConnectorInstallResult> => {
    const result = await window.superAgent.addMcpConnector(request);
    await refreshLibrary();
    return result;
  };

  const createSkillWithChat = () => {
    setSelectedSkillIds((current) =>
      current.includes("skill-creator")
        ? current
        : [...current, "skill-creator"],
    );
    setPrompt(SKILL_CREATOR_BOOTSTRAP_PROMPT);
    setLibraryOpen(false);
  };

  const selectWorkspace = async () => {
    const directory = await window.superAgent.selectWorkspaceDirectory();

    if (directory) {
      setWorkspaceDirectory(directory);

      if (activeSessionId) {
        void persistSessionWorkspaceDirectory(activeSessionId, directory);
      }
    }
  };

  const runWorkspace = async (
    request: WorkspaceCommandRequest,
  ): Promise<ToolResultRecord> => {
    const result = (await window.superAgent.runWorkspaceCommand(
      request,
    )) as ToolResultRecord;

    setWorkspaceOpen(true);
    await refreshWorkspace();
    return result;
  };

  const respondToApproval = (
    approved: boolean,
    grantScope: ApprovalGrantScope = "once",
  ) => {
    const approval = pendingApproval;
    if (!approval) return;
    setPendingApproval(null);
    void window.superAgent.approveToolCall(
      approval.call.id,
      approved,
      grantScope,
    );
  };

  return (
    <div className={layoutClass}>
      <Sidebar
        collapsed={sidebarCollapsed}
        sessions={boot.sessions}
        activeSessionId={activeSessionId}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        onToggleCollapse={() => setSidebarCollapsed((value) => !value)}
        onNewChat={newChat}
        onOpenLibrary={() => {
          setLibraryOpen(true);
          setSettingsOpen(false);
        }}
        onOpenSettings={() => {
          setSettingsOpen(true);
          setLibraryOpen(false);
        }}
        onToggleSearch={() => setSearchOpen((value) => !value)}
        onSearchChange={setSearchQuery}
        onSelectSession={(sessionId) => void selectSession(sessionId)}
        onRenameSession={(sessionId, title) =>
          void renameSession(sessionId, title)
        }
        onDeleteSession={(sessionId) => void deleteSession(sessionId)}
        onTogglePinSession={(sessionId, pinned) =>
          void togglePinSession(sessionId, pinned)
        }
      />

      {settingsOpen ? (
        <SettingsPanel
          settings={settings}
          models={boot.models}
          testProviderEnabled={boot.testProviderEnabled}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
          onValidate={validateProvider}
        />
      ) : libraryOpen ? (
        <LibraryPanel
          library={boot.library}
          onUpdateSkill={updateSkill}
          onValidateSkillImport={validateSkillImport}
          onImportSkill={importSkill}
          onExportSkill={exportSkill}
          onDeleteSkill={deleteSkill}
          onCreateSkillProposal={createSkillProposal}
          onCreateSkillPatchProposal={createSkillPatchProposal}
          onListSkillProposals={listSkillProposals}
          onApplySkillProposal={applySkillProposal}
          onRejectSkillProposal={rejectSkillProposal}
          onListSkillSnapshots={listSkillSnapshots}
          onRestoreSkillSnapshot={restoreSkillSnapshot}
          onListSkillEvalRuns={listSkillEvalRuns}
          onUpdateSkillLifecycle={updateSkillLifecycle}
          onInstallSkillFromGitHub={installSkillFromGitHub}
          onVerifySkill={verifySkill}
          onVerifyAllSkills={verifyAllSkills}
          onUpdateAllSkills={updateAllSkills}
          onGetSkillCredentials={getSkillCredentials}
          onSaveSkillCredentials={saveSkillCredentials}
          onExportSkillAuditLog={exportSkillAuditLog}
          onVerifySkillAuditExport={verifySkillAuditExport}
          onCreateSkillWithChat={createSkillWithChat}
          onAddMcpConnector={addMcpConnector}
        />
      ) : (
        <ChatArea
          messages={messages}
          prompt={prompt}
          models={chatModels}
          selectedModel={selectedModel}
          permissionMode={permissionMode}
          attachments={attachments}
          streaming={streaming}
          workspaceOpen={workspaceOpen}
          sidebarCollapsed={sidebarCollapsed}
          providerHealth={providerHealth}
          canRegenerate={Boolean(
            activeSessionId &&
            messages.some((message) => message.role === "user"),
          )}
          workspaceLabel={directoryLabel(workspaceDirectory)}
          skills={boot.library.skills.items}
          selectedSkillIds={selectedSkillIds}
          onPromptChange={setPrompt}
          onModelChange={(value) => void changeSelectedModel(value)}
          onPermissionChange={setPermissionMode}
          onAttach={(files) => void attach(files)}
          onRemoveAttachment={(id) =>
            setAttachments((current) =>
              current.filter((item) => item.id !== id),
            )
          }
          onSelectWorkspace={() => void selectWorkspace()}
          onSelectedSkillIdsChange={setSelectedSkillIds}
          onSubmit={submit}
          onStop={stop}
          onRegenerate={regenerate}
          onToggleWorkspace={() => setWorkspaceOpen((value) => !value)}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
        />
      )}

      <WorkspacePanel
        open={workspaceOpen}
        status={workspaceStatus}
        url={workspaceUrl}
        snapshot={workspaceSnapshot}
        logs={workspaceLogs}
        permissionMode={permissionMode}
        onClose={() => setWorkspaceOpen(false)}
        onRun={runWorkspace}
        onRefreshLogs={refreshWorkspace}
      />

      {pendingApproval ? (
        <ApprovalDialog
          call={pendingApproval.call}
          reason={pendingApproval.reason}
          onRespond={respondToApproval}
        />
      ) : null}
    </div>
  );
}
