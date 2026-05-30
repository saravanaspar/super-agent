import type { SkillFileRecord, SkillPatchRequest, SkillProposalRecord, SkillRecord } from "@shared/types";
import { mergedFiles } from "./skillContext";

export const normalizePatchPath = (path: string): string => {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..") || normalized.includes("\0")) {
    throw new Error(`Unsafe skill patch path: ${path}`);
  }
  return normalized;
};

export const applyPatchOperations = (files: SkillFileRecord[], patch: SkillPatchRequest): SkillFileRecord[] => {
  const map = new Map(files.map((file) => [file.path, file.content]));
  for (const operation of patch.operations) {
    const path = normalizePatchPath(operation.path);
    if (operation.op === "delete") {
      if (path === "SKILL.md") throw new Error("SKILL.md cannot be deleted from a skill package.");
      map.delete(path);
      continue;
    }
    if (operation.op === "rename") {
      if (!operation.toPath) throw new Error("Rename operations require toPath.");
      const toPath = normalizePatchPath(operation.toPath);
      if (!map.has(path)) throw new Error(`Cannot rename missing skill file: ${path}`);
      const content = map.get(path) ?? "";
      map.delete(path);
      map.set(toPath, content);
      continue;
    }
    if (typeof operation.content !== "string") throw new Error(`${operation.op} operations require content.`);
    if (operation.op === "create" && map.has(path)) throw new Error(`Skill file already exists: ${path}`);
    map.set(path, operation.content);
  }
  return Array.from(map, ([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path));
};

export const selectedProposalFiles = (proposal: SkillProposalRecord, existing: SkillRecord | null | undefined, acceptedPaths: string[] | undefined): SkillFileRecord[] => {
  if (!acceptedPaths) return proposal.proposedFiles;
  const accepted = new Set(acceptedPaths.map(normalizePatchPath));
  if (accepted.size === 0) throw new Error("At least one proposed file change must be selected.");
  const current = new Map((existing ? mergedFiles(existing) : []).map((file) => [normalizePatchPath(file.path), file.content]));
  const proposed = new Map(proposal.proposedFiles.map((file) => [normalizePatchPath(file.path), file.content]));
  for (const item of proposal.diff) {
    const path = normalizePatchPath(item.path);
    if (!accepted.has(path)) continue;
    if (item.status === "deleted") current.delete(path);
    else {
      const content = proposed.get(path);
      if (content === undefined) throw new Error(`Proposed file missing: ${path}`);
      current.set(path, content);
    }
  }
  return Array.from(current, ([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path));
};
