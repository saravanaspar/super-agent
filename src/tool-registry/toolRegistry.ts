import type { JsonRecord } from "@shared/json";
import type { ToolCallRecord, ToolResultRecord } from "@shared/types";
import type { ToolDefinition, ToolExecutionContext, ToolRegistryEntry } from "./types";

const numericInputKeys = new Set([
  "after",
  "before",
  "deadline_ms",
  "end_line",
  "limit",
  "max_depth",
  "max_file_bytes",
  "max_files",
  "max_output_bytes",
  "max_preview_chars",
  "max_results",
  "offset",
  "start_line",
  "timeout",
  "timeout_ms",
  "timeoutMs"
]);

const booleanInputKeys = new Set([
  "allow_large",
  "create_dirs",
  "create_trailing_newline",
  "dry_run",
  "exact",
  "force",
  "include_chapter_previews",
  "include_digest",
  "include_disabled",
  "recursive",
  "replace_all",
  "sandbox",
  "show_hidden"
]);

const normalizeToolInputValue = (key: string, value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeToolInputValue(key, item));
  }

  if (value && typeof value === "object") {
    return normalizeToolInputObject(value as JsonRecord);
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  if (booleanInputKeys.has(key) && /^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }

  if (numericInputKeys.has(key) && /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return value;
};

const normalizeToolInputObject = (input: JsonRecord): JsonRecord => {
  const normalized: JsonRecord = {};

  for (const [key, value] of Object.entries(input)) {
    normalized[key] = normalizeToolInputValue(key, value) as JsonRecord[string];
  }

  return normalized;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  list(): ToolRegistryEntry[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      risk: tool.risk,
      parameters: tool.parameters
    }));
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  toProviderTools() {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      risk: tool.risk
    }));
  }

  async execute(call: ToolCallRecord, context: ToolExecutionContext): Promise<ToolResultRecord> {
    const tool = this.get(call.name);
    if (!tool) {
      return { toolCallId: call.id, toolName: call.name, ok: false, blocked: false, risk: call.risk, message: `Unknown tool: ${call.name}`, data: null };
    }
    const parsed = tool.inputSchema.safeParse(normalizeToolInputObject(call.input));
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        ok: false,
        blocked: false,
        risk: call.risk,
        message: "Tool input failed validation.",
        data: { issues: parsed.error.issues.map((issue) => issue.message) } as JsonRecord
      };
    }
    const result = await tool.execute(parsed.data, context);
    return { toolCallId: call.id, toolName: tool.name, risk: call.risk, ...result };
  }
}
