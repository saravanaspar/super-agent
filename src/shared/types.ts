import type { JsonRecord, JsonValue } from "./json";

export type MessageRole =
  | "user"
  | "assistant"
  | "tool"
  | "thinking"
  | "progress"
  | "pattern"
  | "error";

export type MessageStatus = "complete" | "streaming" | "failed" | "blocked";

export type ApprovalGrantScope = "once" | "session_tool" | "session_exact_command";

export type ActivePermissionMode =
  | "ask_every_time"
  | "allow_safe_tools"
  | "manual_approval"
  | "full_access"
  | "deny_tools";

export type PermissionMode = ActivePermissionMode;

export type AgentKind = "general" | "browser" | "desktop" | "coding";
export type ProviderName = "groq" | "nvidia" | "ollama" | "llamaCpp" | "stub";
export type WorkspaceStatus = "idle" | "running" | "failed";
export type ToolRisk = "safe" | "medium" | "high";
export type ArtifactKind = "text" | "code";
export type ThemeMode = "light" | "dark" | "system";
export type AgentCommandName = "goal" | "review";

export interface AgentCommandInvocation {
  name: AgentCommandName;
  raw: string;
  input: string;
  goal: string;
  reviewTarget?: string;
}

export type AgenticPatternKey =
  | "known_path"
  | "unknown_path"
  | "sequential_workflow"
  | "parallel_dynamic_flow"
  | "tool_enabled_agent"
  | "pure_llm_agent"
  | "planning_pattern"
  | "react_pattern"
  | "quality_first_pattern"
  | "speed_first_pattern"
  | "single_agent_pattern";

export interface AgenticPatternChoice {
  question: string;
  answer: "yes" | "no" | "plan" | "explore";
  selected: AgenticPatternKey;
  rationale: string;
}

export interface AgenticPatternDecision {
  path: AgenticPatternChoice;
  flow: AgenticPatternChoice;
  tooling: AgenticPatternChoice;
  execution: AgenticPatternChoice;
  priority: AgenticPatternChoice;
  agents: AgenticPatternChoice;
  selectedPatterns: AgenticPatternKey[];
}

export interface AttachmentMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  textPreview?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string | null;
  workspaceDirectory?: string | null;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: string;
  metadata: JsonRecord;
  attachments?: AttachmentMetadata[];
}

