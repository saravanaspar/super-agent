export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const toJsonValue = (value: unknown): JsonValue => {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]),
    );
  }
  return null;
};

export const toJsonRecord = (value: unknown): JsonRecord => {
  if (!isPlainRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]),
  );
};

export const asJsonRecord = (value: unknown): JsonRecord => toJsonRecord(value);

export const parseJsonRecord = (value: string | null | undefined): JsonRecord => {
  if (!value) return {};
  try {
    return asJsonRecord(JSON.parse(value));
  } catch {
    return {};
  }
};

export const toJson = (value: JsonValue): string => JSON.stringify(value);
