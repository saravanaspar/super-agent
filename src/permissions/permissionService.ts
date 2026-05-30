import path from "node:path";
import type {
  AgentBehaviorSettings,
  AgentCommandName,
  PermissionMode,
  ApprovalGrantScope,
  ToolCallRecord,
  ToolRisk
} from "@shared/types";
import {
  HARD_BLOCK_EXACT_PATHS,
  HARD_BLOCK_PATH_PREFIXES,
  PACKAGE_INSTALL_PATTERN
} from "@tools/general/constants";

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  effectiveRisk: ToolRisk;
}

const destructiveShellPattern =
  /\b(mkfs|dd\s+if=|shutdown|reboot|poweroff|su\s|curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash))\b/i;

const destructiveRmPattern = /\brm\s+-[\w-]*r[f\w-]*\s+(\/|~|\.\.)(\s|$)/i;
const sudoPattern = /(^|[\s;&|])sudo(\s|$)/i;
const shellControlPattern = /[`$()<>|]/;
const shellSegmentSeparator = /\s*(?:&&|;|\|\|)\s*/;

const readOnlyTools = new Set([
  "read_file",
  "ls",
  "exists",
  "grep",
  "project_index",
  "query_context",
  "workspace.status",
  "workspace.path",
  "browser.snapshot",
  "list_processes",
  "stop_process",
  "mcp.status"
]);

const workspaceWriteTools = new Set([
  "write_file",
  "edit_file",
  "edit_range",
  "append_file",
  "mkdir",
  "artifact.create"
]);

const destructiveWorkspaceTools = new Set(["rm"]);

const explicitApprovalTools = new Set(["skill.run_script"]);

const fileBoundaryTools = new Set([
  ...readOnlyTools,
  ...workspaceWriteTools,
  ...destructiveWorkspaceTools
]);

const defaultAgentSettings: AgentBehaviorSettings = {
  allowOutsideWorkspaceAccess: false,
  allowPrivateNetworkAccess: false,
  useShellSandbox: false
};

const safeShellSegmentPatterns = [
  /^pwd$/,
  /^whoami$/,
  /^date$/,
  /^node\s+(-v|--version)$/,
  /^ls(?:\s+[-\w./]+)*$/,
  /^find\s+[\w./-]+(?:\s+[-\w./*]+)*$/,
  /^rg\s+.+$/,
  /^grep\s+.+$/,
  /^wc\s+.+$/,
  /^git\s+(status|diff|log|show|branch)(?:\s+.+)?$/,
  /^npm\s+(ci|install|i)(?:\s+.+)?$/,
  /^npm\s+(test|run\s+(test|test:e2e|e2e|typecheck|lint|check|verify|build))(?:\s+.+)?$/,
  /^pnpm\s+(install|i)(?:\s+.+)?$/,
  /^pnpm\s+(test|run\s+(test|test:e2e|e2e|typecheck|lint|check|verify|build))(?:\s+.+)?$/,
  /^yarn\s+(install)(?:\s+.+)?$/,
  /^yarn\s+(test|test:e2e|e2e|typecheck|lint|check|verify|build|run\s+(test|test:e2e|e2e|typecheck|lint|check|verify|build))(?:\s+.+)?$/,
  /^bun\s+(install|test|run\s+(test|test:e2e|e2e|typecheck|lint|check|verify|build))(?:\s+.+)?$/,
  /^npx\s+(vitest|tsc|eslint|playwright|cypress)(?:\s+.+)?$/,
  /^vitest(?:\s+.+)?$/,
  /^tsc(?:\s+.+)?$/,
  /^eslint(?:\s+.+)?$/,
  /^pytest(?:\s+.+)?$/,
  /^python3?\s+-m\s+(pytest|compileall|pip\s+install)(?:\s+.+)?$/,
  /^pip3?\s+install(?:\s+.+)?$/,
  /^uv\s+(sync|add|pip\s+install|run\s+pytest|run\s+python)(?:\s+.+)?$/,
  /^go\s+test(?:\s+.+)?$/,
  /^cargo\s+test(?:\s+.+)?$/,
  /^make\s+(test|check|lint)(?:\s+.+)?$/
];

const pathFromInput = (input: Record<string, unknown>): string => {
  const value =
    input.relativePath ?? input.path ?? input.filePath ?? input.cwd ?? "";
  return typeof value === "string" ? value : "";
};

const commandFromInput = (input: Record<string, unknown>): string => {
  const command = input.command;
  return typeof command === "string" ? command.trim() : "";
};


const normalizeForPolicy = (value: string, workspaceDir?: string): string => {
  if (!value.trim()) return "";
  if (path.isAbsolute(value)) return path.resolve(value);
  return path.resolve(workspaceDir || process.cwd(), value);
};

const isInsideWorkspace = (value: string, workspaceDir?: string): boolean => {
  if (!value.trim()) return true;
  const workspace = path.resolve(workspaceDir || process.cwd());
  const target = normalizeForPolicy(value, workspace);
  const relation = path.relative(workspace, target);
  return relation === "" || (!relation.startsWith("..") && !path.isAbsolute(relation));
};

const isExternalMediaWorkspace = (workspaceDir?: string): boolean => {
  if (!workspaceDir) return false;

  const workspace = path.resolve(workspaceDir);
  const allowedMountRoots =
    process.platform === "darwin"
      ? ["/Volumes"]
      : ["/run/media", "/media", "/mnt"];

  return allowedMountRoots.some(
    (root) => workspace === root || workspace.startsWith(`${root}/`)
  );
};

const isSelectedWorkspacePath = (value: string, workspaceDir?: string): boolean => {
  if (!workspaceDir || !value.trim()) return false;

  const workspace = path.resolve(workspaceDir);
  if (workspace === path.parse(workspace).root) return false;
  if (HARD_BLOCK_EXACT_PATHS.has(workspace)) return false;

  return isInsideWorkspace(value, workspace);
};

const matchesHardBlockedPath = (value: string, workspaceDir?: string): boolean => {
  const normalized = normalizeForPolicy(value, workspaceDir);
  if (!normalized) return false;

  if (HARD_BLOCK_EXACT_PATHS.has(normalized)) return true;

  return HARD_BLOCK_PATH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
};

const isHardBlockedPath = (value: string, workspaceDir?: string): boolean => {
  if (!matchesHardBlockedPath(value, workspaceDir)) return false;

  /*
   * A selected project directory must be usable even when it lives on a mounted
   * drive such as /run/media/<user>/<drive>/project. The previous policy treated
   * the broad /run prefix as always protected, so harmless ls/read_file calls
   * inside the selected project were blocked.
   */
  if (
    isSelectedWorkspacePath(value, workspaceDir) &&
    isExternalMediaWorkspace(workspaceDir)
  ) {
    return false;
  }

  return true;
};

const isShellTool = (toolName: string): boolean =>
  toolName === "bash";

const canonicalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeValue(item)])
  );
};

const stableJson = (value: unknown): string =>
  JSON.stringify(canonicalizeValue(value));

const exactGrantFingerprint = (call: ToolCallRecord): string => {
  if (isShellTool(call.name)) {
    const command = commandFromInput(call.input);
    const cwd = pathFromInput(call.input);
    return stableJson({ name: call.name, command, cwd });
  }

  return stableJson({ name: call.name, input: call.input });
};

const sessionToolGrantKey = (sessionId: string, toolName: string): string =>
  `${sessionId}:tool:${toolName}`;

const sessionExactGrantKey = (
  sessionId: string,
  call: ToolCallRecord
): string => `${sessionId}:exact:${exactGrantFingerprint(call)}`;

const toolTargetsOutsideWorkspace = (
  call: ToolCallRecord,
  workspaceDir?: string
): boolean => {
  const targetPath = pathFromInput(call.input);
  return Boolean(
    targetPath &&
      fileBoundaryTools.has(call.name) &&
      !isInsideWorkspace(targetPath, workspaceDir)
  );
};

const isSafeBrowserNavigation = (call: ToolCallRecord): boolean => {
  if (call.name !== "browser.navigate") return false;

  const rawUrl = call.input.url;
  if (typeof rawUrl !== "string") return false;

  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "about:" && parsed.href === "about:blank";
  } catch {
    return false;
  }
};

const isDangerousCommand = (command: string): boolean =>
  destructiveShellPattern.test(command) || destructiveRmPattern.test(command);

const isSudoCommand = (command: string): boolean => sudoPattern.test(command);

const commandTouchesHardBlockedPath = (
  command: string,
  workspaceDir?: string
): boolean => {
  if (!command) return false;

  for (const blockedPath of HARD_BLOCK_EXACT_PATHS) {
    if (command.includes(blockedPath)) return true;
  }

  for (const prefix of HARD_BLOCK_PATH_PREFIXES) {
    if (command.includes(prefix)) {
      if (isExternalMediaWorkspace(workspaceDir) && prefix === "/run") {
        continue;
      }

      return true;
    }
  }

  return false;
};

const isSafeShellSegment = (segment: string): boolean => {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  return safeShellSegmentPatterns.some((pattern) => pattern.test(trimmed));
};

const isAutoSafeShellCommand = (
  command: string,
  workspaceDir?: string,
  cwd?: string
): boolean => {
  if (!command || shellControlPattern.test(command.replace(/&&|\|\|/g, ""))) {
    return false;
  }

  const cwdInsideWorkspace = !cwd || isInsideWorkspace(cwd, workspaceDir);

  if (
    !cwdInsideWorkspace ||
    isDangerousCommand(command) ||
    isSudoCommand(command) ||
    PACKAGE_INSTALL_PATTERN.test(command) ||
    commandTouchesHardBlockedPath(command, workspaceDir)
  ) {
    return false;
  }

  return command.split(shellSegmentSeparator).every(isSafeShellSegment);
};

const forceEffectiveRisk = (
  call: ToolCallRecord,
  workspaceDir?: string
): ToolRisk => {
  const targetPath = pathFromInput(call.input);

  if (isShellTool(call.name)) {
    const command = commandFromInput(call.input);
    if (isAutoSafeShellCommand(command, workspaceDir, targetPath)) {
      return "safe";
    }
    return "high";
  }

  if (readOnlyTools.has(call.name)) {
    if (toolTargetsOutsideWorkspace(call, workspaceDir)) return "high";
    return "safe";
  }

  if (isSafeBrowserNavigation(call)) {
    return "safe";
  }

  if (workspaceWriteTools.has(call.name)) {
    if (targetPath && !isInsideWorkspace(targetPath, workspaceDir)) return "high";
    return "safe";
  }

  if (destructiveWorkspaceTools.has(call.name)) return "high";

  return call.risk;
};

const blockedRegardlessOfMode = (
  call: ToolCallRecord,
  workspaceDir?: string,
  settings: AgentBehaviorSettings = defaultAgentSettings
): string | null => {
  const targetPath = pathFromInput(call.input);
  const command = commandFromInput(call.input);

  if (targetPath && isHardBlockedPath(targetPath, workspaceDir)) {
    return "Blocked because the target path is always protected.";
  }

  if (
    toolTargetsOutsideWorkspace(call, workspaceDir) &&
    settings.allowOutsideWorkspaceAccess !== true
  ) {
    return "Blocked because Agent settings do not allow tools to access paths outside the workspace.";
  }

  if (isShellTool(call.name) && commandTouchesHardBlockedPath(command, workspaceDir)) {
    return "Blocked because the shell command references an always-protected path.";
  }

  if (isShellTool(call.name) && isSudoCommand(command)) {
    return "Blocked because sudo commands are not allowed.";
  }

  if (isShellTool(call.name) && isDangerousCommand(command)) {
    return "Blocked because the shell command matches a destructive command pattern.";
  }

  return null;
};

export class PermissionService {
  private readonly sessionGrants = new Set<string>();

  rememberSessionGrant(
    sessionId: string | null | undefined,
    call: ToolCallRecord,
    grantScope: ApprovalGrantScope
  ): void {
    if (!sessionId || grantScope === "once") return;

    const grantKey = grantScope === "session_tool"
      ? sessionToolGrantKey(sessionId, call.name)
      : sessionExactGrantKey(sessionId, call);

    this.sessionGrants.add(grantKey);
  }

  clearSessionGrants(sessionId?: string): void {
    if (!sessionId) {
      this.sessionGrants.clear();
      return;
    }

    for (const grantKey of [...this.sessionGrants]) {
      if (grantKey.startsWith(`${sessionId}:`)) {
        this.sessionGrants.delete(grantKey);
      }
    }
  }

  private hasSessionGrant(
    sessionId: string | null | undefined,
    call: ToolCallRecord
  ): boolean {
    if (!sessionId) return false;

    return (
      this.sessionGrants.has(sessionToolGrantKey(sessionId, call.name)) ||
      this.sessionGrants.has(sessionExactGrantKey(sessionId, call))
    );
  }

  decide(
    call: ToolCallRecord,
    mode: PermissionMode,
    workspaceDir?: string,
    settings: AgentBehaviorSettings = defaultAgentSettings,
    _activeCommand?: AgentCommandName | null,
    sessionId?: string | null
  ): PermissionDecision {
    const effectiveRisk = forceEffectiveRisk(call, workspaceDir);
    const unconditionalBlock = blockedRegardlessOfMode(
      call,
      workspaceDir,
      settings
    );
    if (unconditionalBlock) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: unconditionalBlock,
        effectiveRisk
      };
    }

    if (mode === "deny_tools") {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "Tool execution is disabled.",
        effectiveRisk
      };
    }

    if (this.hasSessionGrant(sessionId, call)) {
      return {
        allowed: true,
        requiresApproval: false,
        reason: "Session approval grant allowed this tool call.",
        effectiveRisk
      };
    }

    if (mode === "ask_every_time") {
      return {
        allowed: false,
        requiresApproval: true,
        reason: "Ask every time mode requires approval for this tool.",
        effectiveRisk
      };
    }

    if (mode === "manual_approval") {
      if (effectiveRisk === "safe") {
        return {
          allowed: true,
          requiresApproval: false,
          reason: "Manual approval mode allowed a safe workspace or read-only tool.",
          effectiveRisk
        };
      }

      return {
        allowed: false,
        requiresApproval: true,
        reason: "Manual approval mode requires approval for this risky tool.",
        effectiveRisk
      };
    }

    if (mode === "full_access") {
      return {
        allowed: true,
        requiresApproval: false,
        reason: "Full access mode allowed the tool inside safety boundaries.",
        effectiveRisk
      };
    }

    if (explicitApprovalTools.has(call.name)) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: "Skill scripts require explicit approval before execution unless full access mode is enabled.",
        effectiveRisk
      };
    }

    if (effectiveRisk === "safe") {
      return {
        allowed: true,
        requiresApproval: false,
        reason: "Auto review allowed a safe workspace or read-only tool.",
        effectiveRisk
      };
    }

    return {
      allowed: false,
      requiresApproval: true,
      reason: "Auto review requires approval for this risky tool.",
      effectiveRisk
    };
  }
}