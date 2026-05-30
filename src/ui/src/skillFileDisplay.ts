import type { SkillFileRecord } from "@shared/types";

export const isBinarySkillFile = (file: SkillFileRecord): boolean =>
  file.encoding === "base64";

export const skillFileDisplaySize = (file: SkillFileRecord): number => {
  if (!isBinarySkillFile(file)) return file.content.length;
  const padding = file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((file.content.length * 3) / 4) - padding);
};

export const skillFileDisplayContent = (file: SkillFileRecord): string =>
  isBinarySkillFile(file) ? "" : file.content;
