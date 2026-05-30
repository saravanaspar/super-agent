import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { JsonRecord } from "@shared/json";
import type { ToolDefinition } from "@tool-registry/types";
import { failureResult, successResult } from "@tool-registry/types";
import { HARD_BLOCK_EXACT_PATHS, HARD_BLOCK_PATH_PREFIXES, SKIP_DIRS } from "./constants";
import { assertNotSkippedWorkspacePath, resolveExistingPath, toWorkspaceRelative } from "./pathSafety";


const grepInput = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  file_pattern: z.string().optional(),
  max_results: z.number().int().positive().optional(),
  context: z.number().int().min(0).optional(),
  literal: z.boolean().optional(),
  regex: z.boolean().optional(),
  deadline_ms: z.number().int().positive().optional()
});

type GrepInput = z.infer<typeof grepInput>;

type WalkCallback = (absolutePath: string, relativePath: string) => boolean;

const parameters = (properties: JsonRecord, required: string[] = []): JsonRecord => ({
  type: "object",
  properties,
  required
});

const canAccessOutsideWorkspace = (context: { agentSettings?: { allowOutsideWorkspaceAccess?: boolean } }): boolean =>
  context.agentSettings?.allowOutsideWorkspaceAccess === true;

const pathPolicyBlocked = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : "";
  return message.includes("Path outside workspace") || message.includes("always blocked") || message.includes("skipped workspace directory");
};

const isInsidePath = (parentPath: string, candidatePath: string): boolean => {
  const relation = relative(parentPath, candidatePath);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
};

const isExternalMediaWorkspace = (workspaceDir: string): boolean => {
  const workspace = resolve(workspaceDir);
  const allowedMountRoots =
    process.platform === "darwin"
      ? ["/Volumes"]
      : ["/run/media", "/media", "/mnt"];

  return allowedMountRoots.some(
    (root) => workspace !== root && workspace.startsWith(`${root}/`)
  );
};

const isSelectedWorkspacePath = (absolutePath: string, workspaceDir: string): boolean =>
  isExternalMediaWorkspace(workspaceDir) && isInsidePath(resolve(workspaceDir), resolve(absolutePath));

const isHardBlockedWalkPath = (absolutePath: string, workspaceDir: string): boolean => {
  const normalized = resolve(absolutePath).replace(/\/+$/, "") || "/";
  if (HARD_BLOCK_EXACT_PATHS.has(normalized)) return true;

  return HARD_BLOCK_PATH_PREFIXES.some((prefix) => {
    const matches = normalized === prefix || normalized.startsWith(`${prefix}/`);
    return matches && !isSelectedWorkspacePath(normalized, workspaceDir);
  });
};

const escapeRegex = (value: string): string =>
  value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

const globToRegex = (pattern: string): RegExp => {
  const normalized = pattern.replace(/\\/g, "/");
  let out = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        out += "(?:.*\\/)?";
        index += 2;
      } else {
        out += ".*";
        index += 1;
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const end = normalized.indexOf("}", index + 1);
      if (end > index) {
        const choices = normalized
          .slice(index + 1, end)
          .split(",")
          .map((choice) => escapeRegex(choice.trim()))
          .filter(Boolean);
        out += choices.length > 0 ? `(?:${choices.join("|")})` : escapeRegex(char);
        index = end;
      } else {
        out += escapeRegex(char);
      }
    } else {
      out += escapeRegex(char ?? "");
    }
  }

  out += "$";
  return new RegExp(out);
};

const walkWorkspaceFiles = (
  workspaceDir: string,
  rootDir: string,
  onFile: WalkCallback,
  options: { maxDepth: number; deadlineAt: number },
  depth = 0
): boolean => {
  if (Date.now() > options.deadlineAt) return false;
  if (depth > options.maxDepth) return true;

  const entries = readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (Date.now() > options.deadlineAt) return false;

    const absolutePath = join(rootDir, entry.name);
    if (isHardBlockedWalkPath(absolutePath, workspaceDir)) continue;
    let stat;
    try {
      stat = entry.isSymbolicLink() ? null : statSync(absolutePath);
    } catch {
      continue;
    }

    if (!stat) continue;

    if (stat.isDirectory()) {
      if (!walkWorkspaceFiles(workspaceDir, absolutePath, onFile, options, depth + 1)) return false;
      continue;
    }

    if (!stat.isFile()) continue;
    const relativePath = relative(workspaceDir, absolutePath).replace(/\\/g, "/");
    if (!onFile(absolutePath, relativePath)) return false;
  }

  return true;
};

const matchesFilePattern = (relativePath: string, pattern: string): boolean => {
  const matcher = globToRegex(pattern || "*");
  const basenameMatcher = globToRegex(basename(pattern || "*"));
  return matcher.test(relativePath) || basenameMatcher.test(basename(relativePath));
};

