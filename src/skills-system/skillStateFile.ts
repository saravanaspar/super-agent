import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SkillRecord } from "@shared/types";

interface StoredSkillState {
  enabled?: boolean;
  autoRouting?: boolean;
  pinned?: boolean;
  lifecycleState?: SkillRecord["lifecycleState"];
  archivedAt?: string | null;
  trustOverrideAt?: string;
  trustOverrideReason?: string;
  trustOverridePackageHash?: string | null;
}

interface SkillStateFile {
  schemaVersion: 1;
  skills: Record<string, StoredSkillState>;
}

const defaultState = (): SkillStateFile => ({ schemaVersion: 1, skills: {} });

export const skillStateFilePath = (workspaceDir?: string): string => {
  void workspaceDir;
  return join(resolve(homedir(), ".super-agent"), "skill-state.json");
};

const stateKeys = (skill: Pick<SkillRecord, "id" | "sourcePath" | "rootPath">): string[] =>
  [skill.sourcePath, skill.rootPath ? `${skill.rootPath}::${skill.id}` : null, skill.id]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

const readStateFile = (workspaceDir?: string): SkillStateFile => {
  const path = skillStateFilePath(workspaceDir);
  if (!existsSync(path)) return defaultState();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return defaultState();
    const record = parsed as Partial<SkillStateFile>;
    return {
      schemaVersion: 1,
      skills: record.skills && typeof record.skills === "object" ? record.skills : {},
    };
  } catch {
    return defaultState();
  }
};

const writeStateFile = (workspaceDir: string | undefined, state: SkillStateFile): void => {
  const path = skillStateFilePath(workspaceDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
};

export const readPersistedSkillState = (
  workspaceDir: string | undefined,
  skill: Pick<SkillRecord, "id" | "sourcePath" | "rootPath">,
): StoredSkillState | null => {
  const state = readStateFile(workspaceDir);
  for (const key of stateKeys(skill)) {
    const entry = state.skills[key];
    if (entry) return entry;
  }
  return null;
};

export const persistSkillState = (
  workspaceDir: string | undefined,
  skill: SkillRecord,
  update: StoredSkillState = {},
): void => {
  const state = readStateFile(workspaceDir);
  const keys = stateKeys(skill);
  if (!keys.length) return;
  const current = keys.map((key) => state.skills[key]).find(Boolean) ?? {};
  const next: StoredSkillState = {
    ...current,
    enabled: skill.enabled,
    autoRouting: skill.autoRouting,
    pinned: skill.pinned === true,
    lifecycleState: skill.lifecycleState ?? "active",
    archivedAt: skill.archivedAt ?? null,
    ...update,
  };
  for (const key of keys) state.skills[key] = next;
  writeStateFile(workspaceDir, state);
};

export const hasTrustedOverride = (
  workspaceDir: string | undefined,
  skill: SkillRecord,
): boolean => {
  const state = readPersistedSkillState(workspaceDir, skill);
  if (!state?.trustOverrideAt) return false;
  if (state.trustOverridePackageHash && skill.packageHash && state.trustOverridePackageHash !== skill.packageHash) {
    return false;
  }
  return true;
};

export const clearSkillState = (workspaceDir: string | undefined, skill: SkillRecord): void => {
  const state = readStateFile(workspaceDir);
  for (const key of stateKeys(skill)) delete state.skills[key];
  writeStateFile(workspaceDir, state);
};
