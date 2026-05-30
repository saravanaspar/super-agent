import type {
  AppBootstrapState,
  ApprovalGrantScope,
  AppSettings,
  ChatMessage,
  ChatSession,
  ChatSubmitRequest,
  LibraryData,
  McpConnectorInstallRequest,
  McpConnectorInstallResult,
  PermissionMode,
  ProviderModelsUpdatedEvent,
  ProviderName,
  ProviderHealthResult,
  ProviderValidationResult,
  SkillAuditExport,
  SkillAuditExportVerification,
  SkillCredentialReport,
  SkillCredentialSaveRequest,
  SkillEvalRunRecord,
  SkillEvalRunRequest,
  SkillGitHubInstallRequest,
  SkillImportAdapterRequest,
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
  WorkspaceActionLog,
  WorkspaceSnapshot,
  WorkspaceStatus
} from "./types";

export interface ApprovalResponse {
  approved: boolean;
  grantScope?: ApprovalGrantScope;
}

export interface WorkspaceCommandRequest {
  command: "navigate" | "click" | "type" | "snapshot" | "status";
  input: Record<string, unknown>;
  permissionMode: PermissionMode;
}

export interface WorkspaceStatusResponse {
  status: WorkspaceStatus;
  url: string;
  workspaceDirectory: string;
}

export interface ChatStreamHandlers {
  onEvent: (event: StreamEvent) => void;
}

export interface SuperAgentApi {
  getBootstrapState: () => Promise<AppBootstrapState>;
  listMessages: (sessionId: string) => Promise<ChatMessage[]>;
  searchSessions: (query: string) => Promise<ChatSession[]>;
  renameSession: (sessionId: string, title: string) => Promise<ChatSession>;
  deleteSession: (sessionId: string) => Promise<{ deleted: boolean }>;
  setSessionPinned: (
    sessionId: string,
    pinned: boolean
  ) => Promise<ChatSession>;
  setSessionWorkspaceDirectory: (
    sessionId: string,
    workspaceDirectory: string | null
  ) => Promise<ChatSession>;
  submitChat: (
    request: ChatSubmitRequest,
    handlers: ChatStreamHandlers
  ) => () => void;
  regenerate: (
    sessionId: string,
    request: Omit<ChatSubmitRequest, "sessionId" | "prompt">,
    handlers: ChatStreamHandlers
  ) => () => void;
  getLibrary: () => Promise<LibraryData>;
  addMcpConnector: (request: McpConnectorInstallRequest) => Promise<McpConnectorInstallResult>;
  updateSkill: (skill: SkillUpdateRequest) => Promise<SkillRecord>;
  validateSkillImport: (skill: SkillImportRequest) => Promise<SkillImportValidationResult>;
  importSkill: (skill: SkillImportRequest) => Promise<SkillRecord>;
  exportSkill: (skillId: string) => Promise<SkillExportResult>;
  deleteSkill: (skillId: string) => Promise<void>;
  createSkillProposal: (request: SkillProposalCreateRequest) => Promise<SkillProposalRecord>;
  createSkillPatchProposal: (request: SkillPatchRequest) => Promise<SkillProposalRecord>;
  listSkillProposals: (skillId?: string) => Promise<SkillProposalRecord[]>;
  applySkillProposal: (proposalId: string, acceptedPaths?: string[]) => Promise<SkillRecord>;
  rejectSkillProposal: (proposalId: string) => Promise<SkillProposalRecord>;
  listSkillSnapshots: (skillId: string) => Promise<SkillRollbackSnapshot[]>;
  restoreSkillSnapshot: (snapshotId: string) => Promise<SkillRecord>;
  runSkillEvals: (request: SkillEvalRunRequest) => Promise<SkillEvalRunRecord>;
  listSkillEvalRuns: (skillId: string) => Promise<SkillEvalRunRecord[]>;
  updateSkillLifecycle: (skillId: string, action: "pin" | "unpin" | "archive" | "restore") => Promise<SkillRecord>;
  installSkillFromGitHub: (request: SkillGitHubInstallRequest) => Promise<SkillRecord>;
  searchSkillRegistry: (request: SkillRegistrySearchRequest) => Promise<SkillRegistryEntry[]>;
  installSkillFromRegistry: (request: SkillRegistryInstallRequest) => Promise<SkillRecord>;
  verifySkill: (skillId: string) => Promise<SkillVerificationResult>;
  verifyAllSkills: () => Promise<SkillVerificationResult[]>;
  updateAllSkills: () => Promise<SkillUpdateAllResult>;
  adaptSkillImport: (request: SkillImportAdapterRequest) => Promise<SkillImportAdapterResult>;
  getSkillCredentials: (skillId: string) => Promise<SkillCredentialReport>;
  saveSkillCredentials: (request: SkillCredentialSaveRequest) => Promise<SkillCredentialReport>;
  exportSkillAuditLog: (request?: { skillId?: string; limit?: number }) => Promise<SkillAuditExport>;
  verifySkillAuditExport: (payload: SkillAuditExport) => Promise<SkillAuditExportVerification>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  validateProvider: (
    provider: ProviderName,
    settings: AppSettings
  ) => Promise<ProviderValidationResult>;
  getProviderHealth: (
    provider: ProviderName,
    settings: AppSettings
  ) => Promise<ProviderHealthResult>;
  onProviderModelsUpdated: (
    handler: (event: ProviderModelsUpdatedEvent) => void
  ) => () => void;
  onLibraryUpdated: (handler: (library: LibraryData) => void) => () => void;
  selectWorkspaceDirectory: () => Promise<string | null>;
  setWorkspaceDirectory: (workspaceDirectory: string) => Promise<string>;
  runWorkspaceCommand: (request: WorkspaceCommandRequest) => Promise<unknown>;
  getWorkspaceLogs: () => Promise<WorkspaceActionLog[]>;
  getWorkspaceStatus: () => Promise<WorkspaceStatusResponse>;
  getWorkspaceSnapshot: () => Promise<WorkspaceSnapshot | null>;
  approveToolCall: (
    toolCallId: string,
    approved: boolean,
    grantScope?: ApprovalGrantScope
  ) => Promise<ApprovalResponse>;
}

declare global {
  interface Window {
    superAgent: SuperAgentApi;
  }
}