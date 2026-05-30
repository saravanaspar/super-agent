import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonRecord } from "@shared/json";
import { redactSensitiveText } from "@shared/redaction";
import { validateGeneratedSkillQuality } from "@skills-system/skillValidation";
import { skillFileText, skillFileToBuffer } from "@skills-system/skillFileData";
import type {
  SkillEvalRunRecord,
  SkillFileRecord,
  SkillImportMode,
  SkillProposalRecord,
  SkillRecord,
  SkillResourceManifestItem,
  SkillScriptRunHistory,
} from "@shared/types";
import type { ToolDefinition } from "@tool-registry/types";
import { DEFAULT_SHELL_MAX_OUTPUT_BYTES, DEFAULT_SHELL_TIMEOUT_MS } from "./constants";
import {
  linuxSkillScriptSandboxArgs,
  shellSandboxBackendStatus as linuxSandboxStatus,
} from "../linux/shellSandboxBackend";
import {
  macosSkillScriptSandboxArgs,
  shellSandboxBackendStatus as macosSandboxStatus,
} from "../macos/shellSandboxBackend";
import {
  shellSandboxBackendStatus as windowsSandboxStatus,
  windowsSkillScriptSandboxArgs,
} from "../windows/shellSandboxBackend";
import { assertNotSkippedWorkspacePath, resolveExistingPath } from "./pathSafety";
import { appendBoundedOutput } from "./shellOutput";
import {
  MAX_SKILL_SCRIPT_TIMEOUT_MS,
  SCRIPT_NETWORK_TOKENS,
  type InstallSkillInput,
  type RunSkillScriptInput,
} from "./skillToolSchemas";

export const manifestItemToJson = (item: SkillResourceManifestItem): JsonRecord => ({
  path: item.path,
  type: item.type,
  size: item.size,
  tokenEstimate: item.tokenEstimate,
  whenToRead: item.whenToRead,
  ...(item.language ? { language: item.language } : {}),
  ...(typeof item.executable === "boolean" ? { executable: item.executable } : {}),
  ...(item.runHint ? { runHint: item.runHint } : {}),
});



export const scanFindingToJson = (finding: { severity: string; ruleId: string; message: string; path?: string | undefined; line?: number | undefined; excerpt?: string | undefined }): JsonRecord => ({
  severity: finding.severity,
  ruleId: finding.ruleId,
  message: finding.message,
  ...(finding.path ? { path: finding.path } : {}),
  ...(typeof finding.line === "number" ? { line: finding.line } : {}),
  ...(finding.excerpt ? { excerpt: finding.excerpt } : {}),
});

export const reviewFindingToJson = (finding: { severity: string; code: string; message: string; path?: string | undefined }): JsonRecord => ({
  severity: finding.severity,
  code: finding.code,
  message: finding.message,
  ...(finding.path ? { path: finding.path } : {}),
});

export const evalRunToJson = (run: SkillEvalRunRecord): JsonRecord => ({
  id: run.id,
  skillId: run.skillId,
  skillName: run.skillName,
  packageHash: run.packageHash,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  status: run.status,
  score: run.score,
  total: run.total,
  passed: run.passed,
  failed: run.failed,
  warnings: run.warnings,
  baselineRunId: run.baselineRunId,
  baselineScore: run.baselineScore,
  deltaScore: run.deltaScore,
  results: run.results.map((item) => ({
    id: item.id,
    prompt: item.prompt,
    status: item.status,
    score: item.score,
    findings: item.findings.map(reviewFindingToJson),
  })),
});

export const proposalToJson = (proposal: SkillProposalRecord): JsonRecord => ({
  id: proposal.id,
  skillId: proposal.skillId,
  skillName: proposal.skillName,
  title: proposal.title,
  reason: proposal.reason,
  source: proposal.source,
  status: proposal.status,
  operation: proposal.operation,
  createdAt: proposal.createdAt,
  updatedAt: proposal.updatedAt,
  basePackageHash: proposal.basePackageHash,
  targetPackageHash: proposal.targetPackageHash,
  quarantineReason: proposal.quarantineReason,
  diff: proposal.diff.map((item) => ({ ...item })),
  scanFindings: proposal.scanFindings.map(scanFindingToJson),
  review: {
    passed: proposal.review.passed,
    score: proposal.review.score,
    summary: proposal.review.summary,
    findings: proposal.review.findings.map(reviewFindingToJson),
  },
});

