import type { JsonRecord, JsonValue } from "@shared/json";
import { asJsonRecord } from "@shared/json";
import type { ToolCallRecord, ToolRisk } from "@shared/types";

const parseArguments = (value: string | JsonRecord | undefined): JsonRecord => {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    return asJsonRecord(JSON.parse(value));
  } catch {
    return { raw: value };
  }
};

export const normalizeToolCall = (input: {
  id?: string;
  name: string;
  arguments?: string | JsonRecord;
  risk?: ToolRisk;
  raw?: JsonValue;
}): ToolCallRecord => ({
  id: input.id ?? crypto.randomUUID(),
  name: input.name,
  risk: input.risk ?? "medium",
  input: parseArguments(input.arguments)
});
