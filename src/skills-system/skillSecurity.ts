import type { SkillFileRecord, SkillScanFinding, SkillTrustLevel } from "@shared/types";
import { skillFileText } from "./skillFileData";
import { analyzeSkillContent } from "./skillStaticAnalyzer";

const isPromptLikePath = (path: string): boolean => {
  const lower = path.toLowerCase();
  return path === "SKILL.md" || path.startsWith("references/") || [".md", ".mdx", ".txt", ".yaml", ".yml", ".json"].some((ext) => lower.endsWith(ext));
};

const isScriptLikePath = (path: string): boolean => {
  const lower = path.toLowerCase();
  return path.startsWith("scripts/") || [".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1"].some((ext) => lower.endsWith(ext));
};

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^\.\//, "").trim();

export const scanSkillFiles = (files: SkillFileRecord[]): SkillScanFinding[] => {
  const seen = new Set<string>();
  const findings: SkillScanFinding[] = [];

  for (const file of files) {
    const path = normalizePath(file.path);
    const content = skillFileText(file);
    if (!content) continue;
    for (const finding of analyzeSkillContent({
      path,
      content,
      promptLike: isPromptLikePath(path),
      scriptLike: isScriptLikePath(path),
    })) {
      const key = `${finding.path ?? path}:${finding.ruleId}:${finding.line ?? 0}:${finding.excerpt ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(finding);
    }
  }

  return findings;
};

export const criticalSkillFinding = (
  findings: SkillScanFinding[],
): SkillScanFinding | null => findings.find((finding) => finding.severity === "critical") ?? null;

export const trustLevelForSkill = (
  source: "workspace" | "repo" | "user" | "plugin" | "global" | "built-in" | "local",
  findings: SkillScanFinding[],
): SkillTrustLevel => {
  if (source === "built-in") return "built-in";
  if (criticalSkillFinding(findings)) return "quarantined";
  if (source === "plugin" || source === "global") return "community";
  if (source === "local") return "uploaded";
  return "local";
};
