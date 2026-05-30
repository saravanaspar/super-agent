import { asJsonRecord } from "@shared/json";
import type { JsonRecord } from "@shared/json";

export interface RawToolCall {
  name: string;
  arguments?: JsonRecord;
}

export interface ToolMarkupFilterState {
  pending: string;
}

export interface ToolMarkupFilterResult {
  content: string;
  calls: RawToolCall[];
}

const rawToolPrefixes = [
  "<tool_call",
  "</tool_call",
  "<tool_response",
  "</tool_response",
  '[{"tool"',
  '{"tool"',
  '[{"name"',
  '{"name"'
];

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const parseArguments = (value: unknown): JsonRecord | undefined => {
  if (value === null || value === undefined || value === "") return undefined;

  if (typeof value === "string") {
    try {
      return asJsonRecord(JSON.parse(value));
    } catch {
      return { value };
    }
  }

  return asJsonRecord(value);
};

const findJsonEnd = (input: string): number | null => {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) return null;
      if (stack.length === 0) return index + 1;
    }
  }

  return null;
};

const rawToolCallFromRecord = (value: unknown): RawToolCall | null => {
  const record = asJsonRecord(value);
  const fn = asJsonRecord(record.function);
  const name =
    readString(record.tool) || readString(record.name) || readString(fn.name);

  if (!name) return null;

  const args =
    parseArguments(record.args) ||
    parseArguments(record.arguments) ||
    parseArguments(fn.arguments);

  return args ? { name, arguments: args } : { name };
};

const rawToolCallsFromJson = (value: unknown): RawToolCall[] => {
  if (Array.isArray(value)) {
    return value
      .map(rawToolCallFromRecord)
      .filter((call): call is RawToolCall => call !== null);
  }

  const record = asJsonRecord(value);
  if (Array.isArray(record.tool_calls)) return rawToolCallsFromJson(record.tool_calls);

  const call = rawToolCallFromRecord(record);
  return call ? [call] : [];
};

const findRawTagIndex = (input: string): number => {
  const indexes = [
    input.indexOf("<tool_call"),
    input.indexOf("</tool_call"),
    input.indexOf("<tool_response"),
    input.indexOf("</tool_response"),
    input.indexOf("|>")
  ].filter((index) => index >= 0);

  return indexes.length > 0 ? Math.min(...indexes) : -1;
};

const consumeRawTag = (input: string): string => {
  if (input.startsWith("|>")) return input.slice(2);

  const closeIndex = input.indexOf(">");
  return closeIndex === -1 ? "" : input.slice(closeIndex + 1);
};

const partialRawPrefixLength = (input: string): number => {
  const lower = input.toLowerCase();

  for (let length = Math.min(input.length, 32); length > 0; length -= 1) {
    const suffix = lower.slice(-length);

    if (rawToolPrefixes.some((prefix) => prefix.startsWith(suffix))) {
      return length;
    }
  }

  return 0;
};

const consumeJsonToolCall = (
  input: string
): { rest: string; calls: RawToolCall[] } | null => {
  const trimmed = input.trimStart();
  const first = trimmed[0];

  if (first !== "[" && first !== "{") return null;

  const jsonEnd = findJsonEnd(trimmed);
  if (jsonEnd === null) return { rest: input, calls: [] };

  try {
    const calls = rawToolCallsFromJson(JSON.parse(trimmed.slice(0, jsonEnd)));
    if (calls.length === 0) return null;

    return {
      rest: trimmed.slice(jsonEnd).replace(/^\s+/, ""),
      calls
    };
  } catch {
    return null;
  }
};

export const filterRawToolMarkup = (
  input: string,
  state: ToolMarkupFilterState
): ToolMarkupFilterResult => {
  state.pending += input;

  let content = "";
  const calls: RawToolCall[] = [];

  while (state.pending.length > 0) {
    const jsonResult = consumeJsonToolCall(state.pending);

    if (jsonResult) {
      if (jsonResult.calls.length === 0) return { content, calls };
      calls.push(...jsonResult.calls);
      state.pending = jsonResult.rest;
      continue;
    }

    const tagIndex = findRawTagIndex(state.pending);

    if (tagIndex >= 0) {
      content += state.pending.slice(0, tagIndex);
      state.pending = consumeRawTag(state.pending.slice(tagIndex));
      continue;
    }

    const heldLength = partialRawPrefixLength(state.pending);
    const flushLength = state.pending.length - heldLength;

    if (flushLength === 0) break;

    content += state.pending.slice(0, flushLength);
    state.pending = state.pending.slice(flushLength);
  }

  return { content, calls };
};

export const flushRawToolMarkup = (
  state: ToolMarkupFilterState
): ToolMarkupFilterResult => {
  const result = filterRawToolMarkup("", state);

  if (state.pending.length === 0) return result;

  if (findRawTagIndex(state.pending) >= 0) {
    state.pending = "";
    return result;
  }

  const jsonResult = consumeJsonToolCall(state.pending);

  if (jsonResult?.calls.length) {
    state.pending = jsonResult.rest;
    return {
      content: result.content,
      calls: [...result.calls, ...jsonResult.calls]
    };
  }

  const content = result.content + state.pending;
  state.pending = "";

  return { content, calls: result.calls };
};