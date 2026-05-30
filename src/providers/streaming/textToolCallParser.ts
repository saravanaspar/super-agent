import { randomUUID } from "node:crypto";
import { asJsonRecord } from "@shared/json";
import type { JsonRecord } from "@shared/json";
import type { ToolCallRecord } from "@shared/types";
import { normalizeToolCall } from "@providers/shared/toolNormalization";

interface TagMatch {
  index: number;
  tag: string;
}

export interface TextToolParseResult {
  text: string;
  toolCalls: ToolCallRecord[];
}

const TEXT_TOOL_START_TAGS = ["<|tool_call>", "<tool_call>"];
const TEXT_TOOL_END_TAGS = [
  "<|tool_call|>",
  "<tool_call|>",
  "</tool_call>",
  "<|/tool_call|>",
  "</tool_call|>"
];

const parseJsonRecord = (value: string): JsonRecord | undefined => {
  if (!value.trim()) return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    const record = asJsonRecord(parsed);
    return Object.keys(record).length > 0 ? record : { value };
  } catch {
    return { value };
  }
};

const quoteLooseObjectKeys = (value: string): string =>
  value.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*:/g, '$1"$2":');

const parseLooseJsonRecord = (value: string): JsonRecord | undefined => {
  const trimmed = value.trim();

  if (!trimmed || trimmed === "{}") {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return asJsonRecord(parsed);
  } catch {
    // Continue with loose-object normalization.
  }

  try {
    const parsed: unknown = JSON.parse(quoteLooseObjectKeys(trimmed));
    return asJsonRecord(parsed);
  } catch {
    return undefined;
  }
};

const parseToolArgumentsRecord = (value: string): JsonRecord => {
  const parsed = parseLooseJsonRecord(value);

  if (parsed) {
    return parsed;
  }

  return parseJsonRecord(value) ?? {};
};

const findFirstTag = (value: string, tags: string[]): TagMatch | null => {
  let result: TagMatch | null = null;

  for (const tag of tags) {
    const index = value.indexOf(tag);

    if (index === -1) {
      continue;
    }

    if (!result || index < result.index) {
      result = { index, tag };
    }
  }

  return result;
};

const longestPartialStartTagSuffixLength = (value: string): number => {
  const maxLength = Math.min(
    value.length,
    Math.max(...TEXT_TOOL_START_TAGS.map((tag) => tag.length)) - 1
  );

  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);

    if (TEXT_TOOL_START_TAGS.some((tag) => tag.startsWith(suffix))) {
      return length;
    }
  }

  return 0;
};

const stripOptionalCodeFence = (value: string): string => {
  const trimmed = value.trim();

  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json|javascript|typescript)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
};

const normalizeTextToolArguments = (value: string): string => {
  const trimmed = value.trim();

  if (!trimmed) {
    return "{}";
  }

  if (trimmed === "()") {
    return "{}";
  }

  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner || "{}";
  }

  return trimmed;
};

const parseTextToolCallBody = (value: string): ToolCallRecord | null => {
  const body = stripOptionalCodeFence(value);
  const match =
    /^call\s*:\s*([A-Za-z_][A-Za-z0-9_.-]*)([\s\S]*)$/i.exec(body) ??
    /^([A-Za-z_][A-Za-z0-9_.-]*)([\s\S]*)$/i.exec(body);

  if (!match) {
    return null;
  }

  const name = match[1] ?? "";
  const rawArguments = normalizeTextToolArguments(match[2] ?? "");
  const normalized = normalizeToolCall({
    name,
    arguments: parseToolArgumentsRecord(rawArguments)
  });

  return {
    ...normalized,
    id: randomUUID()
  };
};

export class TextToolCallParser {
  private buffer = "";

  push(value: string): TextToolParseResult {
    this.buffer += value;

    const textParts: string[] = [];
    const toolCalls: ToolCallRecord[] = [];

    while (this.buffer.length > 0) {
      const startMatch = findFirstTag(this.buffer, TEXT_TOOL_START_TAGS);

      if (!startMatch) {
        const keepLength = longestPartialStartTagSuffixLength(this.buffer);
        const flushLength = this.buffer.length - keepLength;

        if (flushLength > 0) {
          textParts.push(this.buffer.slice(0, flushLength));
          this.buffer = this.buffer.slice(flushLength);
        }

        break;
      }

      if (startMatch.index > 0) {
        textParts.push(this.buffer.slice(0, startMatch.index));
        this.buffer = this.buffer.slice(startMatch.index);
      }

      const bodyStartIndex = startMatch.tag.length;
      const remaining = this.buffer.slice(bodyStartIndex);
      const endMatch = findFirstTag(remaining, TEXT_TOOL_END_TAGS);

      if (!endMatch) {
        break;
      }

      const rawToolCall = remaining.slice(0, endMatch.index).trim();
      const parsedToolCall = parseTextToolCallBody(rawToolCall);

      if (parsedToolCall) {
        toolCalls.push(parsedToolCall);
      }

      this.buffer = remaining.slice(endMatch.index + endMatch.tag.length);
    }

    return {
      text: textParts.join(""),
      toolCalls
    };
  }

  flushText(): string {
    const value = this.buffer;
    this.buffer = "";
    return value;
  }
}