export interface ModelOption {
  provider: ProviderName;
  model: string;
  label: string;
  supportsThinking: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ChatSubmitRequest {
  sessionId: string | null;
  prompt: string;
  model: ModelOption;
  permissionMode: PermissionMode;
  agentKind?: AgentKind;
  attachments: AttachmentMetadata[];
  command?: AgentCommandInvocation | null;
  selectedSkillIds?: string[];
  responseStreamingEnabled?: boolean;
}

export type RoutedChatSubmitRequest = ChatSubmitRequest & { agentKind: AgentKind };

export interface ToolCallRecord {
  id: string;
  name: string;
  risk: ToolRisk;
  input: JsonRecord;
}

export interface ToolResultRecord {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  risk: ToolRisk;
  blocked: boolean;
  message: string;
  data: JsonValue;
}

export type AssistantDeltaPhase = "progress" | "final";

export type StreamEvent =
  | { type: "session_created"; session: ChatSession }
  | { type: "turn_started"; sessionId: string; assistantMessageId: string }
  | { type: "message_created"; message: ChatMessage }
  | { type: "assistant_delta"; messageId: string; delta: string; phase?: AssistantDeltaPhase }
  | { type: "final_delta"; messageId: string; delta: string }
  | { type: "plan_delta"; messageId: string; delta: string }
  | { type: "reasoning_summary_delta"; messageId: string; delta: string }
  | { type: "reasoning_raw_delta"; delta: string }
  | { type: "thinking_delta"; messageId: string; delta: string }
  | {
      type: "pattern_decision";
      message: ChatMessage;
      decision: AgenticPatternDecision;
    }
  | { type: "progress"; message: ChatMessage }
  | { type: "tool_call"; message: ChatMessage; call: ToolCallRecord }
  | { type: "tool_started"; message: ChatMessage; call: ToolCallRecord }
  | { type: "permission_request"; call: ToolCallRecord; reason: string }
  | { type: "tool_result"; message: ChatMessage; result: ToolResultRecord }
  | { type: "tool_completed"; message: ChatMessage; result: ToolResultRecord }
  | { type: "error"; message: ChatMessage; error: string }
  | { type: "turn_completed"; sessionId: string; assistantMessageId: string }
  | { type: "done"; sessionId: string; assistantMessageId: string };

export interface WorkspaceActionLog {
  id: string;
  action: string;
  status: "ok" | "failed" | "blocked" | "running";
  detail: JsonRecord;
  createdAt: string;
}

export interface WorkspaceSnapshot {
  url: string;
  title: string;
  text: string;
  screenshotBase64?: string;
}

export interface ArtifactRecord {
  id: string;
  title: string;
  kind: ArtifactKind;
  path: string;
  contentType: string;
  createdAt: string;
  sessionId: string | null;
}

export type SkillContextSelectionMode = "manual" | "auto";

export type SkillFileEncoding = "utf8" | "base64";

export interface SkillFileRecord {
  path: string;
  content: string;
  encoding?: SkillFileEncoding | undefined;
}

export type SkillSource = "workspace" | "repo" | "user" | "plugin" | "global" | "built-in" | "local";
export type SkillTrustLevel = "built-in" | "verified" | "local" | "uploaded" | "community" | "untrusted" | "quarantined";
export type SkillRootKind = "workspace" | "repo" | "user" | "plugin" | "global" | "built-in";
export type SkillImportMode = "replace" | "copy";
export type SkillContextInjection = "instructions" | "catalog";
export type SkillLifecycleState = "active" | "stale" | "archived";
export type SkillVerificationStatus = "unverified" | "verified" | "failed";


export interface SkillRootDiagnostic {
  id: string;
  kind: SkillRootKind;
  path: string;
  rank: number;
  writable: boolean;
  watching: boolean;
  pluginId?: string | undefined;
  status: "active" | "missing" | "error";
  message?: string | undefined;
}

export interface SkillRootSyncResult {
  added: string[];
  removed: string[];
  updated: string[];
  unchanged: string[];
  active: number;
  shadowed: number;
  roots: SkillRootDiagnostic[];
}

export interface SkillScanFinding {
  severity: "info" | "warn" | "critical";
  ruleId: string;
  message: string;
  path?: string | undefined;
  line?: number | undefined;
  excerpt?: string | undefined;
}

export interface SkillDependencyPackage {
  manager: string;
  name: string;
  version?: string | undefined;
}

export interface SkillScriptPermissionMetadata {
  scriptPath: string;
  allowNetwork?: boolean | undefined;
  allowedEnv?: string[] | undefined;
  writeRoots?: string[] | undefined;
  allowedArgs?: string[] | undefined;
  maxRuntimeMs?: number | null | undefined;
}

export interface SkillPermissionMetadata {
  allowNetwork: boolean;
  allowedEnv: string[];
  writeRoots: string[];
  maxRuntimeMs: number | null;
  scripts?: SkillScriptPermissionMetadata[] | undefined;
}

export interface SkillDependencyMetadata {
  requiredBins: string[];
  requiredEnv: string[];
  requiredFiles: string[];
  packages: SkillDependencyPackage[];
  platforms: string[];
  permissions: SkillPermissionMetadata;
}

export interface SkillPreflightResult {
  ok: boolean;
  missingBins: string[];
  missingEnv: string[];
  missingFiles: string[];
  packages: SkillDependencyPackage[];
  incompatiblePlatforms: string[];
}

export interface SkillResourceManifestItem {
  path: string;
  type: "instructions" | "reference" | "script" | "asset" | "eval" | "other";
  size: number;
  tokenEstimate: number;
  whenToRead: string;
  language?: string | undefined;
  executable?: boolean | undefined;
  runHint?: string | undefined;
}

export interface SkillContextWarning {
  severity: "info" | "warn";
  code: string;
  message: string;
  skillId?: string | undefined;
  path?: string | undefined;
}

export interface SkillContextHeatmapItem {
  skillId: string;
  skillName: string;
  mode: SkillContextSelectionMode;
  path: string;
  type: SkillResourceManifestItem["type"] | "catalog";
  tokenEstimate: number;
  size: number;
  injected: boolean;
}

export interface SkillContextSnapshot {
  id: string;
  name: string;
  source: SkillSource;
  trustLevel: SkillTrustLevel;
  version: string | null;
  packageHash: string;
  injection: SkillContextInjection;
  injectedFiles: string[];
  contextTokens: number;
  score: number;
  matchedTerms: string[];
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  autoRouting: boolean;
  source: SkillSource;
  trustLevel: SkillTrustLevel;
  quarantineReason: string | null;
  scanFindings: SkillScanFinding[];
  dependencyMetadata: SkillDependencyMetadata;
  files: SkillFileRecord[];
  version: string | null;
  installedAt: string;
  updatedAt: string;
  packageSize: number;
  packageHash?: string | undefined;
  rootPath?: string | null | undefined;
  sourcePath?: string | null | undefined;
  sourceRank?: number | undefined;
  pluginId?: string | null | undefined;
  shadowedBy?: string | null | undefined;
  shadowReason?: string | null | undefined;
  writable?: boolean | undefined;
  lastUsedAt?: string | null | undefined;
  useCount?: number | undefined;
  lifecycleState?: SkillLifecycleState | undefined;
  pinned?: boolean | undefined;
  archivedAt?: string | null | undefined;
  staleReason?: string | null | undefined;
  originUrl?: string | null | undefined;
  sourceArchiveUrl?: string | null | undefined;
  sourceSubpath?: string | null | undefined;
  registryUrl?: string | null | undefined;
  publisher?: string | null | undefined;
  expectedPackageHash?: string | null | undefined;
  signature?: string | null | undefined;
  publicKey?: string | null | undefined;
  verifiedAt?: string | null | undefined;
  verificationStatus?: SkillVerificationStatus | undefined;
}

export interface SkillUpdateRequest {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  autoRouting?: boolean | undefined;
  files?: SkillFileRecord[] | undefined;
  version?: string | null | undefined;
}


export type SkillProposalStatus = "pending" | "applied" | "rejected" | "quarantined";
export type SkillProposalSource = "agent" | "user" | "tool";
export type SkillProposalOperation = "create" | "update" | "delete";

export interface SkillFileDiff {
  path: string;
  status: "added" | "changed" | "deleted" | "unchanged";
  beforeSize: number;
  afterSize: number;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface SkillQualityReviewFinding {
  severity: "info" | "warn" | "critical";
  code: string;
  message: string;
  path?: string | undefined;
}

export interface SkillQualityReview {
  passed: boolean;
  score: number;
  summary: string;
  findings: SkillQualityReviewFinding[];
}

export interface SkillProposalRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  skillId: string;
  skillName: string;
  title: string;
  reason: string;
  source: SkillProposalSource;
  status: SkillProposalStatus;
  operation: SkillProposalOperation;
  proposedFiles: SkillFileRecord[];
  basePackageHash: string | null;
  targetPackageHash: string;
  diff: SkillFileDiff[];
  scanFindings: SkillScanFinding[];
  review: SkillQualityReview;
  quarantineReason: string | null;
}

export interface SkillRollbackSnapshot {
  id: string;
  skillId: string;
  skillName: string;
  createdAt: string;
  reason: string;
  packageHash: string;
  files: SkillFileRecord[];
}

export interface SkillProposalCreateRequest {
  skillId?: string | undefined;
  title: string;
  reason: string;
  source?: SkillProposalSource | undefined;
  operation?: SkillProposalOperation | undefined;
  files: SkillFileRecord[];
}

export interface SkillPatchOperation {
  op: "create" | "update" | "delete" | "rename";
  path: string;
  content?: string | undefined;
  toPath?: string | undefined;
}

export interface SkillPatchRequest {
  skillId: string;
  title: string;
  reason: string;
  operations: SkillPatchOperation[];
  source?: SkillProposalSource | undefined;
}

export interface SkillImportRequest {
  filename: string;
  dataBase64: string;
  installMode?: SkillImportMode | undefined;
}

export interface SkillImportPreviewSkill {
  id: string;
  name: string;
  description: string;
  version: string | null;
  fileCount: number;
  packageSize: number;
  trustLevel: SkillTrustLevel;
  scanFindings: SkillScanFinding[];
  originUrl?: string | null | undefined;
  sourceArchiveUrl?: string | null | undefined;
  sourceSubpath?: string | null | undefined;
  publisher?: string | null | undefined;
  expectedPackageHash?: string | null | undefined;
  signature?: string | null | undefined;
  publicKey?: string | null | undefined;
}

export interface SkillImportValidationIssue {
  code: string;
  message: string;
  path?: string | undefined;
}

export interface SkillImportValidationResult {
  filename: string;
  packageSize: number;
  valid: boolean;
  skill: SkillImportPreviewSkill | null;
  existingSkillId: string | null;
  errors: SkillImportValidationIssue[];
  warnings: SkillImportValidationIssue[];
  files: Array<{ path: string; size: number }>;
  dependencyMetadata: SkillDependencyMetadata;
}

export interface SkillExportManifest {
  schemaVersion: 1;
  skillId: string;
  name: string;
  description: string;
  version: string | null;
  source: SkillSource;
  trustLevel: SkillTrustLevel;
  packageHash: string;
  packageSize: number;
  exportedAt: string;
  installedAt: string;
  updatedAt: string;
  fileCount: number;
  dependencies: SkillDependencyMetadata;
  scanFindings: SkillScanFinding[];
  originUrl?: string | null | undefined;
  sourceArchiveUrl?: string | null | undefined;
  sourceSubpath?: string | null | undefined;
  publisher?: string | null | undefined;
  expectedPackageHash?: string | null | undefined;
  signature?: string | null | undefined;
}

export interface SkillExportResult {
  filename: string;
  dataBase64: string;
  mimeType: string;
  manifest: SkillExportManifest;
}

export interface SkillGitHubInstallRequest {
  url: string;
  installMode?: SkillImportMode | undefined;
  skillPath?: string | undefined;
}

export interface SkillRegistrySearchRequest {
  registryUrl: string;
  query?: string | undefined;
}

export interface SkillRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string | null;
  archiveUrl: string;
  publisher: string | null;
  packageHash: string | null;
  signature: string | null;
  publicKey: string | null;
  tags: string[];
}

