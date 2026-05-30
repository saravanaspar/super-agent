import type {
  SkillContextHeatmapItem,
  SkillContextReference,
  SkillContextSnapshot,
  SkillContextWarning,
  SkillRootSyncResult,
  SkillRecord,
} from "@shared/types";
import type { PluginSkillRootInput } from "./skillRoots";
import type { SkillSecretCodec } from "./skillCredentials";

export const MIN_SKILL_CONTEXT_RATIO = 0.02;
export const MAX_SKILL_CONTEXT_RATIO = 0.05;
export const MAX_AUTO_SKILLS = 5;
export const CHARS_PER_TOKEN = 4;
export const MAX_CATALOG_DESCRIPTION_CHARS = 220;
export const MAX_IMPORTED_FILE_BYTES = 25 * 1024 * 1024;
export const ZIP_EOCD_MIN_SIZE = 22;
export const ZIP_EOCD_MAX_COMMENT = 65_535;
export const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
export const ZIP_CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
export const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
export const ZIP_VERSION_NEEDED = 20;
export const ZIP64_SIZE_SENTINEL = 0xffffffff;

export interface SkillContextOptions {
  prompt: string;
  selectedSkillIds?: string[];
  contextWindow?: number;
  agentId?: string;
}

export interface RankedSkill {
  skill: SkillRecord;
  score: number;
  matchedTerms: string[];
}

export interface SkillRegistryOptions {
  workspaceDir?: string | undefined;
  userSkillRoot?: string | undefined;
  agentsSkillRoot?: string | undefined;
  builtInSkillRoot?: string | undefined;
  pluginRoots?: PluginSkillRootInput[] | undefined;
  onRootsChanged?: ((result: SkillRootSyncResult) => void) | undefined;
  credentialCodec?: SkillSecretCodec | null | undefined;
}

export interface SkillContextBuildResult {
  promptFragments: string[];
  references: SkillContextReference[];
  budgetTokens: number | null;
  usedTokens: number;
  warnings: SkillContextWarning[];
  heatmap: SkillContextHeatmapItem[];
  snapshots: SkillContextSnapshot[];
}

export interface ZipEntry {
  path: string;
  content: Buffer;
}
