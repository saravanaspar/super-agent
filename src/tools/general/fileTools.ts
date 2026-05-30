import {
  appendFileSync,
  existsSync,
  lstatSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { z } from "zod";
import type { JsonRecord } from "@shared/json";
import type { ToolDefinition } from "@tool-registry/types";
import { failureResult, successResult } from "@tool-registry/types";
import {
  atomicWriteFile,
  assertNotSkippedWorkspacePath,
  resolveExistingPath,
  toWorkspaceRelative,
  validatePath,
  workspaceRealPath,
} from "./pathSafety";
import {
  DEFAULT_HUGE_FILE_BYTES,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
  SKIP_DIRS,
} from "./constants";

const readFileInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().optional(),
  allow_large: z.boolean().optional(),
});

const writeFileInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  create_dirs: z.boolean().optional(),
});

const appendFileInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  create_dirs: z.boolean().optional(),
});

const editFileInput = z.object({
  path: z.string().min(1),
  search: z.string(),
  replace: z.string(),
  replace_all: z.boolean().optional(),
});

const editRangeInput = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  replacement: z.string(),
  expected_old: z.string().optional(),
  create_trailing_newline: z.boolean().optional(),
});

const lsInput = z.object({
  path: z.string().optional(),
  show_hidden: z.boolean().optional(),
});

const mkdirInput = z.object({ path: z.string().min(1) });
const rmInput = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional(),
});
const existsInput = z.object({ path: z.string().min(1) });


type ReadFileInput = z.infer<typeof readFileInput>;
type WriteFileInput = z.infer<typeof writeFileInput>;
type AppendFileInput = z.infer<typeof appendFileInput>;
type EditFileInput = z.infer<typeof editFileInput>;
type EditRangeInput = z.infer<typeof editRangeInput>;
type LsInput = z.infer<typeof lsInput>;
type MkdirInput = z.infer<typeof mkdirInput>;
type RmInput = z.infer<typeof rmInput>;
type ExistsInput = z.infer<typeof existsInput>;

const parameters = (
  properties: JsonRecord,
  required: string[] = [],
): JsonRecord => ({
  type: "object",
  properties,
  required,
});

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const canAccessOutsideWorkspace = (context: {
  agentSettings?: { allowOutsideWorkspaceAccess?: boolean };
}): boolean => context.agentSettings?.allowOutsideWorkspaceAccess === true;

const pathPolicyBlocked = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("Path outside workspace") ||
    message.includes("always blocked") ||
    message.includes("skipped workspace directory")
  );
};

const pathFailure = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : fallback;
  return failureResult(message, null, pathPolicyBlocked(error));
};

const assertAllowedWorkspacePath = (
  workspaceDir: string,
  candidatePath: string
): void => {
  assertNotSkippedWorkspacePath(workspaceDir, candidatePath);
};

const DEFAULT_READ_LINE_LIMIT = 80;
const MAX_READ_LINE_LIMIT = 400;
const READ_CACHE_TTL_MS = 60_000;

interface ReadCacheEntry {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  dev: number;
  ino: number;
  rangeHash: string;
  readAt: number;
  data: JsonRecord;
}

const readCache = new Map<string, ReadCacheEntry>();

const cacheKeyForRead = (filePath: string, input: ReadFileInput): string => {
  const offset = Math.max(1, input.offset ?? 1);
  const limit = Math.max(
    1,
    Math.min(input.limit ?? DEFAULT_READ_LINE_LIMIT, MAX_READ_LINE_LIMIT),
  );
  return `${filePath}:${offset}:${limit}`;
};

const hashContent = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const invalidateReadCache = (filePath: string): void => {
  for (const key of readCache.keys()) {
    if (key.startsWith(`${filePath}:`)) {
      readCache.delete(key);
    }
  }
};

const streamTextRange = async (
  filePath: string,
  offset: number,
  limit: number
): Promise<{ totalLines: number; selected: string[] }> => {
  const selected: string[] = [];
  let totalLines = 0;
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of reader) {
    totalLines += 1;

    if (totalLines >= offset && selected.length < limit) {
      selected.push(line);
    }
  }

  return { totalLines, selected };
};

