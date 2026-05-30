import type { JsonRecord, JsonValue } from "./json";

const REDACTED = "[redacted]";
const sensitiveKeyPattern = /(?:api[_-]?key|authorization|bearer|token|secret|password|private[_-]?key|credential)/i;
const privateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g;
const assignmentSecretPattern = /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*=\s*([^\s"']{8,}|["'][^"']{8,}["'])/gi;
const longSecretPattern = /\b(?:sk|nvapi|gsk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/g;

export const redactSensitiveText = (value: string): string =>
  value
    .replace(privateKeyPattern, REDACTED)
    .replace(bearerPattern, `Bearer ${REDACTED}`)
    .replace(assignmentSecretPattern, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(longSecretPattern, REDACTED);

export const redactSensitiveJson = (value: JsonValue): JsonValue => {
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object" || value === null) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveJson(item));
  }

  const output: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = sensitiveKeyPattern.test(key) ? REDACTED : redactSensitiveJson(item);
  }
  return output;
};
