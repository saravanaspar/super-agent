import { createHash } from "node:crypto";
import type { SkillFileRecord } from "@shared/types";
import { skillFileToBuffer } from "./skillFileData";

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^\.\//, "").trim();

export const hashSkillFiles = (files: SkillFileRecord[]): string => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path)))) {
    hash.update(normalizePath(file.path));
    hash.update("\0");
    hash.update(skillFileToBuffer(file));
    hash.update("\0");
  }
  return hash.digest("hex");
};