const readTextRange = async (
  filePath: string,
  input: ReadFileInput
): Promise<JsonRecord> => {
  const stat = statSync(filePath);
  const maxReadBytes = DEFAULT_MAX_READ_BYTES;
  const hugeFileBytes = DEFAULT_HUGE_FILE_BYTES;
  const offset = Math.max(1, input.offset ?? 1);
  const limit = Math.max(
    1,
    Math.min(input.limit ?? DEFAULT_READ_LINE_LIMIT, MAX_READ_LINE_LIMIT),
  );

  if (stat.size > hugeFileBytes && input.allow_large !== true) {
    return {
      path: filePath,
      error: "Large file reads must be explicit and bounded. Re-run with allow_large=true; the tool will still stream only the requested chunk.",
      size: stat.size,
      hugeFileBytes,
      offset,
      limit,
    };
  }

  const key = cacheKeyForRead(filePath, { ...input, offset, limit });
  const cached = readCache.get(key);
  const { totalLines, selected } = await streamTextRange(filePath, offset, limit);
  const text = selected.join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  const truncated = bytes > maxReadBytes;
  const content = truncated ? text.slice(0, maxReadBytes) : text;
  const rangeHash = hashContent(content);

  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.ctimeMs === stat.ctimeMs &&
    cached.size === stat.size &&
    cached.dev === stat.dev &&
    cached.ino === stat.ino &&
    cached.rangeHash === rangeHash &&
    Date.now() - cached.readAt <= READ_CACHE_TTL_MS
  ) {
    return {
      path: cached.data.path ?? filePath,
      offset: cached.data.offset ?? offset,
      limit: cached.data.limit ?? limit,
      total_lines: totalLines,
      returned_lines: 0,
      truncated: false,
      streamed: true,
      hash: rangeHash,
      unchanged_since_last_read: true,
      content_returned: false,
      previous_result_still_valid: true,
      note: "File chunk hash is unchanged from the previous read in this run window. Reuse the previous content, search line numbers, edit directly, or produce the final answer.",
    };
  }

  const data: JsonRecord = {
    path: filePath,
    offset,
    limit,
    total_lines: totalLines,
    returned_lines: selected.length,
    truncated,
    streamed: true,
    hash: rangeHash,
    content,
  };

  readCache.set(key, {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    dev: stat.dev,
    ino: stat.ino,
    rangeHash,
    readAt: Date.now(),
    data,
  });

  return data;
};

const readFileTool: ToolDefinition<ReadFileInput> = {
  name: "read_file",
  description:
    "Read contents of one file with an optional line range. Offset 0 is normalized to line 1. Repeated unchanged reads return metadata instead of duplicating content.",
  category: "general",
  risk: "safe",
  inputSchema: readFileInput,
  parameters: parameters(
    {
      path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
      allow_large: { type: "boolean" },
    },
    ["path"],
  ),
  async execute(input, context) {
    try {
      const target = resolveExistingPath(
        context.workspaceDir,
        input.path,
        undefined,
        canAccessOutsideWorkspace(context),
      );
      assertNotSkippedWorkspacePath(context.workspaceDir, target);
      const stat = statSync(target);
      if (!stat.isFile())
        return Promise.resolve(
          failureResult("Path is not a file.", { path: target }),
        );
      const readResult = await readTextRange(target, input);
      const error = readString(readResult.error);
      if (error) {
        return failureResult(error, readResult);
      }
      return successResult("File read completed.", readResult);
    } catch (error) {
      return Promise.resolve(pathFailure(error, "File read failed."));
    }
  },
};

const writeFileTool: ToolDefinition<WriteFileInput> = {
  name: "write_file",
  description: "Create or overwrite a file with content.",
  category: "general",
  risk: "high",
  inputSchema: writeFileInput,
  parameters: parameters(
    {
      path: { type: "string" },
      content: { type: "string" },
      create_dirs: { type: "boolean" },
    },
    ["path", "content"],
  ),
  execute(input, context) {
    try {
      const target = validatePath(context.workspaceDir, input.path, {
        allowMissingLeaf: true,
        allowOutsideWorkspace: canAccessOutsideWorkspace(context),
      });
      assertAllowedWorkspacePath(context.workspaceDir, target);
      const bytes = Buffer.byteLength(input.content, "utf8");
      if (bytes > DEFAULT_MAX_WRITE_BYTES)
        return Promise.resolve(
          failureResult("write_file content exceeds maximum write size."),
        );
      if (input.create_dirs !== false)
        mkdirSync(dirname(target), { recursive: true });
      atomicWriteFile(target, input.content);
      invalidateReadCache(target);
      return Promise.resolve(
        successResult("File written.", { path: target, bytes }),
      );
    } catch (error) {
      return Promise.resolve(pathFailure(error, "File write failed."));
    }
  },
};

