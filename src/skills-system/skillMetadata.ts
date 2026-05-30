import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { skillFileText } from "./skillFileData";
import type {
  SkillDependencyMetadata,
  SkillDependencyPackage,
  SkillFileRecord,
  SkillPermissionMetadata,
  SkillPreflightResult,
  SkillScriptPermissionMetadata,
} from "@shared/types";

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^\.\//, "").trim();

const stripQuotes = (value: string): string =>
  value.trim().replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "");

const unique = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

const defaultPermissions = (): SkillPermissionMetadata => ({
  allowNetwork: false,
  allowedEnv: [],
  writeRoots: [".", ".super-agent/skill-runs"],
  maxRuntimeMs: null,
  scripts: [],
});

const emptyMetadata = (): SkillDependencyMetadata => ({
  requiredBins: [],
  requiredEnv: [],
  requiredFiles: [],
  packages: [],
  platforms: [],
  permissions: defaultPermissions(),
});

const parseInlineList = (value: string): string[] | null => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  return trimmed
    .slice(1, -1)
    .split(",")
    .map(stripQuotes)
    .filter(Boolean);
};

const parseYamlListAfterKey = (content: string, key: string): string[] => {
  const lines = content.split(/\r?\n/);
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, "i").exec(line);
    if (!match) continue;
    const raw = match[1] ?? "";
    const inline = parseInlineList(raw);
    if (inline) values.push(...inline);
    if (raw.trim() && !inline) values.push(stripQuotes(raw));
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const child = lines[cursor] ?? "";
      if (!/^\s+-\s+/.test(child)) break;
      values.push(stripQuotes(child.replace(/^\s+-\s+/, "")));
    }
  }
  return values;
};

const parseBooleanAfterKey = (content: string, key: string): boolean | null => {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(true|false|yes|no|1|0)\\s*$`, "im").exec(content);
  if (!match) return null;
  const value = (match[1] ?? "").toLowerCase();
  return value === "true" || value === "yes" || value === "1";
};

const parseIntegerAfterKey = (content: string, key: string): number | null => {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(\\d+)\\s*$`, "im").exec(content);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const frontmatterText = (skillMarkdown: string): string => {
  const match = skillMarkdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? "";
};

const parsePackages = (content: string): SkillDependencyPackage[] => {
  const packages: SkillDependencyPackage[] = [];
  const lines = content.split(/\r?\n/);
  let currentManager: string | null = null;

  for (const line of lines) {
    const manager = /^\s*(?:manager|package_manager|package-manager)\s*:\s*(.+)$/i.exec(line);
    if (manager) {
      currentManager = stripQuotes(manager[1] ?? "");
      continue;
    }

    const packageMatch = /^\s*(?:package|name|value)\s*:\s*(.+)$/i.exec(line);
    if (packageMatch && currentManager) {
      packages.push({ manager: currentManager, name: stripQuotes(packageMatch[1] ?? "") });
    }
  }

  return packages.filter((item) => item.manager && item.name);
};


const parseScriptPermissions = (content: string): SkillScriptPermissionMetadata[] => {
  const lines = content.split(/\r?\n/);
  const result: SkillScriptPermissionMetadata[] = [];
  let current: SkillScriptPermissionMetadata | null = null;
  for (const line of lines) {
    const scriptMatch = /^\s{0,4}['"]?(scripts\/[^:'"]+)['"]?\s*:\s*$/.exec(line);
    if (scriptMatch) {
      current = { scriptPath: normalizePath(scriptMatch[1] ?? "") };
      result.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\S/.test(line) && line.trim().endsWith(":")) {
      current = null;
      continue;
    }
    const field = /^\s+(allow[_-]network|allowed[_-]env|write[_-]roots|allowed[_-]args|max[_-]runtime[_-]ms)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = (field[1] ?? "").replace(/-/g, "_");
    const value = field[2] ?? "";
    if (key === "allow_network") current.allowNetwork = ["true", "yes", "1"].includes(value.trim().toLowerCase());
    if (key === "allowed_env") current.allowedEnv = parseInlineList(value) ?? [stripQuotes(value)].filter(Boolean);
    if (key === "write_roots") current.writeRoots = parseInlineList(value) ?? [stripQuotes(value)].filter(Boolean);
    if (key === "allowed_args") current.allowedArgs = parseInlineList(value) ?? [stripQuotes(value)].filter(Boolean);
    if (key === "max_runtime_ms") {
      const parsed = Number(value.trim());
      if (Number.isSafeInteger(parsed) && parsed > 0) current.maxRuntimeMs = parsed;
    }
  }
  return result.filter((item) => item.scriptPath.startsWith("scripts/"));
};

