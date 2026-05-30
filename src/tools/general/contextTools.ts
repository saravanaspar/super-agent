import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { toJsonRecord, type JsonRecord, type JsonValue } from "@shared/json";
import type { ToolDefinition } from "@tool-registry/types";
import { failureResult, successResult } from "@tool-registry/types";
import {
  assertNotSkippedWorkspacePath,
  resolveExistingPath,
  toWorkspaceRelative,
  validatePath
} from "./pathSafety";
import { SKIP_DIRS } from "./constants";

const projectIndexInput = z.object({
  path: z.string().optional(),
  max_files: z.number().int().positive().optional(),
  max_depth: z.number().int().positive().optional(),
  max_file_bytes: z.number().int().positive().optional(),
  deadline_ms: z.number().int().positive().optional()
});

const queryContextInput = z.object({
  query: z.string().min(1),
  max_results: z.number().int().positive().optional(),
  include_digest: z.boolean().optional()
});


const updateContextInput = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown())
});

type ProjectIndexInput = z.infer<typeof projectIndexInput>;
type QueryContextInput = z.infer<typeof queryContextInput>;
type UpdateContextInput = z.infer<typeof updateContextInput>;

interface IndexedFile {
  path: string;
  hash: string;
  size: number;
  lines: number;
  symbols: Array<{ name: string; kind: string; start: number; end: number }>;
}

interface ProjectContextState {
  version: 1;
  updatedAt: string;
  files: IndexedFile[];
  actions: JsonRecord[];
  issues: JsonRecord[];
  visualRegions: JsonRecord[];
}

const parameters = (properties: JsonRecord, required: string[] = []): JsonRecord => ({ type: "object", properties, required });

const contextPath = (workspaceDir: string): string => join(workspaceDir, ".super-agent", "project_context.json");

const emptyState = (): ProjectContextState => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  files: [],
  actions: [],
  issues: [],
  visualRegions: []
});

const readState = (workspaceDir: string): ProjectContextState => {
  const filePath = contextPath(workspaceDir);
  if (!existsSync(filePath)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ProjectContextState;
    return { ...emptyState(), ...parsed, files: Array.isArray(parsed.files) ? parsed.files : [] };
  } catch {
    return emptyState();
  }
};

const writeState = (workspaceDir: string, state: ProjectContextState): void => {
  const filePath = contextPath(workspaceDir);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf8");
};

const hashContent = (content: string): string => createHash("sha256").update(content).digest("hex").slice(0, 16);

const symbolRegex = /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g;

const indexFile = (workspaceDir: string, absolutePath: string, maxFileBytes: number): IndexedFile | null => {
  const stat = statSync(absolutePath);
  if (!stat.isFile() || stat.size > maxFileBytes) return null;
  const content = readFileSync(absolutePath, "utf8");
  if (content.includes("\u0000")) return null;
  const lines = content.split(/\r?\n/);
  const symbols: IndexedFile["symbols"] = [];
  let match = symbolRegex.exec(content);
  while (match) {
    const before = content.slice(0, match.index);
    const line = before.split(/\r?\n/).length;
    symbols.push({ name: match[1] ?? "", kind: "symbol", start: line, end: line });
    match = symbolRegex.exec(content);
  }
  return { path: toWorkspaceRelative(workspaceDir, absolutePath), hash: hashContent(content), size: stat.size, lines: lines.length, symbols };
};

const sourceFileExtensions = new Set([
  ".astro", ".bash", ".c", ".cc", ".cfg", ".clj", ".cljs", ".cmake",
  ".conf", ".cpp", ".cs", ".csproj", ".css", ".cxx", ".dart",
  ".dockerfile", ".erl", ".ex", ".exs", ".fs", ".go", ".gradle",
  ".graphql", ".gql", ".h", ".hcl", ".hh", ".hpp", ".hrl", ".hs",
  ".html", ".ini", ".java", ".js", ".json", ".jsx", ".kt", ".kts",
  ".lua", ".mjs", ".ml", ".mli", ".nim", ".php", ".prisma",
  ".properties", ".proto", ".ps1", ".py", ".pyi", ".rb", ".rs",
  ".sbt", ".scala", ".scss", ".sh", ".sln", ".sql", ".svelte",
  ".swift", ".tf", ".tfvars", ".toml", ".ts", ".tsx", ".vue", ".xml",
  ".yaml", ".yml", ".zig", ".zsh"
]);

const isSourceFile = (filePath: string): boolean =>
  sourceFileExtensions.has(extname(filePath).toLowerCase());

