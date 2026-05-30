import type { SkillFileRecord, SkillImportRequest, SkillImportValidationResult, SkillRecord } from "@shared/types";

export type VisibleLibraryKey = "plugins" | "skills" | "mcp" | "artifacts";
export type FileViewMode = "preview" | "code";

export interface SkillDraft {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  autoRouting: boolean;
  files?: SkillFileRecord[];
}

export interface FileTreeNode {
  name: string;
  path: string;
  file?: SkillFileRecord;
  children: FileTreeNode[];
}

export interface PendingImport {
  request: SkillImportRequest;
  preview: SkillImportValidationResult;
}

export const asSkillDraft = (skill: SkillRecord): SkillDraft => ({
  id: skill.id,
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  enabled: skill.enabled,
  autoRouting: skill.autoRouting,
  files: skill.files,
});
