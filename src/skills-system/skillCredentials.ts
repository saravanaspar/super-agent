import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SkillCredentialReport, SkillCredentialSaveRequest, SkillRecord } from "@shared/types";

export interface SkillSecretCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface StoredCredential {
  value: string;
  updatedAt: string;
}

interface StoredFileCredential {
  path: string;
  updatedAt: string;
}

interface SkillCredentialEntry {
  env?: Record<string, StoredCredential>;
  files?: Record<string, StoredFileCredential>;
}

interface SkillCredentialFile {
  schemaVersion: 1;
  skills: Record<string, SkillCredentialEntry>;
}

const ENCRYPTED_PREFIX = "enc:v1:";

const credentialsFilePath = (): string =>
  join(resolve(homedir(), ".super-agent"), "skill-credentials.json");

const emptyFile = (): SkillCredentialFile => ({ schemaVersion: 1, skills: {} });

const readCredentialFile = (): SkillCredentialFile => {
  const filePath = credentialsFilePath();
  if (!existsSync(filePath)) return emptyFile();
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyFile();
    const record = parsed as Partial<SkillCredentialFile>;
    return {
      schemaVersion: 1,
      skills: record.skills && typeof record.skills === "object" ? record.skills : {},
    };
  } catch {
    return emptyFile();
  }
};

const ensureSafeCredentialFileTarget = (filePath: string): void => {
  if (!existsSync(filePath)) return;
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    throw new Error("Skill credential file must not be a symbolic link.");
  }
  if (!stats.isFile()) {
    throw new Error("Skill credential path must be a regular file.");
  }
};

const writeCredentialFile = (file: SkillCredentialFile): void => {
  const filePath = credentialsFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  ensureSafeCredentialFileTarget(filePath);
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(filePath, 0o600);
};

const encodeSecret = (codec: SkillSecretCodec | null | undefined, value: string): string => {
  if (!codec) throw new Error("Skill secrets require desktop safe-storage encryption before they can be saved.");
  return `${ENCRYPTED_PREFIX}${codec.encrypt(value)}`;
};

const decodeSecret = (codec: SkillSecretCodec | null | undefined, value: string): string | null => {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return null;
  if (!codec) return null;
  try {
    return codec.decrypt(value.slice(ENCRYPTED_PREFIX.length));
  } catch {
    return null;
  }
};

const requiredEnvNames = (skill: SkillRecord): string[] =>
  Array.from(new Set(skill.dependencyMetadata.requiredEnv.map((name) => name.trim()).filter(Boolean))).sort();

const requiredFileNames = (skill: SkillRecord): string[] =>
  Array.from(new Set(skill.dependencyMetadata.requiredFiles.map((name) => name.trim()).filter(Boolean))).sort();

export const buildSkillCredentialReport = (
  skill: SkillRecord,
  workspaceDir: string | undefined,
  codec: SkillSecretCodec | null | undefined,
): SkillCredentialReport => {
  const file = readCredentialFile();
  const entry = file.skills[skill.id] ?? {};
  return {
    skillId: skill.id,
    skillName: skill.name,
    storagePath: credentialsFilePath(),
    encryptionAvailable: Boolean(codec),
    requiredEnv: requiredEnvNames(skill).map((name) => ({
      name,
      configured: Boolean(entry.env?.[name]),
      source: entry.env?.[name] ? "stored" : "missing",
      secret: true,
    })),
    requiredFiles: requiredFileNames(skill).map((path) => {
      const stored = entry.files?.[path]?.path;
      const candidates = [stored, path, workspaceDir ? join(workspaceDir, path) : null].filter((value): value is string => Boolean(value));
      return {
        path,
        configuredPath: stored ?? null,
        exists: candidates.some((candidate) => existsSync(candidate)),
      };
    }),
    instructions: [
      "Stored values are encrypted with the desktop safe-storage backend and are never returned to the renderer.",
      "Only declared env names are injected into skill script processes.",
      "Credential files are stored as paths; file contents are not copied into the credential store.",
    ],
  };
};

export const saveSkillCredentials = (
  skill: SkillRecord,
  request: SkillCredentialSaveRequest,
  codec: SkillSecretCodec | null | undefined,
): SkillCredentialReport => {
  if (request.skillId !== skill.id) throw new Error("Credential request skill id does not match the selected skill.");
  const allowedEnv = new Set(requiredEnvNames(skill));
  const allowedFiles = new Set(requiredFileNames(skill));
  const file = readCredentialFile();
  const current = file.skills[skill.id] ?? {};
  const next: SkillCredentialEntry = {
    env: { ...(current.env ?? {}) },
    files: { ...(current.files ?? {}) },
  };
  const now = new Date().toISOString();

  for (const [name, rawValue] of Object.entries(request.env ?? {})) {
    if (!allowedEnv.has(name)) throw new Error(`Skill does not declare required env var: ${name}`);
    const value = rawValue.trim();
    if (!value) delete next.env?.[name];
    else next.env = { ...(next.env ?? {}), [name]: { value: encodeSecret(codec, value), updatedAt: now } };
  }

  for (const [name, rawPath] of Object.entries(request.files ?? {})) {
    if (!allowedFiles.has(name)) throw new Error(`Skill does not declare required credential file: ${name}`);
    const value = rawPath.trim();
    if (!value) delete next.files?.[name];
    else next.files = { ...(next.files ?? {}), [name]: { path: value, updatedAt: now } };
  }

  file.skills[skill.id] = next;
  writeCredentialFile(file);
  return buildSkillCredentialReport(skill, undefined, codec);
};

export const skillCredentialEnv = (
  skillId: string,
  envNames: string[],
  codec: SkillSecretCodec | null | undefined,
): Record<string, string> => {
  const entry = readCredentialFile().skills[skillId];
  if (!entry?.env) return {};
  const result: Record<string, string> = {};
  for (const name of envNames) {
    const value = entry.env[name]?.value;
    if (!value) continue;
    const decoded = decodeSecret(codec, value);
    if (decoded !== null) result[name] = decoded;
  }
  return result;
};
