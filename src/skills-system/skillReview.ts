import type {
  SkillContextReference,
  SkillContextWarning,
  SkillQualityReview,
  SkillRecord,
  SkillResourceManifestItem,
  SkillFileRecord,
} from "@shared/types";
import { validateGeneratedSkillQuality, validateSkillFiles } from "./skillValidation";
import { scanSkillFiles } from "./skillSecurity";

export const largeSkillWarnings = (
  skill: SkillRecord,
  manifest: SkillResourceManifestItem[],
  budgetTokens: number | null,
  injection: SkillContextReference["injection"],
): SkillContextWarning[] => {
  const warnings: SkillContextWarning[] = [];
  const supportFiles = manifest.filter((file) => file.path !== "SKILL.md");
  const supportTokens = supportFiles.reduce((total, file) => total + file.tokenEstimate, 0);
  const largest = [...supportFiles].sort((a, b) => b.tokenEstimate - a.tokenEstimate)[0];
  const threshold = budgetTokens ? Math.max(1000, Math.floor(budgetTokens * 0.2)) : 3000;

  if ((injection === "instructions" || injection === "catalog") && supportTokens >= threshold && largest) {
    warnings.push({
      severity: "info",
      code: "support-files-deferred",
      skillId: skill.id,
      path: largest.path,
      message: `${supportTokens} estimated tokens of supporting skill files were deferred. Largest file: ${largest.path} (${largest.tokenEstimate} tokens). Use skill.view only if needed.`,
    });
  }

  return warnings;
};


export const reviewSkillPackage = (files: SkillFileRecord[]): SkillQualityReview => {
  const structural = validateSkillFiles(files);
  const findings: SkillQualityReview["findings"] = [];
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!structural.valid) {
    findings.push({ severity: "critical", code: "invalid-structure", message: structural.message });
  }
  if (skillMd) {
    const quality = validateGeneratedSkillQuality(files);
    if (!quality.valid) {
      findings.push({ severity: "warn", code: "weak-instructions", message: quality.message });
    }
  } else {
    findings.push({ severity: "critical", code: "missing-skill-md", message: "Package must contain SKILL.md." });
  }
  for (const finding of scanSkillFiles(files)) {
    findings.push({
      severity: finding.severity,
      code: finding.ruleId,
      message: finding.message,
      ...(finding.path ? { path: finding.path } : {})
    });
  }
  const score = Math.max(0, 100 - findings.reduce((total, finding) => total + (finding.severity === "critical" ? 50 : finding.severity === "warn" ? 15 : 3), 0));
  const passed = !findings.some((finding) => finding.severity === "critical");
  return {
    passed,
    score,
    summary: passed ? "Skill package passed structural and safety review." : "Skill package has blocking review findings.",
    findings
  };
};