export const skillPermissionsToJson = (skill: SkillRecord): JsonRecord => ({
  allowNetwork: skill.dependencyMetadata.permissions.allowNetwork,
  allowedEnv: skill.dependencyMetadata.permissions.allowedEnv,
  writeRoots: skill.dependencyMetadata.permissions.writeRoots,
  maxRuntimeMs: skill.dependencyMetadata.permissions.maxRuntimeMs,
});

interface ScriptPermissionOverride {
  allowNetwork?: boolean;
  allowedEnv?: string[];
  writeRoots?: string[];
  maxRuntimeMs?: number;
  allowedArgs?: string[];
}

const inlineList = (value: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return trimmed ? [trimmed.replace(/^['"]|['"]$/g, "")] : [];
  return trimmed.slice(1, -1).split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
};

const scriptPermissionOverride = (skill: SkillRecord, scriptPath: string): ScriptPermissionOverride => {
  const metadataPolicy = skill.dependencyMetadata.permissions.scripts?.find(
    (item) => normalizeSkillFilePath(item.scriptPath) === scriptPath,
  );
  if (metadataPolicy) {
    return {
      ...(typeof metadataPolicy.allowNetwork === "boolean" ? { allowNetwork: metadataPolicy.allowNetwork } : {}),
      ...(metadataPolicy.allowedEnv ? { allowedEnv: metadataPolicy.allowedEnv } : {}),
      ...(metadataPolicy.writeRoots ? { writeRoots: metadataPolicy.writeRoots } : {}),
      ...(metadataPolicy.allowedArgs ? { allowedArgs: metadataPolicy.allowedArgs } : {}),
      ...(typeof metadataPolicy.maxRuntimeMs === "number" ? { maxRuntimeMs: metadataPolicy.maxRuntimeMs } : {}),
    };
  }
  const root = skill.files.find((file) => normalizeSkillFilePath(file.path) === "SKILL.md");
  const content = root ? skillFileText(root) : "";
  const lines = content.split(/\r?\n/);
  const result: ScriptPermissionOverride = {};
  let inTarget = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed === `${scriptPath}:` || trimmed === `"${scriptPath}":` || trimmed === `'${scriptPath}':`) {
      inTarget = true;
      continue;
    }
    if (inTarget && !line.startsWith(" ") && !line.startsWith("	")) break;
    if (!inTarget || !trimmed.includes(":")) continue;
    const [rawKey, ...rest] = trimmed.split(":");
    const key = (rawKey ?? "").trim().replace(/-/g, "_");
    const value = rest.join(":").trim();
    if (key === "allow_network") result.allowNetwork = ["true", "yes", "1"].includes(value.toLowerCase());
    if (key === "allowed_env") result.allowedEnv = inlineList(value);
    if (key === "write_roots") result.writeRoots = inlineList(value);
    if (key === "allowed_args") result.allowedArgs = inlineList(value);
    if (key === "max_runtime_ms") {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) result.maxRuntimeMs = parsed;
    }
  }
  return result;
};


const executableNames = (bin: string): string[] => {
  if (process.platform !== "win32") return [bin];
  const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return /\.[A-Za-z0-9]+$/.test(bin)
    ? [bin]
    : [bin, ...extensions.map((ext) => `${bin}${ext.toLowerCase()}`)];
};

const canResolveCommand = (command: string): boolean => {
  if (isAbsolute(command)) return true;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of executableNames(command)) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        // keep scanning PATH
      }
    }
  }
  return false;
};

const scriptContentHash = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const scriptTokens = (content: string): string[] =>
  content.toLowerCase().split(/[^a-z0-9_.:/-]+/).filter(Boolean);