export interface SkillRegistryInstallRequest {
  registryUrl: string;
  entryId: string;
  installMode?: SkillImportMode | undefined;
}

export interface SkillVerificationResult {
  skillId: string;
  status: SkillVerificationStatus;
  packageHash: string;
  expectedHash: string | null;
  signatureValid: boolean | null;
  publisher: string | null;
  originUrl: string | null;
  findings: SkillQualityReviewFinding[];
  verifiedAt: string;
}

export interface SkillUpdateCandidate {
  skillId: string;
  name: string;
  originUrl: string | null;
  currentHash: string;
  remoteHash: string | null;
  status: "current" | "update_available" | "missing_origin" | "fetch_failed" | "invalid";
  message: string;
  proposalId?: string | null | undefined;
}

export interface SkillUpdateAllResult {
  checked: SkillUpdateCandidate[];
  proposalsCreated: SkillProposalRecord[];
}

export type SkillImportAdapterKind = "claude" | "codex" | "openclaw" | "hermes" | "auto";

export interface SkillImportAdapterRequest {
  layout: SkillImportAdapterKind;
  files: SkillFileRecord[];
}

export interface SkillImportAdapterResult {
  layout: Exclude<SkillImportAdapterKind, "auto">;
  packages: Array<{
    id: string;
    name: string;
    description: string;
    files: SkillFileRecord[];
    warnings: SkillImportValidationIssue[];
  }>;
  conflicts: SkillImportValidationIssue[];
}