const appendFileTool: ToolDefinition<AppendFileInput> = {
  name: "append_file",
  description:
    "Append content to an existing or new file without rereading and rewriting the whole file. Prefer this for long writing tasks.",
  category: "general",
  risk: "high",
  inputSchema: appendFileInput,
  parameters: parameters(
    {
      path: { type: "string" },
      content: { type: "string" },
      create_dirs: { type: "boolean" },
    },
    ["path", "content"],
  ),
  execute(input, context) {
    try {
      const target = validatePath(context.workspaceDir, input.path, {
        allowMissingLeaf: true,
        allowOutsideWorkspace: canAccessOutsideWorkspace(context),
      });
      assertAllowedWorkspacePath(context.workspaceDir, target);
      const bytes = Buffer.byteLength(input.content, "utf8");
      if (bytes > DEFAULT_MAX_WRITE_BYTES)
        return Promise.resolve(
          failureResult("append_file content exceeds maximum write size."),
        );
      if (input.create_dirs !== false)
        mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, input.content, "utf8");
      invalidateReadCache(target);
      const stat = statSync(target);
      return Promise.resolve(
        successResult("Content appended.", {
          path: target,
          bytes_appended: bytes,
          total_bytes: stat.size,
        }),
      );
    } catch (error) {
      return Promise.resolve(pathFailure(error, "File append failed."));
    }
  },
};

const editFileTool: ToolDefinition<EditFileInput> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. By default, replaces only the first exact match.",
  category: "general",
  risk: "high",
  inputSchema: editFileInput,
  parameters: parameters(
    {
      path: { type: "string" },
      search: { type: "string" },
      replace: { type: "string" },
      replace_all: { type: "boolean" },
    },
    ["path", "search", "replace"],
  ),
  execute(input, context) {
    try {
      if (!input.search)
        return Promise.resolve(failureResult("Search string cannot be empty."));
      const target = resolveExistingPath(
        context.workspaceDir,
        input.path,
        undefined,
        canAccessOutsideWorkspace(context),
      );
      assertAllowedWorkspacePath(context.workspaceDir, target);
      const stat = statSync(target);
      if (!stat.isFile())
        return Promise.resolve(
          failureResult("Path is not a file.", { path: target }),
        );
      if (stat.size > DEFAULT_MAX_WRITE_BYTES)
        return Promise.resolve(
          failureResult("edit_file target exceeds maximum edit size."),
        );
      const content = readFileSync(target, "utf8");
      const occurrences = content.split(input.search).length - 1;
      if (occurrences === 0)
        return Promise.resolve(
          failureResult("Search string not found.", {
            path: target,
            replacements: 0,
          }),
        );
      const next = input.replace_all
        ? content.split(input.search).join(input.replace)
        : content.replace(input.search, input.replace);
      atomicWriteFile(target, next);
      invalidateReadCache(target);
      return Promise.resolve(
        successResult("File edited.", {
          path: target,
          replacements: input.replace_all ? occurrences : 1,
          remaining_occurrences: input.replace_all ? 0 : occurrences - 1,
        }),
      );
    } catch (error) {
      return Promise.resolve(pathFailure(error, "File edit failed."));
    }
  },
};

const editRangeTool: ToolDefinition<EditRangeInput> = {
  name: "edit_range",
  description:
    "Replace an inclusive line range in a file, then refresh context when available.",
  category: "general",
  risk: "high",
  inputSchema: editRangeInput,
  parameters: parameters(
    {
      path: { type: "string" },
      start_line: { type: "number" },
      end_line: { type: "number" },
      replacement: { type: "string" },
      expected_old: { type: "string" },
      create_trailing_newline: { type: "boolean" },
    },
    ["path", "start_line", "end_line", "replacement"],
  ),
  execute(input, context) {
    try {
      const target = resolveExistingPath(
        context.workspaceDir,
        input.path,
        undefined,
        canAccessOutsideWorkspace(context),
      );
      assertAllowedWorkspacePath(context.workspaceDir, target);
      const original = readFileSync(target, "utf8");
      const hadTrailingNewline = original.endsWith("\n");
      const lines = hadTrailingNewline
        ? original.split("\n").slice(0, -1)
        : original.split("\n");
      const start = input.start_line;
      const end = Math.min(Math.max(input.end_line, start), lines.length);
      const oldText = lines.slice(start - 1, end).join("\n");
      if (input.expected_old !== undefined && input.expected_old !== oldText)
        return Promise.resolve(
          failureResult("expected_old does not match selected range.", {
            path: target,
            selected: oldText,
          }),
        );
      const replacementLines =
        input.replacement === "" ? [] : input.replacement.split("\n");
      const nextLines = [
        ...lines.slice(0, start - 1),
        ...replacementLines,
        ...lines.slice(end),
      ];
      const next =
        nextLines.join("\n") +
        (input.create_trailing_newline !== false && hadTrailingNewline
          ? "\n"
          : "");
      atomicWriteFile(target, next);
      invalidateReadCache(target);
      return Promise.resolve(
        successResult("File range edited.", {
          path: target,
          start_line: start,
          end_line: end,
        }),
      );
    } catch (error) {
      return Promise.resolve(pathFailure(error, "File range edit failed."));
    }
  },
};