const scriptUsesNetwork = (content: string): boolean => {
  const lower = content.toLowerCase();
  const tokens = new Set(scriptTokens(content));
  return SCRIPT_NETWORK_TOKENS.some((token) => token.includes("://") ? lower.includes(token) : tokens.has(token));
};

const scriptUsesSudo = (content: string): boolean => scriptTokens(content).includes("sudo");

const allowedEnvNames = (skill: SkillRecord): string[] =>
  Array.from(new Set([
    ...skill.dependencyMetadata.requiredEnv,
    ...skill.dependencyMetadata.permissions.allowedEnv,
  ].filter(Boolean))).sort((a, b) => a.localeCompare(b));

const insideDirectory = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"));
};

const assertCwdPolicy = (workspaceDir: string, cwd: string): void => {
  assertNotSkippedWorkspacePath(workspaceDir, cwd);
};

const assertCwdWithinWriteRoots = (workspaceDir: string, cwd: string, writeRoots: string[]): void => {
  const roots = writeRoots.length ? writeRoots : ["."];
  const allowed = roots.some((root) => {
    const resolvedRoot = resolve(workspaceDir, root);
    return insideDirectory(resolvedRoot, cwd);
  });
  if (!allowed) {
    throw new Error("Skill script cwd is outside the write roots declared by skill policy.");
  }
};

const MAX_SKILL_SCRIPT_ARGS = 64;
const MAX_SKILL_SCRIPT_ARG_LENGTH = 8_192;

const normalizeWriteRootsForSandbox = (workspaceDir: string, writeRoots: string[]): string[] => {
  const roots = writeRoots.length ? writeRoots : ["."];
  const normalized: string[] = [];
  for (const root of roots) {
    if (!root || root.includes("\0")) {
      throw new Error("Skill script write_roots contains an invalid path.");
    }
    const resolvedRoot = resolve(workspaceDir, root);
    if (!insideDirectory(workspaceDir, resolvedRoot)) {
      throw new Error("Skill script write_roots must stay inside the workspace.");
    }
    const relativeRoot = relative(workspaceDir, resolvedRoot) || ".";
    normalized.push(relativeRoot);
  }
  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
};

const validateScriptArgs = (args: string[]): void => {
  if (args.length > MAX_SKILL_SCRIPT_ARGS) {
    throw new Error(`Skill script argument count exceeds ${MAX_SKILL_SCRIPT_ARGS}.`);
  }
  for (const arg of args) {
    if (arg.includes("\0")) throw new Error("Skill script arguments cannot contain NUL bytes.");
    if (arg.length > MAX_SKILL_SCRIPT_ARG_LENGTH) {
      throw new Error(`Skill script argument exceeds ${MAX_SKILL_SCRIPT_ARG_LENGTH} characters.`);
    }
  }
};

export const parameters = (
  properties: JsonRecord,
  required: string[] = [],
): JsonRecord => ({
  type: "object",
  properties,
  required,
});

const normalizeSkillId = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return normalized || "custom-skill";
};

const normalizeSkillFilePath = (path: string): string =>
  path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean)
    .join("/");

const isUnsafePath = (path: string): boolean =>
  path.startsWith("/") || path.includes("..") || path.includes("\0");

const normalizeFiles = (files: SkillFileRecord[] = []): SkillFileRecord[] => {
  const seen = new Set<string>();
  const normalized: SkillFileRecord[] = [];

  for (const file of files) {
    const path = normalizeSkillFilePath(file.path);
    if (!path || path === "SKILL.md") continue;
    if (isUnsafePath(path)) {
      throw new Error(`Unsafe skill file path: ${file.path}`);
    }
    if (seen.has(path)) continue;
    seen.add(path);
    normalized.push({
      path,
      content: file.content,
      ...(file.encoding === "base64" ? { encoding: "base64" as const } : {})
    });
  }

  return normalized;
};

