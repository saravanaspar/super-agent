import { createHash } from "node:crypto";
import type { SkillAuditExport, SkillAuditExportVerification, SkillAuditLogRecord } from "@shared/types";

const auditHash = (event: SkillAuditLogRecord): string | null =>
  typeof event.detail.auditHash === "string" ? event.detail.auditHash : null;

const previousAuditHash = (event: SkillAuditLogRecord): string | null =>
  typeof event.detail.previousAuditHash === "string" ? event.detail.previousAuditHash : null;

const payloadHash = (payload: Omit<SkillAuditExport, "exportHash">): string =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

const exportOrder = (events: SkillAuditLogRecord[]): SkillAuditLogRecord[] =>
  [...events].reverse();

const candidateOrder = (events: SkillAuditLogRecord[]): SkillAuditLogRecord[] =>
  [...events];

export const buildSkillAuditExport = (
  events: SkillAuditLogRecord[],
  scope: SkillAuditExport["scope"],
): SkillAuditExport => {
  const ordered = exportOrder(events);
  const payload = {
    schemaVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    scope,
    events: ordered,
    firstHash: ordered.length ? auditHash(ordered[0] as SkillAuditLogRecord) : null,
    lastHash: ordered.length ? auditHash(ordered[ordered.length - 1] as SkillAuditLogRecord) : null,
  };
  return { ...payload, exportHash: payloadHash(payload) };
};

export const verifySkillAuditExport = (candidate: SkillAuditExport): SkillAuditExportVerification => {
  const errors: string[] = [];
  if (candidate.schemaVersion !== 1) errors.push("Unsupported audit export schema version.");
  const ordered = candidateOrder(candidate.events ?? []);
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index] as SkillAuditLogRecord;
    const previous = index > 0 ? ordered[index - 1] as SkillAuditLogRecord : null;
    const expectedPrevious = previous ? auditHash(previous) : previousAuditHash(current);
    if (previous && previousAuditHash(current) !== expectedPrevious) {
      errors.push(`Audit hash chain break at event ${current.id}.`);
    }
    if (!auditHash(current)) errors.push(`Audit event ${current.id} is missing auditHash.`);
  }
  const payload = {
    schemaVersion: 1 as const,
    exportedAt: candidate.exportedAt,
    scope: candidate.scope,
    events: candidate.events,
    firstHash: candidate.firstHash,
    lastHash: candidate.lastHash,
  };
  const computed = payloadHash(payload);
  if (candidate.exportHash !== computed) errors.push("Audit export hash does not match export payload.");
  const firstHash = ordered.length ? auditHash(ordered[0] as SkillAuditLogRecord) : null;
  const lastHash = ordered.length ? auditHash(ordered[ordered.length - 1] as SkillAuditLogRecord) : null;
  if (candidate.firstHash !== firstHash) errors.push("First audit hash does not match event list.");
  if (candidate.lastHash !== lastHash) errors.push("Last audit hash does not match event list.");
  return {
    ok: errors.length === 0,
    eventCount: ordered.length,
    firstHash,
    lastHash,
    exportHash: candidate.exportHash ?? null,
    errors,
  };
};
