import { mkdirSync, statSync } from "node:fs";
import { BrowserWindow, safeStorage, type WebContents } from "electron";
import type {
  AgentBehaviorSettings,
  ApprovalGrantScope,
  AppBootstrapState,
  AppSettings,
  ChatMessage,
  ChatSession,
  ChatSubmitRequest,
  McpConnectorInstallRequest,
  McpConnectorInstallResult,
  ModelOption,
  ProviderName,
  SkillEvalRunRecord,
  SkillEvalRunRequest,
  SkillGitHubInstallRequest,
  SkillImportAdapterRequest,
  SkillAuditExport,
  SkillCredentialSaveRequest,
  SkillImportAdapterResult,
  SkillPatchRequest,
  SkillProposalCreateRequest,
  SkillProposalRecord,
  SkillRecord,
  SkillRegistryEntry,
  SkillRegistryInstallRequest,
  SkillRegistrySearchRequest,
  SkillRollbackSnapshot,
  SkillExportResult,
  SkillImportRequest,
  SkillImportValidationResult,
  SkillUpdateAllResult,
  SkillUpdateRequest,
  SkillVerificationResult,
  StreamEvent,
  ToolCallRecord,
  ToolResultRecord
} from "@shared/types";
import type { WorkspaceCommandRequest } from "@shared/ipc";
import { asJsonRecord } from "@shared/json";
import { AgentGraphRunner } from "@agent/agentGraph";
import { ChatService } from "@agent/chatService";
import { ArtifactService } from "@artifacts/artifactService";
import { LlmService } from "@providers/providerService";
import { createProviders } from "@providers/registry/createProviders";
import { registerProviders } from "@providers/registry/registerProviders";
import { ContextBuilder } from "@memory/contextBuilder";
import { McpRegistry } from "@mcp/mcpRegistry";
import { createRemoteMcpServerConfig, saveMcpServerConfig } from "@mcp/mcpConfig";
import { PermissionService } from "@permissions/permissionService";
import { ApprovalBroker } from "@permissions/approvalBroker";
import type { ApprovalOutcome } from "@permissions/approvalBroker";
import { ArtifactRepository } from "@persistence/artifactRepository";
import { ChatRepository } from "@persistence/chatRepository";
import { LocalDatabase } from "@persistence/localDatabase";
import { MemoryRepository } from "@persistence/memoryRepository";
import { ProviderModelRepository } from "@persistence/providerModelRepository";
import { SkillRepository } from "@persistence/skillRepository";
import { WorkspaceLogRepository } from "@persistence/workspaceLogRepository";
import { PluginRegistry } from "@plugins/pluginRegistry";
import { SkillRegistry } from "@skills-system/skillRegistry";
import { ToolRegistry } from "@tool-registry/toolRegistry";
import { stopManagedProcessesForWorkspace } from "@tools/general/processManager";
import { registerAvailableTools } from "@tool-registry/registerTools";
import type { ToolExecutionContext } from "@tool-registry/types";
import { toBlockedToolResult } from "@tool-registry/types";
import { BrowserWorkspaceController } from "@workspace/browserWorkspaceController";
import { loadRuntimeConfig, type RuntimeConfig } from "./env";
import { LibraryService } from "./libraryService";
import { ModelService } from "@providers/modelService";
import { SettingsRepository } from "./settingsRepository";
import { validateProviderConfig } from "@providers/validation/providerValidationService";
import { checkProviderHealth } from "@providers/health/providerHealthService";
type WorkspaceApprovalHandler = (
  call: ToolCallRecord,
  reason: string
) => Promise<ApprovalOutcome>;
interface RuntimeServices {
  config: RuntimeConfig;
  database: LocalDatabase;
  llm: LlmService;
  chats: ChatRepository;
  chatService: ChatService;
  library: LibraryService;
  models: ModelService;
  skills: SkillRegistry;
  plugins: PluginRegistry;
  permissions: PermissionService;
  approvals: ApprovalBroker;
  tools: ToolRegistry;
  toolContext: ToolExecutionContext;
  workspaceLogs: WorkspaceLogRepository;
  browserWorkspace: BrowserWorkspaceController;
  settings: SettingsRepository;
}
interface ActiveRun {
  controller: AbortController;
  ownerId: number;
  cleanup: () => void;
}
const configureLlmProviders = (
  llm: LlmService,
  settings: AppSettings,
  testProviderEnabled: boolean
): void => {
  registerProviders(
    llm,
    createProviders(settings, { testProviderEnabled })
  );
};
const agentSettingsFromAppSettings = (
  settings: AppSettings
): AgentBehaviorSettings => ({
  allowOutsideWorkspaceAccess: settings.agentOutsideWorkspaceAccess === true,
  allowPrivateNetworkAccess: settings.agentPrivateNetworkAccess === true,
  useShellSandbox: settings.agentShellSandboxEnabled === true
});
const makeSafeStorageCodec = () => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return {
    encrypt(value: string): string {
      return safeStorage.encryptString(value).toString("base64");
    },
    decrypt(value: string): string {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    }
  };
};
const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const isDisposedFrameError = (error: unknown): boolean => {
  const message = formatErrorMessage(error);
  return (
    message.includes("Render frame was disposed") ||
    message.includes("WebFrameMain could be accessed") ||
    message.includes("Object has been destroyed") ||
    message.includes("webContents has been destroyed")
  );
};
const MASKED_SECRET_VALUE = "__SUPER_AGENT_SECRET_CONFIGURED__";
const maskSecret = (value: string): string =>
  value.length > 0 ? MASKED_SECRET_VALUE : "";