const buildLinksReference = (
  urls: string[] | undefined,
  notes: string | undefined,
): SkillFileRecord | null => {
  const cleanUrls = Array.from(
    new Set((urls ?? []).map((url) => url.trim()).filter(Boolean)),
  );
  const cleanNotes = (notes ?? "").trim();

  if (!cleanUrls.length && !cleanNotes) return null;

  return {
    path: "references/links.md",
    content: [
      "# Reference links",
      "",
      cleanNotes ? `## Notes\n\n${cleanNotes}\n` : "",
      cleanUrls.length ? "## URLs" : "",
      ...cleanUrls.map((url) => `- ${url}`),
    ]
      .filter(Boolean)
      .join("\n"),
  };
};

interface SanitizedSkillMarkdown {
  content: string;
  version?: string | undefined;
  enabled?: boolean | undefined;
  autoRouting?: boolean | undefined;
}

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const parseBooleanOption = (value: string): boolean | undefined => {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
};

const stripOptionQuotes = (value: string): string =>
  value.trim().replace(/^['"]|['"]$/g, "");

const sanitizeChatSkillMarkdown = (content: string): SanitizedSkillMarkdown => {
  const match = content.match(frontmatterPattern);
  if (!match) return { content };

  const frontmatter = match[1] ?? "";
  const keptLines: string[] = [];
  let version: string | undefined;
  let enabled: boolean | undefined;
  let autoRouting: boolean | undefined;

  for (const line of frontmatter.split(/\r?\n/)) {
    const parsed = /^(version|enabled|autoRouting|auto-routing|auto_routing):(.*)$/i.exec(line);
    if (!parsed) {
      keptLines.push(line);
      continue;
    }

    const key = (parsed[1] ?? "").toLowerCase();
    const value = parsed[2] ?? "";
    if (key === "version") {
      version = stripOptionQuotes(value);
    } else if (key === "enabled") {
      enabled = parseBooleanOption(value);
    } else {
      autoRouting = parseBooleanOption(value);
    }
  }

  const body = content.slice(match[0].length);
  return {
    content: ["---", ...keptLines, "---", body.replace(/^\r?\n/, "")].join("\n"),
    version,
    enabled,
    autoRouting,
  };
};

export const installSkill = (
  input: InstallSkillInput,
  context: Parameters<ToolDefinition["execute"]>[1],
) => {
  if (!context.skills) {
    throw new Error("Skill registry is not available in this runtime.");
  }
  const baseFiles = normalizeFiles(input.files ?? []);
  const linksFile = buildLinksReference(
    input.referenceUrls,
    input.referenceNotes,
  );
  const files = linksFile ? [...baseFiles, linksFile] : baseFiles;
  const mode: SkillImportMode = input.installMode ?? "replace";
  let skill: SkillRecord;

  if (input.skillMarkdown) {
    const markdown = sanitizeChatSkillMarkdown(input.skillMarkdown);
    const root: SkillFileRecord = {
      path: "SKILL.md",
      content: markdown.content,
    };
    skill = context.skills.skillRecordFromFiles([root, ...files], {
      enabled: input.enabled ?? markdown.enabled ?? true,
      autoRouting: input.autoRouting ?? markdown.autoRouting ?? true,
      version: input.version ?? markdown.version ?? null,
    });
  } else {
    const name = normalizeSkillId(input.name ?? "custom-skill");
    skill = context.skills.skillRecordFromParts({
      name,
      description: input.description ?? "Custom skill created from chat.",
      instructions: input.instructions ?? "Follow the user request.",
      files,
      enabled: input.enabled ?? true,
      autoRouting: input.autoRouting ?? true,
      version: input.version ?? null,
    });
  }

  const quality = validateGeneratedSkillQuality(skill.files);
  const saved = context.skills.installGeneratedSkill(skill, mode);

  return { saved, quality };
};


export const availableSkillScripts = (skill: SkillRecord): string[] =>
  skill.files
    .map((file) => normalizeSkillFilePath(file.path))
    .filter((path) => path.startsWith("scripts/"))
    .sort((a, b) => a.localeCompare(b));

const assertInsideDirectory = (
  root: string,
  candidate: string,
  label: string,
): void => {
  const relation = relative(root, candidate);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`${label} escapes the skill staging directory.`);
  }
};