export interface SkillEvalOutputInput {
  id: string;
  output: string;
}

export interface SkillEvalRunRequest {
  skillId: string;
  outputs?: SkillEvalOutputInput[] | undefined;
  baselineRunId?: string | undefined;
}

export interface SkillEvalCaseResult {
  id: string;
  prompt: string;
  status: "passed" | "failed" | "warning";
  score: number;
  findings: SkillQualityReviewFinding[];
}

export interface SkillEvalRunRecord {
  id: string;
  skillId: string;
  skillName: string;
  packageHash: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed" | "warning";
  score: number;
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  baselineRunId: string | null;
  baselineScore: number | null;
  deltaScore: number | null;
  results: SkillEvalCaseResult[];
}


export interface SkillContextReference {
  id: string;
  name: string;
  description: string;
  mode: SkillContextSelectionMode;
  tokenEstimate: number;
  score: number;
  matchedTerms: string[];
  injection: SkillContextInjection;
  reason: string;
  packageHash: string;
  injectedFiles: string[];
  manifest?: SkillResourceManifestItem[] | undefined;
  warnings?: SkillContextWarning[] | undefined;
}

export interface SkillScriptRunHistory {
  id: string;
  skillId: string;
  skillName: string;
  scriptPath: string;
  args: string[];
  cwd: string;
  command: string;
  status: "ok" | "failed" | "timed_out" | "spawn_error";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  actor: "agent" | "user";
  packageHash: string;
  scriptHash: string;
  envKeys: string[];
}

