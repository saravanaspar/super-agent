import { inflateRawSync } from "node:zlib";
import type {
  SkillFileRecord,
  SkillImportRequest,
  SkillImportValidationIssue,
  SkillRecord,
} from "@shared/types";
import { parseSkillMarkdown, validateSkillFiles } from "./skillValidation";
import { skillFileFromBuffer, skillFileToBuffer } from "./skillFileData";
import { extractSkillDependencyMetadata } from "./skillMetadata";
import { filePackageSize } from "./skillContext";
import { hashSkillFiles } from "./skillHash";
import { criticalSkillFinding, scanSkillFiles, trustLevelForSkill } from "./skillSecurity";
import {
  MAX_IMPORTED_FILE_BYTES,
  ZIP64_SIZE_SENTINEL,
  ZIP_CENTRAL_DIRECTORY_FILE_HEADER,
  ZIP_END_OF_CENTRAL_DIRECTORY,
  ZIP_EOCD_MAX_COMMENT,
  ZIP_EOCD_MIN_SIZE,
  ZIP_LOCAL_FILE_HEADER,
  ZIP_VERSION_NEEDED,
  type ZipEntry,
} from "./skillRegistryTypes";

export const normalizeSkillFilePath = (path: string): string =>
  path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean)
    .join("/");

export const isUnsafePath = (path: string): boolean =>
  path.startsWith("/") || path.includes("..") || path.includes("\0");

const assertZipRange = (buffer: Buffer, offset: number, length: number, message: string): void => {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(message);
  }
};

export const findEndOfCentralDirectory = (buffer: Buffer): number => {
  const minIndex = Math.max(
    0,
    buffer.length - ZIP_EOCD_MIN_SIZE - ZIP_EOCD_MAX_COMMENT,
  );

  for (
    let index = buffer.length - ZIP_EOCD_MIN_SIZE;
    index >= minIndex;
    index -= 1
  ) {
    if (buffer.readUInt32LE(index) === ZIP_END_OF_CENTRAL_DIRECTORY)
      return index;
  }

  throw new Error(
    "Invalid skill archive: ZIP end of central directory not found.",
  );
};

export const readZipEntries = (buffer: Buffer): ZipEntry[] => {
  if (buffer.length > MAX_IMPORTED_FILE_BYTES) {
    throw new Error("Skill archive is too large. Maximum size is 25 MB.");
  }

  const eocd = findEndOfCentralDirectory(buffer);
  assertZipRange(buffer, eocd, ZIP_EOCD_MIN_SIZE, "Invalid skill archive: truncated end of central directory.");
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const entries: ZipEntry[] = [];
  let cursor = centralDirectoryOffset;
  let totalUncompressedSize = 0;

  if (centralDirectoryOffset > buffer.length) {
    throw new Error("Invalid skill archive: central directory is outside the archive.");
  }

  for (let index = 0; index < totalEntries; index += 1) {
    assertZipRange(buffer, cursor, 46, "Invalid skill archive: truncated central directory.");
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER) {
      throw new Error("Invalid skill archive: malformed central directory.");
    }

    const compression = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const entryLength = 46 + fileNameLength + extraLength + commentLength;
    assertZipRange(buffer, cursor, entryLength, "Invalid skill archive: truncated central directory entry.");
    const rawPath = buffer.toString(
      "utf8",
      cursor + 46,
      cursor + 46 + fileNameLength,
    );
    const path = normalizeSkillFilePath(rawPath);

    cursor += entryLength;

    if (!path || path.endsWith("/")) continue;
    if (isUnsafePath(path))
      throw new Error(`Unsafe file path in skill archive: ${rawPath}`);

    if (
      compressedSize === ZIP64_SIZE_SENTINEL ||
      uncompressedSize === ZIP64_SIZE_SENTINEL
    ) {
      throw new Error(`ZIP64 skill archives are not supported: ${path}.`);
    }

    totalUncompressedSize += uncompressedSize;
    if (
      uncompressedSize > MAX_IMPORTED_FILE_BYTES ||
      totalUncompressedSize > MAX_IMPORTED_FILE_BYTES
    ) {
      throw new Error("Skill archive uncompressed content is too large. Maximum size is 25 MB.");
    }

    assertZipRange(buffer, localHeaderOffset, 30, `Invalid skill archive: truncated local header for ${path}.`);
    if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error(
        `Invalid skill archive: malformed local header for ${path}.`,
      );
    }

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart =
      localHeaderOffset + 30 + localNameLength + localExtraLength;
    assertZipRange(buffer, localHeaderOffset, 30 + localNameLength + localExtraLength, `Invalid skill archive: truncated local header for ${path}.`);

    if (dataStart + compressedSize > buffer.length) {
      throw new Error(`Invalid skill archive: truncated content for ${path}.`);
    }

    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;

    if (compression === 0) {
      content = Buffer.from(compressed);
    } else if (compression === 8) {
      content = inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
    } else {
      throw new Error(
        `Unsupported ZIP compression method ${compression} for ${path}.`,
      );
    }

    if (content.length !== uncompressedSize) {
      throw new Error(`Invalid decompressed size for ${path}.`);
    }

    entries.push({ path, content });
  }

  return entries;
};