const skillStageRoot = (workspaceDir: string, skillId: string): string =>
  resolve(workspaceDir, ".super-agent", "skill-resources", normalizeSkillId(skillId));

const stageSkillPackage = (skill: SkillRecord, workspaceDir: string): string => {
  const root = skillStageRoot(workspaceDir, skill.id);
  rmSync(root, { recursive: true, force: true });

  for (const file of skill.files) {
    const path = normalizeSkillFilePath(file.path);
    if (!path || isUnsafePath(path)) {
      throw new Error(`Unsafe skill file path: ${file.path}`);
    }
    const target = resolve(root, path);
    assertInsideDirectory(root, target, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, skillFileToBuffer(file));
    if (path.startsWith("scripts/")) {
      try {
        chmodSync(target, 0o755);
      } catch {
        // Some platforms/filesystems do not support chmod. Interpreter-based
        // execution below still works for supported script types.
      }
    }
  }

  return root;
};

interface PreparedSkillScriptCommand {
  file: string;
  args: string[];
  display: string;
}

interface SkillSandboxCommand extends PreparedSkillScriptCommand {
  sandboxBackend: string;
}

const firstLine = (content: string): string =>
  content.split(/\r?\n/, 1)[0]?.trim() ?? "";

const commandFromShebang = (
  scriptFile: string,
  content: string,
  args: string[],
): PreparedSkillScriptCommand | null => {
  const line = firstLine(content);
  if (!line.startsWith("#!")) return null;
  const shebang = line.slice(2).trim();
  const lower = shebang.toLowerCase();

  if (lower.includes("python")) {
    return {
      file: process.platform === "win32" ? "python" : "python3",
      args: [scriptFile, ...args],
      display: `python3 ${scriptFile}`,
    };
  }
  if (lower.includes("node")) {
    return {
      file: "node",
      args: [scriptFile, ...args],
      display: `node ${scriptFile}`,
    };
  }
  if (lower.includes("bash")) {
    return {
      file: process.platform === "win32" ? "bash" : "/bin/bash",
      args: [scriptFile, ...args],
      display: `bash ${scriptFile}`,
    };
  }
  if (/\bsh\b/.test(lower)) {
    return {
      file: process.platform === "win32" ? "sh" : "/bin/sh",
      args: [scriptFile, ...args],
      display: `sh ${scriptFile}`,
    };
  }

  return {
    file: scriptFile,
    args,
    display: `${scriptFile}`,
  };
};

const prepareSkillScriptCommand = (
  scriptFile: string,
  scriptContent: string,
  args: string[],
): PreparedSkillScriptCommand => {
  const fromShebang = commandFromShebang(scriptFile, scriptContent, args);
  if (fromShebang) return fromShebang;

  switch (extname(scriptFile).toLowerCase()) {
    case ".py":
      return {
        file: process.platform === "win32" ? "python" : "python3",
        args: [scriptFile, ...args],
        display: `python3 ${scriptFile}`,
      };
    case ".js":
    case ".mjs":
    case ".cjs":
      return { file: "node", args: [scriptFile, ...args], display: `node ${scriptFile}` };
    case ".sh":
    case ".bash":
      return {
        file: process.platform === "win32" ? "bash" : "/bin/sh",
        args: [scriptFile, ...args],
        display: `sh ${scriptFile}`,
      };
    default:
      return {
        file: scriptFile,
        args,
        display: `${scriptFile}`,
      };
  }
};


const sandboxBackendLabel = (status: JsonRecord): string =>
  typeof status.backend === "string" ? status.backend : "unknown";

const backendStatus = (workspaceDir: string): JsonRecord => {
  if (process.platform === "darwin") {
    return macosSandboxStatus(workspaceDir) as unknown as JsonRecord;
  }
  if (process.platform === "win32") {
    return windowsSandboxStatus(workspaceDir) as unknown as JsonRecord;
  }
  return linuxSandboxStatus(workspaceDir) as unknown as JsonRecord;
};

