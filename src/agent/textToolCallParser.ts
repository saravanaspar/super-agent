import { toJsonRecord as normalizeJsonRecord, type JsonRecord } from "@shared/json";

export interface TextToolCall {
  id?: string;
  name: string;
  input: JsonRecord;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toJsonRecord = (value: unknown): JsonRecord => normalizeJsonRecord(value);

const readTextToolCall = (value: unknown): TextToolCall | null => {
  if (!isRecord(value)) {
    return null;
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";

  if (!name) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id : undefined;
  const input =
    value.arguments ??
    value.args ??
    value.input ??
    value.parameters ??
    {};

  const call: TextToolCall = {
    name,
    input: toJsonRecord(input)
  };

  if (id) {
    call.id = id;
  }

  return call;
};

const parseTextToolPayload = (payload: string): TextToolCall[] => {
  try {
    const parsed: unknown = JSON.parse(payload.trim());

    if (Array.isArray(parsed)) {
      return parsed
        .map(readTextToolCall)
        .filter((call): call is TextToolCall => call !== null);
    }

    if (isRecord(parsed) && Array.isArray(parsed.tools)) {
      return parsed.tools
        .map(readTextToolCall)
        .filter((call): call is TextToolCall => call !== null);
    }

    const single = readTextToolCall(parsed);

    return single ? [single] : [];
  } catch {
    return [];
  }
};

export const parseTextToolCalls = (content: string): TextToolCall[] => {
  const calls: TextToolCall[] = [];
  const toolBlockPattern = /<tools?>([\s\S]*?)<\/tools?>/gi;
  let match: RegExpExecArray | null = toolBlockPattern.exec(content);

  while (match) {
    const payload = match[1] ?? "";
    calls.push(...parseTextToolPayload(payload));
    match = toolBlockPattern.exec(content);
  }

  return calls;
};