const parsePermissions = (content: string): SkillPermissionMetadata => ({
  allowNetwork:
    parseBooleanAfterKey(content, "allow_network") ??
    parseBooleanAfterKey(content, "allow-network") ??
    parseBooleanAfterKey(content, "network") ??
    false,
  allowedEnv: unique([
    ...parseYamlListAfterKey(content, "allowed_env"),
    ...parseYamlListAfterKey(content, "allowed-env"),
    ...parseYamlListAfterKey(content, "env_allowlist"),
    ...parseYamlListAfterKey(content, "env-allowlist"),
  ]),
  writeRoots: unique([
    ...parseYamlListAfterKey(content, "write_roots"),
    ...parseYamlListAfterKey(content, "write-roots"),
  ]),
  maxRuntimeMs:
    parseIntegerAfterKey(content, "max_runtime_ms") ??
    parseIntegerAfterKey(content, "max-runtime-ms"),
  scripts: parseScriptPermissions(content),
});

const parseToolDependencies = (content: string): SkillDependencyMetadata => {
  const metadata = emptyMetadata();
  const lines = content.split(/\r?\n/);
  let currentType: string | null = null;

  for (const line of lines) {
    const typeMatch = /^\s*(?:-\s*)?(?:type|kind)\s*:\s*(.+)$/i.exec(line);
    if (typeMatch) {
      currentType = stripQuotes(typeMatch[1] ?? "").toLowerCase();
      continue;
    }

    const valueMatch = /^\s*(?:-\s*)?value\s*:\s*(.+)$/i.exec(line);
    if (!valueMatch || !currentType) continue;
    const value = stripQuotes(valueMatch[1] ?? "");
    if (!value) continue;

    if (/^(?:cli|bin|binary|command|tool)$/.test(currentType)) {
      metadata.requiredBins.push(value);
    } else if (/^(?:env|environment|environment-variable|api-key|secret)$/.test(currentType)) {
      metadata.requiredEnv.push(value);
    } else if (/^(?:file|credential-file|credentials-file)$/.test(currentType)) {
      metadata.requiredFiles.push(value);
    } else if (/^(?:npm|pip|cargo|go|package)$/.test(currentType)) {
      metadata.packages.push({ manager: currentType, name: value });
    }
  }

  metadata.permissions = parsePermissions(content);
  return metadata;
};

const mergePermissions = (parts: SkillPermissionMetadata[]): SkillPermissionMetadata => {
  const writeRoots = unique(parts.flatMap((part) => part.writeRoots));
  const runtimeLimits = parts
    .map((part) => part.maxRuntimeMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    allowNetwork: parts.some((part) => part.allowNetwork),
    allowedEnv: unique(parts.flatMap((part) => part.allowedEnv)),
    writeRoots: writeRoots.length ? writeRoots : defaultPermissions().writeRoots,
    maxRuntimeMs: runtimeLimits.length ? Math.min(...runtimeLimits) : null,
    scripts: parts.flatMap((part) => part.scripts ?? []),
  };
};