const lsTool: ToolDefinition<LsInput> = {
  name: "ls",
  description:
    "List directory contents. Use this to list a directory; do not use bash, find, or glob for plain directory listing.",
  category: "general",
  risk: "safe",
  inputSchema: lsInput,
  parameters: parameters({
    path: { type: "string", default: "." },
    show_hidden: { type: "boolean" },
  }),
  execute(input, context) {
    try {
      const target = resolveExistingPath(
        context.workspaceDir,
        input.path ?? ".",
        undefined,
        canAccessOutsideWorkspace(context),
      );
      assertNotSkippedWorkspacePath(context.workspaceDir, target);
      const stat = statSync(target);
      if (!stat.isDirectory())
        return Promise.resolve(
          failureResult("Path is not a directory.", { path: target }),
        );
      const entries = readdirSync(target, { withFileTypes: true })
        .filter(
          (entry) => input.show_hidden === true || !entry.name.startsWith("."),
        )
        .filter((entry) => !SKIP_DIRS.has(entry.name))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
        }));
      return Promise.resolve(
        successResult("Directory listed.", {
          path: target,
          relative: toWorkspaceRelative(context.workspaceDir, target),
          entries,
        }),
      );
    } catch (error) {
      return Promise.resolve(pathFailure(error, "Directory listing failed."));
    }
  },
};

const mkdirTool: ToolDefinition<MkdirInput> = {
  name: "mkdir",
  description: "Create a directory recursively.",
  category: "general",
  risk: "high",
  inputSchema: mkdirInput,
  parameters: parameters({ path: { type: "string" } }, ["path"]),
  execute(input, context) {
    try {
      const target = validatePath(context.workspaceDir, input.path, {
        allowMissingLeaf: true,
        allowOutsideWorkspace: canAccessOutsideWorkspace(context),
      });
      assertAllowedWorkspacePath(context.workspaceDir, target);
      mkdirSync(target, { recursive: true });
      return Promise.resolve(
        successResult("Directory created.", { path: target }),
      );
    } catch (error) {
      return Promise.resolve(
        failureResult(
          error instanceof Error ? error.message : "Directory creation failed.",
          null,
          true,
        ),
      );
    }
  },
};

const rmTool: ToolDefinition<RmInput> = {
  name: "rm",
  description: "Remove a file or directory inside the workspace.",
  category: "general",
  risk: "high",
  inputSchema: rmInput,
  parameters: parameters(
    { path: { type: "string" }, recursive: { type: "boolean" } },
    ["path"],
  ),
  execute(input, context) {
    try {
      const target = resolveExistingPath(
        context.workspaceDir,
        input.path,
        undefined,
        canAccessOutsideWorkspace(context),
      );
      assertAllowedWorkspacePath(context.workspaceDir, target);
      const workspaceRoot = workspaceRealPath(context.workspaceDir);
      const targetRoot = workspaceRealPath(target);
      if (workspaceRoot === targetRoot) {
        return Promise.resolve(
          failureResult("Refusing to remove the workspace root.", { path: target }, true),
        );
      }
      if (!existsSync(target))
        return Promise.resolve(
          successResult("Path did not exist.", {
            path: target,
            removed: false,
          }),
        );
      const stat = lstatSync(target);
      if (stat.isDirectory()) {
        if (input.recursive !== true)
          return Promise.resolve(
            failureResult("Path is a directory; use recursive=true.", {
              path: target,
            }),
          );
        rmSync(target, { recursive: true, force: false });
      } else {
        unlinkSync(target);
      }
      invalidateReadCache(target);
      return Promise.resolve(
        successResult("Path removed.", { path: target, removed: true }),
      );
    } catch (error) {
      return Promise.resolve(pathFailure(error, "Remove failed."));
    }
  },
};

const existsTool: ToolDefinition<ExistsInput> = {
  name: "exists",
  description: "Check if a file or directory exists.",
  category: "general",
  risk: "safe",
  inputSchema: existsInput,
  parameters: parameters({ path: { type: "string" } }, ["path"]),
  execute(input, context) {
    try {
      const target = resolveExistingPath(
        context.workspaceDir,
        input.path,
        undefined,
        canAccessOutsideWorkspace(context),
      );
      assertAllowedWorkspacePath(context.workspaceDir, target);
      const exists = existsSync(target);
      if (!exists)
        return Promise.resolve(
          successResult("Path checked.", { path: input.path, exists: false }),
        );
      const stat = statSync(target);
      return Promise.resolve(
        successResult("Path checked.", {
          path: target,
          exists: true,
          type: stat.isDirectory() ? "directory" : "file",
          size: stat.size,
        }),
      );
    } catch (error) {
      return Promise.resolve(
        failureResult(
          error instanceof Error ? error.message : "Path check failed.",
        ),
      );
    }
  },
};


export const fileTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  appendFileTool,
  editFileTool,
  editRangeTool,
  lsTool,
  mkdirTool,
  rmTool,
  existsTool,
];
