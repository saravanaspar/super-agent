import type { SkillFileRecord, SkillRecord } from "@shared/types";
import { skillFileFromBuffer } from "./skillFileData";
import { resolveGitHubSkillSource, resolveGitHubSkillSourceFromApi } from "./skillDistribution";
import { normalizeSkillFilePath, readZipEntries, removeCommonArchiveRoot, stripRootFolder } from "./skillRegistrySupport";

export const resolveSkillUpdateSource = async (skill: SkillRecord): Promise<{ archiveUrl: string; skillPath: string | null }> => {
  if (skill.sourceArchiveUrl) {
    return { archiveUrl: skill.sourceArchiveUrl, skillPath: skill.sourceSubpath ?? null };
  }
  if (!skill.originUrl) throw new Error("Skill has no tracked origin URL.");
  try {
    const parsed = new URL(skill.originUrl);
    if (parsed.hostname === "github.com") {
      const source = skill.sourceSubpath
        ? resolveGitHubSkillSource(skill.originUrl, skill.sourceSubpath)
        : await resolveGitHubSkillSourceFromApi(skill.originUrl);
      return { archiveUrl: source.archiveUrl, skillPath: source.skillPath };
    }
  } catch {
    throw new Error("Skill origin URL is invalid.");
  }
  return { archiveUrl: skill.originUrl, skillPath: skill.sourceSubpath ?? null };
};

export const filesFromRemoteSkillArchive = (archive: Buffer, skillPath?: string): SkillFileRecord[] => {
  const allFiles = readZipEntries(archive).map<SkillFileRecord>((entry) =>
    skillFileFromBuffer(entry.path, entry.content)
  );
  const rootlessFiles = removeCommonArchiveRoot(allFiles);
  const normalizedPath = skillPath ? normalizeSkillFilePath(skillPath) : null;
  const scopedFiles = normalizedPath
    ? rootlessFiles.filter((file) =>
        file.path === `${normalizedPath}/SKILL.md` ||
        file.path.startsWith(`${normalizedPath}/`)
      )
    : rootlessFiles;
  return stripRootFolder(scopedFiles.length ? scopedFiles : rootlessFiles);
};
