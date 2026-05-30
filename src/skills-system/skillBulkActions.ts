import type { SkillAuditLogRecord, SkillRecord, SkillUpdateRequest, SkillVerificationResult } from "@shared/types";

export type SkillBulkAction = "enable" | "disable" | "pin" | "unpin" | "archive" | "restore" | "verify";

export interface SkillBulkRunner {
  get(skillId: string): SkillRecord | null;
  update(request: SkillUpdateRequest): SkillRecord;
  updateLifecycle(skillId: string, action: "pin" | "unpin" | "archive" | "restore"): SkillRecord;
  verifySkill(skillId: string): SkillVerificationResult;
  recordAuditLog(input: Omit<SkillAuditLogRecord, "id" | "createdAt">): SkillAuditLogRecord;
}

export interface SkillBulkActionResult {
  action: SkillBulkAction;
  results: Array<{ skillId: string; status: "ok" | "failed"; message: string }>;
}

const updateEnabledState = (
  runner: SkillBulkRunner,
  skill: SkillRecord,
  enabled: boolean,
): void => {
  runner.update({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    enabled,
    autoRouting: enabled ? skill.autoRouting : false,
    files: skill.files,
    version: skill.version,
  });
};

export const runBulkSkillAction = (
  runner: SkillBulkRunner,
  skillIds: string[],
  action: SkillBulkAction,
): SkillBulkActionResult => {
  const results: SkillBulkActionResult["results"] = [];
  for (const skillId of skillIds) {
    try {
      if (action === "verify") {
        const result = runner.verifySkill(skillId);
        results.push({ skillId, status: "ok", message: `verification ${result.status}` });
        continue;
      }
      const skill = runner.get(skillId);
      if (!skill) throw new Error("Skill not found.");
      if (action === "pin" || action === "unpin" || action === "archive" || action === "restore") {
        runner.updateLifecycle(skillId, action);
        results.push({ skillId, status: "ok", message: `${action} applied.` });
      } else {
        updateEnabledState(runner, skill, action === "enable");
        results.push({ skillId, status: "ok", message: `${action} applied.` });
      }
    } catch (error) {
      results.push({ skillId, status: "failed", message: error instanceof Error ? error.message : "Action failed." });
    }
  }
  runner.recordAuditLog({
    action: `skill.bulk.${action}`,
    skillId: null,
    skillName: null,
    actor: "user",
    status: results.some((item) => item.status === "failed") ? "warning" : "ok",
    packageHash: null,
    detail: { action, results },
  });
  return { action, results };
};
