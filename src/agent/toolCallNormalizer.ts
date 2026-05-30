import type { ProviderRequest } from "@providers/interfaces/provider";
import type { ToolRegistry } from "@tool-registry/toolRegistry";
import type { JsonRecord } from "@shared/json";
import type { ToolCallRecord } from "@shared/types";

type ProviderTool = ProviderRequest["tools"][number];

const READ_TOOL_NAME = "read_file";

const DEFAULT_READ_LIMIT = 80;
const MAX_READ_LIMIT = 400;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const providerToolName = (tool: ProviderTool): string | null => {
  const record = tool as unknown;

  if (!isRecord(record)) {
    return null;
  }

  if (typeof record.name === "string") {
    return record.name;
  }

  const functionRecord = record.function;

  if (isRecord(functionRecord) && typeof functionRecord.name === "string") {
    return functionRecord.name;
  }

  return null;
};

const readNumberLike = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
};

const clampInteger = (
  value: number,
  minimum: number,
  maximum: number
): number => Math.min(Math.max(Math.floor(value), minimum), maximum);

const isReadToolName = (name: string): boolean =>
  name === READ_TOOL_NAME;

const normalizeReadInput = (input: JsonRecord): JsonRecord => {
  const normalized: JsonRecord = { ...input };
  const offset = readNumberLike(normalized.offset);
  const limit = readNumberLike(normalized.limit);

  if (offset !== null) {
    normalized.offset = Math.max(1, Math.floor(offset));
  } else if ("offset" in normalized) {
    normalized.offset = 1;
  }

  if (limit !== null) {
    normalized.limit = clampInteger(limit, 1, MAX_READ_LIMIT);
  } else if ("limit" in normalized) {
    normalized.limit = DEFAULT_READ_LIMIT;
  }

  return normalized;
};

export const canonicalizeProviderTools = (
  tools: ProviderTool[]
): ProviderTool[] => {
  const seenCanonicalNames = new Set<string>();

  return tools.filter(tool => {
    const name = providerToolName(tool);

    if (!name) {
      return true;
    }

    const canonicalName = name;

    if (seenCanonicalNames.has(canonicalName)) {
      return false;
    }

    seenCanonicalNames.add(canonicalName);
    return true;
  });
};

export const normalizeToolCall = (
  registry: ToolRegistry,
  call: ToolCallRecord
): ToolCallRecord => {
  const name = call.name;
  const input = isReadToolName(name)
    ? normalizeReadInput(call.input)
    : call.input;
  const tool = registry.get(name);

  return {
    ...call,
    name,
    input,
    risk: tool?.risk ?? call.risk
  };
};