const mergeMetadata = (parts: SkillDependencyMetadata[]): SkillDependencyMetadata => {
  const metadataParts = parts.length ? parts : [emptyMetadata()];
  return {
    requiredBins: unique(metadataParts.flatMap((part) => part.requiredBins)),
    requiredEnv: unique(metadataParts.flatMap((part) => part.requiredEnv)),
    requiredFiles: unique(metadataParts.flatMap((part) => part.requiredFiles)),
    platforms: unique(metadataParts.flatMap((part) => part.platforms)),
    packages: metadataParts
      .flatMap((part) => part.packages)
      .filter((item, index, array) =>
        index === array.findIndex((candidate) => candidate.manager === item.manager && candidate.name === item.name),
      ),
    permissions: mergePermissions(metadataParts.map((part) => part.permissions ?? defaultPermissions())),
  };
};

export const extractSkillDependencyMetadata = (
  files: SkillFileRecord[],
): SkillDependencyMetadata => {
  const parts: SkillDependencyMetadata[] = [];
  const root = files.find((file) => normalizePath(file.path) === "SKILL.md");
  if (root) {
    const frontmatter = frontmatterText(skillFileText(root));
    parts.push({
      requiredBins: parseYamlListAfterKey(frontmatter, "required_bins"),
      requiredEnv: parseYamlListAfterKey(frontmatter, "required_env"),
      requiredFiles: parseYamlListAfterKey(frontmatter, "required_files"),
      platforms: parseYamlListAfterKey(frontmatter, "platforms"),
      packages: parsePackages(frontmatter),
      permissions: parsePermissions(frontmatter),
    });
  }

  for (const file of files) {
    const path = normalizePath(file.path);
    if (path === "agents/openai.yaml" || path === "agents/openai.yml") {
      const content = skillFileText(file);
      const parsed = parseToolDependencies(content);
      parts.push({
        ...parsed,
        packages: [...parsed.packages, ...parsePackages(content)],
        platforms: parseYamlListAfterKey(content, "platforms"),
      });
    }
  }

  return mergeMetadata(parts);
};

const executableNames = (bin: string): string[] => {
  if (process.platform !== "win32") return [bin];
  const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return /\.[A-Za-z0-9]+$/.test(bin) ? [bin] : [bin, ...extensions.map((ext) => `${bin}${ext.toLowerCase()}`)];
};

const findExecutable = (bin: string): string | null => {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of paths) {
    for (const name of executableNames(bin)) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // continue scanning PATH
      }
    }
  }
  return null;
};

const requiredFileExists = (filePath: string, workspaceDir?: string): boolean => {
  const candidate = isAbsolute(filePath)
    ? filePath
    : workspaceDir
      ? resolve(workspaceDir, filePath)
      : filePath;
  try {
    accessSync(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const runSkillPreflight = (
  metadata: SkillDependencyMetadata,
  env: NodeJS.ProcessEnv = process.env,
  workspaceDir?: string,
): SkillPreflightResult => {
  const missingBins = metadata.requiredBins.filter((bin) => !findExecutable(bin));
  const missingEnv = metadata.requiredEnv.filter((name) => !env[name]);
  const missingFiles = metadata.requiredFiles.filter((filePath) => !requiredFileExists(filePath, workspaceDir));
  const platform = process.platform;
  const incompatiblePlatforms = metadata.platforms.length > 0 && !metadata.platforms.some((entry) => {
    const normalized = entry.toLowerCase();
    if (normalized === "macos") return platform === "darwin";
    if (normalized === "windows") return platform === "win32";
    return platform.startsWith(normalized);
  });

  return {
    ok: missingBins.length === 0
      && missingEnv.length === 0
      && missingFiles.length === 0
      && !incompatiblePlatforms,
    missingBins,
    missingEnv,
    missingFiles,
    packages: metadata.packages,
    incompatiblePlatforms: incompatiblePlatforms ? metadata.platforms : [],
  };
};