const skillScriptSandboxCommand = ({
  workspaceDir,
  cwd,
  prepared,
  allowNetwork,
  writeRoots,
}: {
  workspaceDir: string;
  cwd: string;
  prepared: PreparedSkillScriptCommand;
  allowNetwork: boolean;
  writeRoots: string[];
}): SkillSandboxCommand | null => {
  const input = {
    workspacePath: workspaceDir,
    cwd,
    file: prepared.file,
    commandArgs: prepared.args,
    allowNetwork,
    writeRoots,
  };
  const command = process.platform === "darwin"
    ? macosSkillScriptSandboxArgs(input)
    : process.platform === "win32"
      ? windowsSkillScriptSandboxArgs(input)
      : linuxSkillScriptSandboxArgs(input);

  if (!command) return null;

  return {
    ...command,
    display: prepared.display,
    sandboxBackend: sandboxBackendLabel(backendStatus(workspaceDir)),
  };
};

const restrictedScriptEnv = (
  workspaceDir: string,
  skillRoot: string,
  skill: SkillRecord,
  policy: { allowNetwork: boolean; allowedEnv?: string[]; credentialEnv?: Record<string, string> },
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || process.env.LANG || "C.UTF-8",
    TERM: process.env.TERM || "xterm-256color",
    TMPDIR: process.env.TMPDIR || "/tmp",
    HOME: workspaceDir,
    PWD: workspaceDir,
    SKILL_ID: skill.id,
    SKILL_ROOT: skillRoot,
    WORKSPACE_DIR: workspaceDir,
    SUPER_AGENT_SKILL_SCRIPT: "1",
    SUPER_AGENT_SHELL_RESTRICTED_ENV: "1",
    SUPER_AGENT_SKILL_NETWORK: policy.allowNetwork ? "1" : "0",
  };

  for (const name of Array.from(new Set([...(policy.allowedEnv ?? []), ...allowedEnvNames(skill)]))) {
    const value = policy.credentialEnv?.[name];
    if (value !== undefined) env[name] = value;
  }

  return env;
};

const runPreparedSkillScript = ({
  prepared,
  cwd,
  timeoutMs,
  env,
}: {
  prepared: SkillSandboxCommand;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<JsonRecord> =>
  new Promise((resolveResult) => {
    const child = spawn(prepared.file, prepared.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let spawnError: string | null = null;

    const signalProcessTree = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Process already exited.
        }
      }
    };

    let killTimer: NodeJS.Timeout | null = null;
    const kill = (): void => {
      timedOut = true;
      signalProcessTree("SIGTERM");
      killTimer = setTimeout(() => signalProcessTree("SIGKILL"), 2_000);
      killTimer.unref?.();
    };

    const timer = setTimeout(kill, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendBoundedOutput(
        stdout,
        chunk,
        DEFAULT_SHELL_MAX_OUTPUT_BYTES,
      );
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendBoundedOutput(
        stderr,
        chunk,
        DEFAULT_SHELL_MAX_OUTPUT_BYTES,
      );
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });

    child.on("error", (error) => {
      spawnError = error.message;
      stderr = `${stderr}\n${error.message}`.trim();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({
        command: prepared.display,
        command_file: prepared.file,
        command_args: prepared.args,
        exit_code: code,
        signal: signal ?? null,
        stdout,
        stderr,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        truncated: stdoutTruncated || stderrTruncated,
        timed_out: timedOut,
        spawn_error: spawnError,
        max_output_bytes: DEFAULT_SHELL_MAX_OUTPUT_BYTES,
        timeout_ms: timeoutMs,
        sandbox: true,
        sandbox_backend: prepared.sandboxBackend,
      });
    });
  });

const scanFindingsForAudit = (skill: SkillRecord) =>
  skill.scanFindings.map((finding) => ({
    severity: finding.severity,
    ruleId: finding.ruleId,
    message: finding.message,
    ...(finding.path ? { path: finding.path } : {}),
    ...(typeof finding.line === "number" ? { line: finding.line } : {}),
    ...(finding.excerpt ? { excerpt: finding.excerpt } : {}),
  }));