const unmaskSecret = (incoming: string, current: string): string =>
  incoming === MASKED_SECRET_VALUE ? current : incoming;
const sendWebContentsMessage = (
  contents: WebContents,
  channel: string,
  payload: unknown,
  onError?: (error: unknown) => void
): boolean => {
  if (contents.isDestroyed()) {
    return false;
  }
  try {
    contents.send(channel, payload);
    return true;
  } catch (error) {
    if (!isDisposedFrameError(error)) {
      onError?.(error);
    }
    return false;
  }
};
export class AppRuntime {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private constructor(private readonly services: RuntimeServices) {}
  private logInternalError(
    action: string,
    error: unknown,
    message = "A background app operation failed."
  ): void {
    this.services.workspaceLogs.add(action, "failed", {
      message,
      error: formatErrorMessage(error)
    });
  }
  private async sendStreamEvent(
    sender: WebContents,
    streamId: string,
    event: StreamEvent
  ): Promise<boolean> {
    const run = this.activeRuns.get(streamId);
    if (!run || run.ownerId !== sender.id || sender.isDestroyed()) {
      this.abortActiveRun(streamId);
      return false;
    }
    if (event.type === "permission_request") {
      this.services.approvals.expectOwner(event.call.id, sender.id);
    }
    const sent = sendWebContentsMessage(
      sender,
      `chat:stream:${streamId}`,
      event,
      (error) =>
        this.logInternalError(
          "ipc.chat_stream",
          error,
          "Could not send a chat stream event to the app window."
        )
    );
    if (!sent) {
      this.abortActiveRun(streamId);
      return false;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    return true;
  }
  private broadcastProviderModels(
    provider: ProviderName,
    models: ModelOption[],
    message: string
  ): void {
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents;
      sendWebContentsMessage(
        contents,
        "provider-models:updated",
        {
          provider,
          models,
          message
        },
        (error) =>
          this.logInternalError(
            "ipc.provider_models",
            error,
            "Could not send provider model updates to the app window."
          )
      );
    }
  }
  private refreshSkillCatalog(): void {
    this.services.plugins.setWorkspaceDirectory(this.services.toolContext.workspaceDir);
    this.services.skills.configureRoots({
      workspaceDir: this.services.toolContext.workspaceDir,
      pluginRoots: this.services.plugins.skillRoots(),
      onRootsChanged: () => this.broadcastLibraryUpdated(),
    });
  }
  private broadcastLibraryUpdated(): void {
    const library = this.services.library.getLibrary();
    for (const window of BrowserWindow.getAllWindows()) {
      sendWebContentsMessage(
        window.webContents,
        "library:updated",
        library,
        (error) =>
          this.logInternalError(
            "ipc.library",
            error,
            "Could not send library updates to the app window."
          )
      );
    }
  }
  static async create(): Promise<AppRuntime> {
    const config = loadRuntimeConfig();
    mkdirSync(config.workspaceDir, { recursive: true });
    const database = new LocalDatabase(config.databasePath);
    await database.initialize();
    const secretCodec = makeSafeStorageCodec();
    const settings = new SettingsRepository(database, secretCodec);
    const savedSettings = settings.save(settings.get());
    const chats = new ChatRepository(database);
    const providerModels = new ProviderModelRepository(database);
    const workspaceLogs = new WorkspaceLogRepository(database);
    const artifacts = new ArtifactRepository(database, config.workspaceDir);
    const browserWorkspace = new BrowserWorkspaceController(
      workspaceLogs,
      agentSettingsFromAppSettings(savedSettings)
    );
    const plugins = new PluginRegistry(config.workspaceDir);
    let runtimeRef: AppRuntime | null = null;
    const skills = new SkillRegistry(new SkillRepository(database), {
      workspaceDir: config.workspaceDir,
      pluginRoots: plugins.skillRoots(),
      onRootsChanged: () => runtimeRef?.broadcastLibraryUpdated(),
      credentialCodec: secretCodec,
    });
    skills.initializeBuiltIns();
    const mcp = new McpRegistry(config.mcp, config.workspaceDir);
    void mcp.startAutoServers();
    const tools = new ToolRegistry();
    registerAvailableTools(tools);
    const permissions = new PermissionService();
    const approvals = new ApprovalBroker(config.testProviderEnabled ? 10 : 30000);
    const llm = new LlmService();
    configureLlmProviders(llm, savedSettings, config.testProviderEnabled);
    const toolContext: ToolExecutionContext = {
      workspaceDir: config.workspaceDir,
      browserWorkspace,
      artifacts,
      workspaceLogs,
      skills,
      mcp,
      agentSettings: agentSettingsFromAppSettings(savedSettings)
    };
    const graph = new AgentGraphRunner(
      llm,
      tools,
      permissions,
      approvals,
      new ContextBuilder(),
      new MemoryRepository(database),
      toolContext
    );
    const chatService = new ChatService(chats, skills, graph);
    const models = new ModelService(llm, providerModels);
    const library = new LibraryService(
      plugins,
      skills,
      mcp,
      new ArtifactService(artifacts),
      tools,
      models
    );
    const runtime = new AppRuntime({
      config,
      database,
      llm,
      chats,
      chatService,
      library,
      models,
      skills,
      plugins,
      permissions,
      approvals,
      tools,
      toolContext,
      workspaceLogs,
      browserWorkspace,
      settings
    });
    runtimeRef = runtime;
    return runtime;
  }
  getBootstrapState(): AppBootstrapState {
    const status = this.services.browserWorkspace.getStatus();
    return {
      sessions: this.services.chats.listSessions(),
      models: this.runtimeModels(),
      library: this.getLibrary(),
      workspaceStatus: status.status,
      workspaceUrl: status.url,
      workspaceDirectory: this.services.toolContext.workspaceDir,
      workspaceLogs: this.services.workspaceLogs.list(),
      workspaceSnapshot: this.services.browserWorkspace.getSnapshot(),
      settings: this.publicRuntimeSettings(),
      testProviderEnabled: this.services.config.testProviderEnabled
    };
  }
  listMessages(sessionId: string): ChatMessage[] {
    return this.services.chats.listMessages(sessionId);
  }
  searchSessions(query: string): ChatSession[] {
    return this.services.chats.listSessions(query);
  }
  renameSession(sessionId: string, title: string): ChatSession {
    return this.services.chats.renameSession(sessionId, title);
  }
  deleteSession(sessionId: string): { deleted: boolean } {
    return { deleted: this.services.chats.deleteSession(sessionId) };
  }
  setSessionPinned(sessionId: string, pinned: boolean): ChatSession {
    return this.services.chats.setPinned(sessionId, pinned);
  }
  setSessionWorkspaceDirectory(
    sessionId: string,
    workspaceDirectory: string | null
  ): ChatSession {
    return this.services.chats.setWorkspaceDirectory(
      sessionId,
      workspaceDirectory
    );
  }
  submitChat(
    streamId: string,
    sender: WebContents,
    request: ChatSubmitRequest
  ): void {
    this.createActiveRun(streamId, sender);
    const emit = (event: StreamEvent): Promise<boolean> =>
      this.sendStreamEvent(sender, streamId, event);
    this.services.chatService
      .submit(this.applyRuntimeChatSettings(request), emit, this.activeSignal(streamId))
      .catch((error: unknown) => {
        void this.emitRuntimeError(sender, streamId, error);
      })
      .finally(() => this.finishActiveRun(streamId));
  }
  regenerate(
    streamId: string,
    sender: WebContents,
    sessionId: string,
    request: Omit<ChatSubmitRequest, "sessionId" | "prompt">
  ): void {
    this.createActiveRun(streamId, sender);
    const emit = (event: StreamEvent): Promise<boolean> =>
      this.sendStreamEvent(sender, streamId, event);
    this.services.chatService
      .regenerate(
        sessionId,
        this.applyRuntimeChatSettings(request),
        emit,
        this.activeSignal(streamId)
      )
      .catch((error: unknown) => {
        void this.emitRuntimeError(sender, streamId, error);
      })
      .finally(() => this.finishActiveRun(streamId));
  }
  cancel(streamId: string, sender?: WebContents): void {
    const run = this.activeRuns.get(streamId);
    if (!run) return;
    if (sender && run.ownerId !== sender.id) return;
    this.abortActiveRun(streamId);
  }
  approveToolCall(
    toolCallId: string,
    approved: boolean,
    grantScope: ApprovalGrantScope = "once"
  ): boolean {
    return this.services.approvals.resolve(
      toolCallId,
      approved,
      undefined,
      grantScope
    );
  }
  approveToolCallFromSender(
    toolCallId: string,
    approved: boolean,
    sender: WebContents,
    grantScope: ApprovalGrantScope = "once"
  ): boolean {
    return this.services.approvals.resolve(
      toolCallId,
      approved,
      sender.id,
      grantScope
    );
  }
  getLibrary() {
    this.refreshSkillCatalog();
    return this.services.library.getLibrary();
  }
  async addMcpConnector(
    request: McpConnectorInstallRequest
  ): Promise<McpConnectorInstallResult> {
    const mcp = this.services.toolContext.mcp;
    if (!mcp) throw new Error("MCP runtime is not configured.");

    const server = createRemoteMcpServerConfig(
      request,
      this.services.toolContext.workspaceDir,
    );
    const tools = await mcp.testServer(server);
    const servers = saveMcpServerConfig(
      mcp.configPath(),
      mcp.configuredServers(),
      server,
    );
    this.services.config.mcp.enabled = true;
    this.services.config.mcp.servers = servers;
    await mcp.upsertServer(server);
    this.broadcastLibraryUpdated();

    return {
      serverId: server.id,
      configPath: mcp.configPath() ?? "",
      toolCount: tools.length,
      tools: tools.slice(0, 20).map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
      message: `Connected ${server.id} and found ${tools.length} tool${tools.length === 1 ? "" : "s"}.`
    };
  }
  updateSkill(skill: SkillUpdateRequest): SkillRecord {
    const updated = this.services.skills.update(skill);
    this.broadcastLibraryUpdated();
    return updated;
  }
  previewSkillImport(skill: SkillImportRequest): SkillImportValidationResult {
    return this.services.skills.previewImport(skill);
  }
  importSkill(skill: SkillImportRequest): SkillRecord {
    const imported = this.services.skills.importSkill(skill);
    this.broadcastLibraryUpdated();
    return imported;
  }
  exportSkill(id: string): SkillExportResult {
    return this.services.skills.exportSkill(id);
  }
  deleteSkill(id: string): void {
    this.services.skills.delete(id);
    this.broadcastLibraryUpdated();
  }
  createSkillProposal(request: SkillProposalCreateRequest): SkillProposalRecord {
    const proposal = this.services.skills.createProposal(request);
    this.broadcastLibraryUpdated();
    return proposal;
  }
  createSkillPatchProposal(request: SkillPatchRequest): SkillProposalRecord {
    const proposal = this.services.skills.createPatchProposal(request);
    this.broadcastLibraryUpdated();
    return proposal;
  }
  listSkillProposals(skillId?: string): SkillProposalRecord[] {
    return this.services.skills.listProposals(skillId);
  }
  applySkillProposal(proposalId: string, acceptedPaths?: string[]): SkillRecord {
    const skill = this.services.skills.applyProposal(proposalId, acceptedPaths);
    this.broadcastLibraryUpdated();
    return skill;
  }
  rejectSkillProposal(proposalId: string): SkillProposalRecord {
    const proposal = this.services.skills.rejectProposal(proposalId);
    this.broadcastLibraryUpdated();
    return proposal;
  }
  listSkillSnapshots(skillId: string): SkillRollbackSnapshot[] {
    return this.services.skills.listSnapshots(skillId);
  }
  restoreSkillSnapshot(snapshotId: string): SkillRecord {
    const skill = this.services.skills.restoreSnapshot(snapshotId);
    this.broadcastLibraryUpdated();
    return skill;
  }
  runSkillEvals(request: SkillEvalRunRequest): SkillEvalRunRecord {
    const run = this.services.skills.runEvals(request);
    this.broadcastLibraryUpdated();
    return run;
  }
  listSkillEvalRuns(skillId: string): SkillEvalRunRecord[] {
    return this.services.skills.listEvalRuns(skillId);
  }
  updateSkillLifecycle(skillId: string, action: "pin" | "unpin" | "archive" | "restore"): SkillRecord {
    const skill = this.services.skills.updateLifecycle(skillId, action);
    this.broadcastLibraryUpdated();
    return skill;
  }
  async installSkillFromGitHub(request: SkillGitHubInstallRequest): Promise<SkillRecord> {
    const skill = await this.services.skills.installFromGitHub(request);
    this.broadcastLibraryUpdated();
    return skill;
  }
  async searchSkillRegistry(request: SkillRegistrySearchRequest): Promise<SkillRegistryEntry[]> {
    return this.services.skills.searchRegistry(request);
  }
  async installSkillFromRegistry(request: SkillRegistryInstallRequest): Promise<SkillRecord> {
    const skill = await this.services.skills.installFromRegistry(request);
    this.broadcastLibraryUpdated();
    return skill;
  }
  verifySkill(skillId: string): SkillVerificationResult {
    const result = this.services.skills.verifySkill(skillId);
    this.broadcastLibraryUpdated();
    return result;
  }
  verifyAllSkills(): SkillVerificationResult[] {
    const results = this.services.skills.verifyAllSkills();
    this.broadcastLibraryUpdated();
    return results;
  }
  async updateAllSkills(): Promise<SkillUpdateAllResult> {
    const result = await this.services.skills.updateAllSkills(true);
    this.broadcastLibraryUpdated();
    return result;
  }
  adaptSkillImport(request: SkillImportAdapterRequest): SkillImportAdapterResult {
    return this.services.skills.adaptImport(request);
  }
  getSkillCredentials(skillId: string) {
    return this.services.skills.credentialReport(skillId);
  }
  saveSkillCredentials(request: SkillCredentialSaveRequest) {
    return this.services.skills.saveCredentials(request);
  }
  exportSkillAuditLog(skillId?: string, limit?: number) {
    return this.services.skills.exportAuditLog(skillId, limit);
  }
  verifySkillAuditExport(payload: SkillAuditExport) {
    return this.services.skills.verifyAuditExport(payload);
  }
  getSettings(): AppSettings {
    return this.publicRuntimeSettings();
  }
  saveSettings(settings: AppSettings): AppSettings {
    const saved = this.services.settings.save(
      this.runtimeSettings(this.resolvePublicSettings(settings))
    );
    this.services.toolContext.agentSettings = agentSettingsFromAppSettings(saved);
    this.services.browserWorkspace.setAgentSettings(
      this.services.toolContext.agentSettings
    );
    configureLlmProviders(
      this.services.llm,
      saved,
      this.services.config.testProviderEnabled
    );
    return this.publicRuntimeSettings(saved);
  }
  async getProviderHealth(provider: ProviderName, settings: AppSettings) {
    return checkProviderHealth(
      provider,
      this.runtimeSettings(this.resolvePublicSettings(settings))
    );
  }
  async validateProvider(provider: ProviderName, settings: AppSettings) {
    if (provider === "stub" && !this.services.config.testProviderEnabled) {
      return {
        provider,
        ok: false,
        message:
          "Local test provider is only available when SUPER_AGENT_TEST_PROVIDER=stub.",
        models: []
      };
    }
    if (provider === "nvidia") {
      const cachedModels = this.providerModels("nvidia");
      if (cachedModels.length > 0) {
        this.services.workspaceLogs.add("nvidia.validation", "ok", {
          provider,
          modelCount: cachedModels.length,
          cache: "provider_models"
        });
        return {
          provider,
          ok: true,
          message: `Using ${cachedModels.length} cached NVIDIA model${
            cachedModels.length === 1 ? "" : "s"
          }.`,
          models: cachedModels
        };
      }
    }
    const runtimeSettings = this.runtimeSettings(this.resolvePublicSettings(settings));
    const result = await validateProviderConfig(provider, runtimeSettings, {
      onBackgroundModels: (backgroundProvider, models, backgroundMessage) => {
        this.services.models.replaceProviderModels(backgroundProvider, models);
        this.broadcastProviderModels(backgroundProvider, models, backgroundMessage);
        this.services.workspaceLogs.add("nvidia.validation", "ok", {
          provider: backgroundProvider,
          modelCount: models.length,
          message: backgroundMessage
        });
      },
      onLog: (logMessage) => {
        this.services.workspaceLogs.add("nvidia.validation", "running", {
          message: logMessage
        });
      }
    });
    if (result.ok) {
      this.services.models.replaceProviderModels(provider, result.models);
      this.broadcastProviderModels(provider, result.models, result.message);
    }
    return result;
  }
  getWorkspaceDirectory(): string {
    return this.services.toolContext.workspaceDir;
  }
  async setWorkspaceDirectory(directory: string): Promise<void> {
    const stat = statSync(directory);
    if (!stat.isDirectory()) {
      throw new Error("Workspace directory must be an existing directory.");
    }
    const previousDirectory = this.services.toolContext.workspaceDir;
    if (previousDirectory === directory) return;
    await this.stopManagedProcessesForWorkspace(previousDirectory);
    this.services.toolContext.workspaceDir = directory;
    this.services.toolContext.artifacts.setWorkspaceDirectory(directory);
    this.services.workspaceLogs.add("workspace.switch", "ok", {
      from: previousDirectory,
      to: directory
    });
    this.refreshSkillCatalog();
    this.broadcastLibraryUpdated();
  }
  getWorkspaceLogs() {
    return this.services.workspaceLogs.list();
  }
  getWorkspaceStatus() {
    return this.services.browserWorkspace.getStatus();
  }
  getWorkspaceSnapshot() {
    return this.services.browserWorkspace.getSnapshot();
  }
  async runWorkspaceCommand(
    request: WorkspaceCommandRequest,
    approve?: WorkspaceApprovalHandler
  ): Promise<ToolResultRecord> {
    const call = this.toWorkspaceToolCall(request);
    const decision = this.services.permissions.decide(
      call,
      request.permissionMode,
      this.services.toolContext.workspaceDir,
      this.services.toolContext.agentSettings
    );
    const effectiveCall = { ...call, risk: decision.effectiveRisk };
    if (!decision.allowed && decision.requiresApproval) {
      const approval = approve
        ? await approve(effectiveCall, decision.reason)
        : { approved: false, grantScope: "once" as const };
      if (!approval.approved) {
        return this.blockWorkspaceCommand(effectiveCall, decision.reason);
      }
    } else if (!decision.allowed) {
      return this.blockWorkspaceCommand(effectiveCall, decision.reason);
    }
    return this.services.tools.execute(effectiveCall, this.services.toolContext);
  }
  private applyRuntimeChatSettings<T extends { responseStreamingEnabled?: boolean }>(
    request: T
  ): T {
    return {
      ...request,
      responseStreamingEnabled: this.runtimeSettings().agentStreamingEnabled
    };
  }
  async close(): Promise<void> {
    for (const streamId of [...this.activeRuns.keys()]) {
      this.abortActiveRun(streamId);
    }
    await this.stopManagedProcessesForCurrentWorkspace();
    await this.services.browserWorkspace.close();
    this.services.skills.close();
    this.services.database.close();
  }
  private activeSignal(streamId: string): AbortSignal {
    const run = this.activeRuns.get(streamId);
    if (!run) {
      const controller = new AbortController();
      controller.abort();
      return controller.signal;
    }
    return run.controller.signal;
  }
  private finishActiveRun(streamId: string): void {
    const run = this.activeRuns.get(streamId);
    if (!run) {
      return;
    }
    run.cleanup();
    this.activeRuns.delete(streamId);
    void this.stopManagedProcessesForCurrentWorkspace();
  }
  private abortActiveRun(streamId: string): void {
    const run = this.activeRuns.get(streamId);
    if (!run) {
      return;
    }
    run.controller.abort();
    run.cleanup();
    this.activeRuns.delete(streamId);
    void this.stopManagedProcessesForCurrentWorkspace();
  }
  private async stopManagedProcessesForCurrentWorkspace(): Promise<void> {
    await this.stopManagedProcessesForWorkspace(this.services.toolContext.workspaceDir);
  }
  private async stopManagedProcessesForWorkspace(workspaceDir: string): Promise<void> {
    const stopped = await stopManagedProcessesForWorkspace(workspaceDir);
    if (stopped.length === 0) return;
    this.services.workspaceLogs.add("process.cleanup", "ok", {
      count: stopped.length,
      processes: stopped
    });
  }
  private createActiveRun(streamId: string, sender: WebContents): AbortController {
    if (this.activeRuns.has(streamId)) {
      throw new Error("Stream ID is already active.");
    }
    const controller = new AbortController();
    const abortOnSenderDestroyed = (): void => {
      this.abortActiveRun(streamId);
    };
    sender.once("destroyed", abortOnSenderDestroyed);
    const cleanup = (): void => {
      try {
        if (!sender.isDestroyed()) {
          sender.off("destroyed", abortOnSenderDestroyed);
        }
      } catch (error) {
        if (!isDisposedFrameError(error)) {
          this.logInternalError(
            "stream.cleanup",
            error,
            "Could not clean up a chat stream listener."
          );
        }
      }
    };
    this.activeRuns.set(streamId, {
      controller,
      ownerId: sender.id,
      cleanup
    });
    return controller;
  }
  private providerModels(provider: ProviderName) {
    return this.services.models
      .list()
      .filter((model) => model.provider === provider);
  }
  private runtimeModels() {
    const models = this.services.models.list();
    if (this.services.config.testProviderEnabled) return models;
    return models.filter((model) => model.provider !== "stub");
  }
  private publicRuntimeSettings(settings = this.services.settings.get()): AppSettings {
    const runtime = this.runtimeSettings(settings);
    return {
      ...runtime,
      groqApiKey: maskSecret(runtime.groqApiKey),
      nvidiaApiKey: maskSecret(runtime.nvidiaApiKey)
    };
  }
  private resolvePublicSettings(settings: AppSettings): AppSettings {
    const current = this.services.settings.get();
    return {
      ...settings,
      groqApiKey: unmaskSecret(settings.groqApiKey, current.groqApiKey),
      nvidiaApiKey: unmaskSecret(settings.nvidiaApiKey, current.nvidiaApiKey)
    };
  }
  private runtimeSettings(settings = this.services.settings.get()): AppSettings {
    if (this.services.config.testProviderEnabled) {
      const stubModel = this.providerModels("stub")[0]?.model ?? "";
      if (settings.defaultProvider !== "stub" || !settings.defaultModel) {
        return {
          ...settings,
          defaultProvider: "stub",
          defaultModel: stubModel
        };
      }
      return settings;
    }
    if (settings.defaultProvider !== "stub") {
      return settings;
    }
    return {
      ...settings,
      defaultProvider: "groq",
      defaultModel: ""
    };
  }
  private blockWorkspaceCommand(
    call: ToolCallRecord,
    reason: string
  ): ToolResultRecord {
    const result = toBlockedToolResult(call, reason, call.input);
    this.services.workspaceLogs.add(call.name, "blocked", { reason });
    return result;
  }
  private toWorkspaceToolCall(request: WorkspaceCommandRequest): ToolCallRecord {
    const nameByCommand = {
      navigate: "browser.navigate",
      click: "browser.click",
      type: "browser.type",
      snapshot: "browser.snapshot",
      status: "workspace.status"
    } as const;
    const name = nameByCommand[request.command];
    const tool = this.services.tools.get(name);
    return {
      id: crypto.randomUUID(),
      name,
      risk: tool?.risk ?? "medium",
      input: asJsonRecord(request.input)
    };
  }
  private async emitRuntimeError(
    sender: WebContents,
    streamId: string,
    error: unknown
  ): Promise<void> {
    const message =
      error instanceof Error ? error.message : "Unknown runtime error";
    const now = new Date().toISOString();
    await this.sendStreamEvent(sender, streamId, {
      type: "error",
      error: message,
      message: {
        id: `runtime-error-${streamId}`,
        sessionId: "",
        role: "error",
        content: message,
        status: "failed",
        createdAt: now,
        metadata: {}
      }
    } satisfies StreamEvent);
  }
}