export const stripRootFolder = (files: SkillFileRecord[]): SkillFileRecord[] => {
  const skillPaths = files
    .map((file) => file.path)
    .filter((path) => path.split("/").at(-1) === "SKILL.md");

  if (skillPaths.length !== 1) {
    throw new Error(
      skillPaths.length === 0
        ? "SKILL.md not found"
        : "Skill archive contains multiple SKILL.md files. Upload one skill at a time.",
    );
  }

  const skillPath = skillPaths[0] ?? "SKILL.md";
  const prefix = skillPath.endsWith("/SKILL.md")
    ? skillPath.slice(0, -"SKILL.md".length)
    : "";

  return files
    .filter((file) => !prefix || file.path.startsWith(prefix))
    .map((file) => ({
      path: prefix ? file.path.slice(prefix.length) : file.path,
      content: file.content,
      ...(file.encoding === "base64" ? { encoding: "base64" as const } : {})
    }))
    .filter((file) => file.path.length > 0);
};

export const removeCommonArchiveRoot = (files: SkillFileRecord[]): SkillFileRecord[] => {
  const firstSegments = new Set(
    files.map((file) => file.path.split("/")[0]).filter((part): part is string => Boolean(part))
  );

  if (firstSegments.size !== 1) return files;

  const [root] = Array.from(firstSegments);
  if (!root) return files;

  return files.map((file) => ({
    ...file,
    path: file.path.startsWith(`${root}/`) ? file.path.slice(root.length + 1) : file.path,
  }));
};

export const filesFromUpload = (upload: SkillImportRequest): SkillFileRecord[] => {
  const filename = upload.filename.trim().toLowerCase();
  const buffer = Buffer.from(upload.dataBase64, "base64");

  if (filename.endsWith(".md")) {
    return [skillFileFromBuffer("SKILL.md", buffer)];
  }

  if (!filename.endsWith(".zip") && !filename.endsWith(".skill")) {
    throw new Error("Upload a .skill, .zip, or SKILL.md file.");
  }

  const files = readZipEntries(buffer).map<SkillFileRecord>((entry) =>
    skillFileFromBuffer(entry.path, entry.content)
  );

  return stripRootFolder(files);
};

export const skillRecordFromFiles = (
  files: SkillFileRecord[],
  options: {
    enabled?: boolean | undefined;
    autoRouting?: boolean | undefined;
    version?: string | null | undefined;
    originUrl?: string | null | undefined;
    sourceArchiveUrl?: string | null | undefined;
    sourceSubpath?: string | null | undefined;
    registryUrl?: string | null | undefined;
    publisher?: string | null | undefined;
    expectedPackageHash?: string | null | undefined;
    signature?: string | null | undefined;
    publicKey?: string | null | undefined;
  } = {},
): SkillRecord => {
  const validation = validateSkillFiles(files);
  if (!validation.valid) throw new Error(validation.message);

  const rootSkill = files.find((file) => file.path === "SKILL.md");
  if (!rootSkill) throw new Error("SKILL.md not found");

  const parsed = parseSkillMarkdown(rootSkill.content);
  const now = new Date().toISOString();
  const scanFindings = scanSkillFiles(files);

  return {
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    instructions: parsed.body,
    enabled: options.enabled ?? true,
    autoRouting: options.autoRouting ?? false,
    source: "local",
    trustLevel: trustLevelForSkill("local", scanFindings),
    quarantineReason: criticalSkillFinding(scanFindings)?.message ?? null,
    scanFindings,
    dependencyMetadata: extractSkillDependencyMetadata(files),
    files,
    version: options.version ?? null,
    installedAt: now,
    updatedAt: now,
    packageSize: filePackageSize(files),
    packageHash: hashSkillFiles(files),
    lastUsedAt: null,
    useCount: 0,
    originUrl: options.originUrl ?? null,
    sourceArchiveUrl: options.sourceArchiveUrl ?? null,
    sourceSubpath: options.sourceSubpath ?? null,
    registryUrl: options.registryUrl ?? null,
    publisher: options.publisher ?? null,
    expectedPackageHash: options.expectedPackageHash ?? null,
    signature: options.signature ?? null,
    publicKey: options.publicKey ?? null,
    verifiedAt: null,
    verificationStatus: "unverified",
  };
};

export const validationIssue = (
  code: string,
  message: string,
  path?: string,
): SkillImportValidationIssue => ({
  code,
  message,
  ...(path ? { path } : {}),
});

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

export const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

export const dosDateTime = (date: Date): { time: number; date: number } => {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

export const createZip = (files: SkillFileRecord[]): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const stamp = dosDateTime(new Date());

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const content = skillFileToBuffer(file);
    const crc = crc32(content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, content);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_FILE_HEADER, 0);
    central.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
    central.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(ZIP_EOCD_MIN_SIZE);
  eocd.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
};