const indexDirectory = (
  context: Parameters<ToolDefinition<ProjectIndexInput>["execute"]>[1],
  rootDir: string,
  input: ProjectIndexInput,
  maxFileBytes: number,
): IndexedFile[] => {
  const maxFiles = Math.max(1, Math.min(input.max_files ?? 5000, 5000));
  const maxDepth = Math.max(1, Math.min(input.max_depth ?? 32, 64));
  const deadlineAt = Date.now() + Math.max(100, Math.min(input.deadline_ms ?? 30000, 30000));
  const indexedFiles: IndexedFile[] = [];

  const walk = (directory: string, depth: number): void => {
    if (indexedFiles.length >= maxFiles || Date.now() > deadlineAt || depth > maxDepth) {
      return;
    }

    assertNotSkippedWorkspacePath(context.workspaceDir, directory);

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (indexedFiles.length >= maxFiles || Date.now() > deadlineAt) {
        return;
      }

      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }

      const absolutePath = join(directory, entry.name);
      assertNotSkippedWorkspacePath(context.workspaceDir, absolutePath);

      if (entry.isDirectory()) {
        walk(absolutePath, depth + 1);
        continue;
      }

      if (!entry.isFile() || !isSourceFile(entry.name)) {
        continue;
      }

      const indexed = indexFile(context.workspaceDir, absolutePath, maxFileBytes);
      if (indexed) {
        indexedFiles.push(indexed);
      }
    }
  };

  walk(rootDir, 0);
  return indexedFiles;
};

const projectIndexTool: ToolDefinition<ProjectIndexInput> = {
  name: "project_index",
  description: "Build or refresh the project context index. Pass a file to index one file, a directory to index reviewable source files below it, or omit path to index the workspace.",
  category: "general",
  risk: "safe",
  inputSchema: projectIndexInput,
  parameters: parameters({ path: { type: "string" }, max_files: { type: "number" }, max_depth: { type: "number" }, max_file_bytes: { type: "number" }, deadline_ms: { type: "number" } }),
  async execute(input, context) {
    await Promise.resolve();
    const maxFileBytes = Math.max(1, input.max_file_bytes ?? 2 * 1024 * 1024);
    const state = readState(context.workspaceDir);
    let files: IndexedFile[] = [];

    if (input.path) {
      const target = resolveExistingPath(context.workspaceDir, input.path);
      assertNotSkippedWorkspacePath(context.workspaceDir, target);
      const stat = statSync(target);

      if (stat.isDirectory()) {
        files = indexDirectory(context, target, input, maxFileBytes);
      } else {
        const indexed = indexFile(context.workspaceDir, target, maxFileBytes);
        if (!indexed) {
          return failureResult("project_index path must be a readable source file under size limits.");
        }
        files.push(indexed);
      }
    } else {
      files = indexDirectory(context, context.workspaceDir, input, maxFileBytes);
    }

    const next = { ...state, files: [...state.files.filter((file) => !files.some((item) => item.path === file.path)), ...files] };
    writeState(context.workspaceDir, next);
    return successResult("Project context indexed.", { indexed_count: files.length, stats: { files: next.files.length }, files: files as unknown as JsonValue });
  }
};

const queryContextTool: ToolDefinition<QueryContextInput> = {
  name: "query_context",
  description: "Query the project context graph for files, symbols, visual regions, issues, and relationships before deciding what to read.",
  category: "general",
  risk: "safe",
  inputSchema: queryContextInput,
  parameters: parameters({ query: { type: "string" }, max_results: { type: "number" }, include_digest: { type: "boolean" } }, ["query"]),
  execute(input, context) {
    const state = readState(context.workspaceDir);
    const query = input.query.toLowerCase();
    const maxResults = Math.max(1, Math.min(input.max_results ?? 20, 100));
    const results = state.files.flatMap((file) => {
      const fileMatches = file.path.toLowerCase().includes(query) ? [{ type: "file", path: file.path, size: file.size, lines: file.lines }] : [];
      const symbolMatches = file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(query)).map((symbol) => ({ type: "symbol", path: file.path, ...symbol }));
      return [...fileMatches, ...symbolMatches];
    }).slice(0, maxResults);
    return Promise.resolve(successResult("Context query completed.", { query: input.query, count: results.length, results: results as unknown as JsonValue, digest: input.include_digest ? state.files.slice(0, 15) as unknown as JsonValue : null }));
  }
};


const updateContextTool: ToolDefinition<UpdateContextInput> = {
  name: "update_context",
  description: "Update project context memory for visual regions, issues, graph edges, actions, or a modified file.",
  category: "general",
  risk: "medium",
  inputSchema: updateContextInput,
  parameters: parameters({ type: { type: "string" }, payload: { type: "object", additionalProperties: true } }, ["type", "payload"]),
  execute(input, context) {
    const state = readState(context.workspaceDir);
    const payload = toJsonRecord(input.payload);
    if (input.type === "file") {
      const filePath = typeof payload.path === "string" ? payload.path : "";
      const absolutePath = validatePath(context.workspaceDir, filePath);
      assertNotSkippedWorkspacePath(context.workspaceDir, absolutePath);
      const indexed = indexFile(context.workspaceDir, absolutePath, 2 * 1024 * 1024);
      if (indexed) state.files = [...state.files.filter((file) => file.path !== indexed.path), indexed];
    } else if (input.type === "visual_region") state.visualRegions.push(payload);
    else if (input.type === "issue") state.issues.push(payload);
    else state.actions.push({ type: input.type, payload, createdAt: new Date().toISOString() });
    writeState(context.workspaceDir, state);
    return Promise.resolve(successResult("Context updated.", { type: input.type, stats: { files: state.files.length, issues: state.issues.length, visualRegions: state.visualRegions.length, actions: state.actions.length } }));
  }
};

export const contextTools: ToolDefinition[] = [projectIndexTool, queryContextTool, updateContextTool];