const runRipgrep = (
  args: string[],
  pattern: string,
  maxResults: number,
  deadlineMs: number
): Promise<JsonRecord> =>
  new Promise((resolve, reject) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const results: JsonRecord[] = [];
    let buffer = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, deadlineMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;

        try {
          const parsed = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; column?: number; lines?: { text?: string } } };
          if (parsed.type === "match" && parsed.data && results.length < maxResults) {
            results.push({
              path: parsed.data.path?.text ?? "",
              line: parsed.data.line_number ?? 0,
              col: parsed.data.column ?? 0,
              text: parsed.data.lines?.text ?? ""
            });
          }
          if (results.length >= maxResults) {
            truncated = true;
            child.kill("SIGTERM");
            break;
          }
        } catch {
          continue;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code && code > 1 && !truncated && !timedOut) {
        reject(new Error(stderr || `ripgrep failed with exit code ${code}`));
        return;
      }
      resolve({ pattern, count: results.length, truncated: truncated || timedOut, deadline_reached: timedOut, matches: results });
    });
  });

const nativeGrep = (workspaceDir: string, input: GrepInput, searchPath: string): JsonRecord => {
  const maxResults = Math.max(1, Math.min(input.max_results ?? 50, 1000));
  const filePattern = input.file_pattern ?? "*";
  const deadlineAt = Date.now() + Math.max(100, Math.min(input.deadline_ms ?? 5000, 30000));
  const literal = input.regex === true ? false : input.literal !== false;
  const regex = new RegExp(literal ? escapeRegex(input.pattern) : input.pattern);
  const matches: JsonRecord[] = [];
  let deadlineReached = false;

  const scanFile = (absolutePath: string, relativePath: string): boolean => {
    if (Date.now() > deadlineAt) {
      deadlineReached = true;
      return false;
    }
    if (!matchesFilePattern(relativePath, filePattern)) return true;
    const stat = statSync(absolutePath);
    if (stat.size > 2 * 1024 * 1024) return true;
    const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      regex.lastIndex = 0;
      const match = regex.exec(line);
      if (!match) continue;
      matches.push({ path: relativePath, line: index + 1, col: match.index + 1, text: line });
      if (matches.length >= maxResults) return false;
    }

    return true;
  };

  const root = statSync(searchPath).isFile() ? searchPath : searchPath;
  if (statSync(root).isFile()) {
    scanFile(root, toWorkspaceRelative(workspaceDir, root));
  } else {
    walkWorkspaceFiles(workspaceDir, root, scanFile, { maxDepth: 32, deadlineAt });
  }

  return { pattern: input.pattern, count: matches.length, truncated: matches.length >= maxResults || deadlineReached, deadline_reached: deadlineReached, matches };
};

const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description: "Search for text patterns in files using ripgrep when available, otherwise bounded native scanning.",
  category: "general",
  risk: "safe",
  inputSchema: grepInput,
  parameters: parameters({ pattern: { type: "string" }, path: { type: "string" }, file_pattern: { type: "string" }, max_results: { type: "number" }, context: { type: "number" }, literal: { type: "boolean" }, regex: { type: "boolean" }, deadline_ms: { type: "number" } }, ["pattern"]),
  async execute(input, context) {
    const searchPath = input.path
      ? resolveExistingPath(
          context.workspaceDir,
          input.path,
          undefined,
          canAccessOutsideWorkspace(context)
        )
      : context.workspaceDir;
    const deadlineMs = Math.max(100, Math.min(input.deadline_ms ?? 5000, 30000));
    if (isHardBlockedWalkPath(searchPath, context.workspaceDir)) {
      return failureResult("Search path is always protected.", { path: searchPath }, true);
    }
    try {
      assertNotSkippedWorkspacePath(context.workspaceDir, searchPath);
    } catch (error) {
      return failureResult(
        error instanceof Error ? error.message : "Search path is skipped.",
        { path: searchPath },
        true
      );
    }

    const blockedGlobs = HARD_BLOCK_PATH_PREFIXES.flatMap((prefix) => [
      "--glob",
      `!${prefix.replace(/^\//, "")}/**`
    ]);
    const skippedGlobs = [...SKIP_DIRS].flatMap((dir) => ["--glob", `!${dir}/**`]);
    const rgArgs = ["--json", "--context", String(input.context ?? 2), "--max-filesize", "2M", "-g", input.file_pattern ?? "*", ...skippedGlobs, ...blockedGlobs, "--", input.pattern, searchPath];
    try {
      const result = await runRipgrep(rgArgs, input.pattern, Math.max(1, Math.min(input.max_results ?? 50, 1000)), deadlineMs);
      return successResult("Grep completed.", result);
    } catch (error) {
      if (error instanceof Error && /ENOENT|spawn rg/.test(error.message)) {
        return successResult("Native grep completed.", nativeGrep(context.workspaceDir, input, searchPath));
      }
      return failureResult(
        error instanceof Error ? error.message : "Grep failed.",
        null,
        pathPolicyBlocked(error)
      );
    }
  }
};

export const searchTools: ToolDefinition[] = [grepTool];