export interface SkillAuditLogRecord {
  id: string;
  createdAt: string;
  action: string;
  skillId: string | null;
  skillName: string | null;
  actor: "agent" | "user" | "system";
  status: "ok" | "failed" | "blocked" | "warning";
  packageHash: string | null;
  detail: JsonRecord;
}

export interface SkillAuditExport {
  schemaVersion: 1;
  exportedAt: string;
  scope: { skillId?: string | undefined; limit: number };
  events: SkillAuditLogRecord[];
  firstHash: string | null;
  lastHash: string | null;
  exportHash: string;
}

export interface SkillAuditExportVerification {
  ok: boolean;
  eventCount: number;
  firstHash: string | null;
  lastHash: string | null;
  exportHash: string | null;
  errors: string[];
}

export interface SkillCredentialReport {
  skillId: string;
  skillName: string;
  storagePath: string;
  encryptionAvailable: boolean;
  requiredEnv: Array<{ name: string; configured: boolean; source: "stored" | "missing"; secret: true }>;
  requiredFiles: Array<{ path: string; configuredPath: string | null; exists: boolean }>;
  instructions: string[];
}

export interface SkillCredentialSaveRequest {
  skillId: string;
  env?: Record<string, string> | undefined;
  files?: Record<string, string> | undefined;
}


export interface McpConnectorInstallRequest {
  name: string;
  url: string;
  bearerToken?: string | undefined;
  autoStart?: boolean | undefined;
}

export interface McpConnectorToolPreview {
  name: string;
  description: string;
}

export interface McpConnectorInstallResult {
  serverId: string;
  configPath: string;
  toolCount: number;
  tools: McpConnectorToolPreview[];
  message: string;
}

export interface LibrarySection<T> {
  key: string;
  title: string;
  status: "complete" | "partial";
  description: string;
  items: T[];
}

export interface LibraryData {
  plugins: LibrarySection<JsonRecord>;
  skills: LibrarySection<SkillRecord>;
  mcp: LibrarySection<JsonRecord>;
  artifacts: LibrarySection<ArtifactRecord>;
  tools: LibrarySection<JsonRecord>;
  prompts: LibrarySection<JsonRecord>;
  models: LibrarySection<ModelOption>;
}

export interface AppSettings {
  theme: ThemeMode;
  defaultProvider: ProviderName;
  defaultModel: string;
  groqApiKey: string;
  groqBaseUrl: string;
  nvidiaApiKey: string;
  nvidiaBaseUrl: string;
  ollamaBaseUrl: string;
  llamaCppBaseUrl: string;
  agentOutsideWorkspaceAccess: boolean;
  agentPrivateNetworkAccess: boolean;
  agentShellSandboxEnabled: boolean;
  agentStreamingEnabled: boolean;
}

export interface AgentBehaviorSettings {
  allowOutsideWorkspaceAccess: boolean;
  allowPrivateNetworkAccess: boolean;
  useShellSandbox: boolean;
}


export type ProviderHealthStatus = "online" | "loading" | "offline" | "unknown";

export interface ProviderHealthResult {
  provider: ProviderName;
  status: ProviderHealthStatus;
  endpoint: string;
  message: string;
  details: JsonRecord;
}

export interface ProviderValidationResult {
  provider: ProviderName;
  ok: boolean;
  message: string;
  warning?: string;
  models: ModelOption[];
}

export interface ProviderModelsUpdatedEvent {
  provider: ProviderName;
  models: ModelOption[];
  message: string;
}

export interface AppBootstrapState {
  sessions: ChatSession[];
  models: ModelOption[];
  library: LibraryData;
  workspaceStatus: WorkspaceStatus;
  workspaceUrl: string;
  workspaceDirectory: string;
  workspaceLogs: WorkspaceActionLog[];
  workspaceSnapshot: WorkspaceSnapshot | null;
  settings: AppSettings;
  testProviderEnabled: boolean;
}