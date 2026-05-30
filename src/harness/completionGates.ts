import type { JsonRecord } from "@shared/json";

export type GateStatus = "pass" | "fail" | "skipped" | "blocked" | "pending";

export interface CompletionGate {
  id: string;
  label: string;
  required: boolean;
  status: GateStatus;
  evidence?: string;
  reason?: string;
}

export const gate = (
  id: string,
  label: string,
  required: boolean,
  status: GateStatus,
  details: { evidence?: string; reason?: string } = {}
): CompletionGate => ({
  id,
  label,
  required,
  status,
  ...(details.evidence ? { evidence: details.evidence } : {}),
  ...(details.reason ? { reason: details.reason } : {})
});

export const summarizeGates = (gates: readonly CompletionGate[]): JsonRecord => ({
  pass: gates.filter(item => item.status === "pass").length,
  fail: gates.filter(item => item.status === "fail").length,
  blocked: gates.filter(item => item.status === "blocked").length,
  pending: gates.filter(item => item.status === "pending").length,
  skipped: gates.filter(item => item.status === "skipped").length,
  requiredIncomplete: gates.filter(item => item.required && item.status !== "pass" && item.status !== "skipped").map(item => item.id)
});