const recordBlockedScriptAudit = (
  context: Parameters<ToolDefinition["execute"]>[1],
  skill: SkillRecord,
  scriptPath: string,
  reason: string,
): void => {
  context.skills?.recordAuditLog({
    action: "skill.script_blocked",
    skillId: skill.id,
    skillName: skill.name,
    actor: "agent",
    status: "blocked",
    packageHash: skill.packageHash ?? null,
    detail: {
      scriptPath,
      reason,
      trustLevel: skill.trustLevel,
      quarantineReason: skill.quarantineReason,
      scanFindings: scanFindingsForAudit(skill),
    },
  });
};

export const runSkillScript = async (
  input: RunSkillScriptInput,
  context: Parameters<ToolDefinition["execute"]>[1],
): Promise<JsonRecord> => {
  if (!context.skills) {
    throw new Error("Skill registry is not available in this runtime.");
  }

  const skill = context.skills.get(input.skillId);
  if (!skill) throw new Error(`Skill not found: ${input.skillId}`);
  if (!skill.enabled) throw new Error(`Skill is disabled: ${skill.id}`);
  const scriptPath = normalizeSkillFilePath(input.scriptPath);
  const executionPolicy = context.skills.scriptExecutionPolicy(skill);
  if (!executionPolicy.allowed) {
    const reason = `Skill script blocked by policy: ${executionPolicy.reasons.join("; ")}`;
    recordBlockedScriptAudit(context, skill, scriptPath || input.scriptPath, reason);
    throw new Error(reason);
  }
  if (!scriptPath.startsWith("scripts/") || isUnsafePath(scriptPath)) {
    throw new Error("scriptPath must point to a safe file under scripts/.");
  }

  const script = skill.files.find(
    (file) => normalizeSkillFilePath(file.path) === scriptPath,
  );
  if (!script) {
    throw new Error(
      `Script not found in skill '${skill.id}': ${scriptPath}`,
    );
  }

  const scriptText = skillFileText(script);
  if (scriptUsesSudo(scriptText)) {
    const reason = "Skill scripts cannot run sudo commands.";
    recordBlockedScriptAudit(context, skill, scriptPath, reason);
    throw new Error(reason);
  }

  const scriptPolicy = scriptPermissionOverride(skill, scriptPath);
  const allowNetwork = scriptPolicy.allowNetwork ?? skill.dependencyMetadata.permissions.allowNetwork ?? context.skills.allowNetworkByDefault();
  const allowedEnv = scriptPolicy.allowedEnv ?? allowedEnvNames(skill);
  const credentialEnv = context.skills.credentialEnv(
    skill.id,
    Array.from(new Set([...allowedEnv, ...allowedEnvNames(skill)])),
  );
  const preflight = context.skills.preflight(skill.id, context.workspaceDir);
  if (!preflight.ok) {
    const reason = `Skill preflight failed before running script. Missing bins: ${preflight.missingBins.join(", ") || "none"}; missing env: ${preflight.missingEnv.join(", ") || "none"}; missing files: ${preflight.missingFiles.join(", ") || "none"}; incompatible platforms: ${preflight.incompatiblePlatforms.join(", ") || "none"}.`;
    recordBlockedScriptAudit(context, skill, scriptPath, reason);
    throw new Error(reason);
  }
  if (!allowNetwork && scriptUsesNetwork(scriptText)) {
    const reason = "Skill script appears to use network access but neither project policy nor script metadata declares allow_network: true.";
    recordBlockedScriptAudit(context, skill, scriptPath, reason);
    throw new Error(reason);
  }
  const args = input.args ?? [];
  validateScriptArgs(args);
  if (scriptPolicy.allowedArgs?.length) {
    const deniedArg = args.find((arg) => !scriptPolicy.allowedArgs?.some((allowed) => arg === allowed || arg.startsWith(`${allowed}=`)));
    if (deniedArg) {
      const reason = `Skill script argument is not allowed by script policy: ${deniedArg}`;
      recordBlockedScriptAudit(context, skill, scriptPath, reason);
      throw new Error(reason);
    }
  }

  const workspaceDir = resolve(context.workspaceDir);
  const cwd = resolveExistingPath(workspaceDir, input.cwd ?? ".");
  const writeRoots = normalizeWriteRootsForSandbox(
    workspaceDir,
    scriptPolicy.writeRoots ?? skill.dependencyMetadata.permissions.writeRoots,
  );
  assertCwdPolicy(workspaceDir, cwd);
  assertCwdWithinWriteRoots(workspaceDir, cwd, writeRoots);
  const skillRoot = stageSkillPackage(skill, workspaceDir);
  const scriptFile = resolve(skillRoot, scriptPath);
  assertInsideDirectory(skillRoot, scriptFile, scriptPath);

  const prepared = prepareSkillScriptCommand(scriptFile, scriptText, args);
  if (!canResolveCommand(prepared.file)) {
    throw new Error(`Runtime for skill script is unavailable: ${prepared.file}`);
  }
  const sandboxed = skillScriptSandboxCommand({
    workspaceDir,
    cwd,
    prepared,
    allowNetwork,
    writeRoots,
  });
  if (!sandboxed) {
    const status = backendStatus(workspaceDir);
    const reason = `Skill script sandbox is unavailable (${sandboxBackendLabel(status)}). Install or enable the sandbox backend before running skill scripts.`;
    recordBlockedScriptAudit(context, skill, scriptPath, reason);
    throw new Error(reason);
  }

  const timeoutMs = Math.min(
    input.timeoutMs ?? scriptPolicy.maxRuntimeMs ?? skill.dependencyMetadata.permissions.maxRuntimeMs ?? DEFAULT_SHELL_TIMEOUT_MS,
    scriptPolicy.maxRuntimeMs ?? skill.dependencyMetadata.permissions.maxRuntimeMs ?? MAX_SKILL_SCRIPT_TIMEOUT_MS,
    MAX_SKILL_SCRIPT_TIMEOUT_MS,
  );
  const env = restrictedScriptEnv(
    workspaceDir,
    skillRoot,
    skill,
    { allowNetwork, allowedEnv, credentialEnv },
  );
  const scriptHash = scriptContentHash(scriptText);
  const startedAt = new Date();
  const output = await runPreparedSkillScript({ prepared: sandboxed, cwd: workspaceDir, timeoutMs, env });
  const finishedAt = new Date();
  const exitCode = typeof output.exit_code === "number" ? output.exit_code : null;
  const signal = typeof output.signal === "string" ? output.signal : null;
  const timedOut = output.timed_out === true;
  const spawnError = typeof output.spawn_error === "string" && output.spawn_error.length > 0;
  const stdout = redactSensitiveText(typeof output.stdout === "string" ? output.stdout : "");
  const stderr = redactSensitiveText(typeof output.stderr === "string" ? output.stderr : "");
  const status: SkillScriptRunHistory["status"] = timedOut
    ? "timed_out"
    : spawnError
      ? "spawn_error"
      : exitCode === 0 ? "ok" : "failed";

  output.stdout = stdout;
  output.stderr = stderr;
  context.skills.recordScriptRun({
    id: randomUUID(),
    skillId: skill.id,
    skillName: skill.name,
    scriptPath,
    args,
    cwd,
    command: prepared.display,
    status,
    exitCode,
    signal,
    timedOut,
    stdout,
    stderr,
    stdoutTruncated: output.stdout_truncated === true,
    stderrTruncated: output.stderr_truncated === true,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    actor: "agent",
    packageHash: skill.packageHash ?? "unknown",
    scriptHash,
    envKeys: Object.keys(env).sort(),
  });

  return {
    skillId: skill.id,
    skillName: skill.name,
    scriptPath,
    stagedSkillRoot: skillRoot,
    cwd,
    args,
    packageHash: skill.packageHash ?? "unknown",
    scriptHash,
    envKeys: Object.keys(env).sort(),
    scriptPolicy: {
      allowNetwork,
      allowedEnv,
      writeRoots,
      timeoutMs,
    },
    ...output,
  };
};
