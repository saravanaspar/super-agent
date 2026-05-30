import { createHash, createVerify } from "node:crypto";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { skillFileText, skillFileToBuffer } from "./skillFileData";
import { resolveHttpUrlForNetworkAccess } from "../security/networkPolicy";
import type {
  SkillFileRecord,
  SkillImportAdapterKind,
  SkillImportAdapterResult,
  SkillImportValidationIssue,
  SkillRegistryEntry,
  SkillVerificationResult,
} from "@shared/types";

const MAX_REMOTE_SKILL_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REMOTE_REDIRECTS = 5;
const GITHUB_API_ROOT = "https://api.github.com";

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean).join("/");

const unsafePath = (path: string): boolean =>
  path.startsWith("/") || path.includes("..") || path.includes("\0");

const encodeRefPath = (value: string): string =>
  value.split("/").map(encodeURIComponent).join("/");

export interface ResolvedGitHubSkillSource {
  originUrl: string;
  archiveUrl: string;
  repo: string;
  ref: string;
  skillPath: string | null;
}

export const resolveGitHubSkillSource = (rawUrl: string, requestedSkillPath?: string): ResolvedGitHubSkillSource => {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Enter a valid GitHub URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("Only https://github.com skill URLs are supported.");
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [owner, repo, mode, ...rest] = parts;
  if (!owner || !repo) throw new Error("GitHub URL must include owner and repository.");

  let selectedRef = "main";
  let pathFromUrl: string | null = null;
  const normalizedRequestedPath = requestedSkillPath ? normalizePath(requestedSkillPath) : null;

  if (mode === "tree" && rest.length > 0) {
    if (normalizedRequestedPath) {
      const skillPathParts = normalizedRequestedPath.split("/");
      const suffixStart = rest.length - skillPathParts.length;
      const suffixMatches = suffixStart >= 0 && skillPathParts.every((part, index) => rest[suffixStart + index] === part);
      if (suffixMatches) {
        selectedRef = rest.slice(0, suffixStart).join("/") || "main";
        pathFromUrl = normalizedRequestedPath;
      } else {
        selectedRef = rest[0] ?? "main";
        pathFromUrl = rest.slice(1).join("/") || null;
      }
    } else {
      selectedRef = rest[0] ?? "main";
      pathFromUrl = rest.slice(1).join("/") || null;
    }
  }

  const skillPath = normalizedRequestedPath ?? pathFromUrl;
  if (skillPath && unsafePath(skillPath)) throw new Error("GitHub skill path is unsafe.");
  return {
    originUrl: url.toString(),
    archiveUrl: `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeRefPath(selectedRef)}`,
    repo: `${owner}/${repo}`,
    ref: selectedRef,
    skillPath,
  };
};

const fetchGithubJson = async (url: string): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}.`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
};

const fetchGithubRefNames = async (owner: string, repo: string): Promise<string[]> => {
  const [branches, tags] = await Promise.all([
    fetchGithubJson(`${GITHUB_API_ROOT}/repos/${owner}/${repo}/branches?per_page=100`),
    fetchGithubJson(`${GITHUB_API_ROOT}/repos/${owner}/${repo}/tags?per_page=100`),
  ]);

  const branchEntries: unknown[] = Array.isArray(branches) ? branches : [];
  const tagEntries: unknown[] = Array.isArray(tags) ? tags : [];
  const names = [...branchEntries, ...tagEntries]
    .flatMap((entry): string[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const name = (entry as { name?: unknown }).name;
      return typeof name === "string" && name.trim() ? [name.trim()] : [];
    });

  return Array.from(new Set(names)).sort((a, b) => b.length - a.length);
};

const splitRefAndPath = (parts: string[], knownRefs: string[]): { ref: string; path: string | null } => {
  if (parts.length === 0) return { ref: "main", path: null };
  for (const ref of knownRefs) {
    const refParts = ref.split("/");
    const matches = refParts.every((part, index) => parts[index] === part);
    if (matches) {
      const rest = parts.slice(refParts.length);
      return { ref, path: rest.length ? rest.join("/") : null };
    }
  }
  return { ref: parts[0] ?? "main", path: parts.slice(1).join("/") || null };
};

export const resolveGitHubSkillSourceFromApi = async (rawUrl: string, requestedSkillPath?: string): Promise<ResolvedGitHubSkillSource> => {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Enter a valid GitHub URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("Only https://github.com skill URLs are supported.");
  }

  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [owner, repo, mode, ...rest] = parts;
  if (!owner || !repo) throw new Error("GitHub URL must include owner and repository.");

  const knownRefs = mode === "tree" ? await fetchGithubRefNames(owner, repo) : [];
  const resolved = mode === "tree" ? splitRefAndPath(rest, knownRefs) : { ref: "main", path: null };
  const skillPath = requestedSkillPath ? normalizePath(requestedSkillPath) : resolved.path;
  if (skillPath && unsafePath(skillPath)) throw new Error("GitHub skill path is unsafe.");

  return {
    originUrl: url.toString(),
    archiveUrl: `${GITHUB_API_ROOT}/repos/${owner}/${repo}/zipball/${encodeURIComponent(resolved.ref)}`,
    repo: `${owner}/${repo}`,
    ref: resolved.ref,
    skillPath,
  };
};

interface RemoteBufferResponse {
  status: number;
  url: string;
  headers: { get: (name: string) => string | null };
  body: Buffer;
}

const readHeader = (headers: IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
};

const assertHttpsSkillUrl = (url: URL): void => {
  if (url.protocol !== "https:") throw new Error("Skill sources must use HTTPS.");
};

const requestPinnedRemoteBuffer = async (rawUrl: string): Promise<RemoteBufferResponse> => {
  const resolved = await resolveHttpUrlForNetworkAccess(rawUrl);
  assertHttpsSkillUrl(resolved.url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();

  try {
    return await new Promise<RemoteBufferResponse>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      let totalBytes = 0;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const request = https.request(
        resolved.url,
        {
          method: "GET",
          signal: controller.signal,
          lookup: resolved.address
            ? (_hostname, _options, callback) => {
                callback(null, resolved.address ?? "", resolved.family ?? 4);
              }
            : undefined,
        },
        (response) => {
          const declaredLength = Number(readHeader(response.headers, "content-length") ?? "0");
          if (declaredLength > MAX_REMOTE_SKILL_BYTES) {
            fail(new Error("Remote skill archive is too large."));
            response.destroy();
            request.destroy();
            return;
          }

          response.on("data", (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_REMOTE_SKILL_BYTES) {
              fail(new Error("Remote skill archive is too large."));
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });

          response.on("end", () => {
            if (settled) return;
            settled = true;
            resolve({
              status: response.statusCode ?? 0,
              url: resolved.url.href,
              headers: { get: (name) => readHeader(response.headers, name) },
              body: Buffer.concat(chunks),
            });
          });
        },
      );

      request.on("error", (error) => fail(error));
      request.end();
    });
  } finally {
    clearTimeout(timer);
  }
};

export const fetchRemoteBuffer = async (url: string): Promise<Buffer> => {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_REDIRECTS; redirectCount += 1) {
    const response = await requestPinnedRemoteBuffer(currentUrl);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Fetch failed with HTTP ${response.status}.`);
      if (redirectCount === MAX_REMOTE_REDIRECTS) throw new Error("Remote skill fetch exceeded maximum redirects.");
      currentUrl = new URL(location, response.url).href;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Fetch failed with HTTP ${response.status}.`);
    }

    return response.body;
  }

  throw new Error("Remote skill fetch exceeded maximum redirects.");
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : [];

export const parseRegistryIndex = (raw: string, registryUrl: string): SkillRegistryEntry[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Registry index is invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  const source = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null ? (parsed as { skills?: unknown }).skills : null;
  if (!Array.isArray(source)) throw new Error("Registry index must be an array or an object with a skills array.");
  const base = new URL(registryUrl);
  return source.flatMap((entry, index): SkillRegistryEntry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const archive = asString(record.archiveUrl) ?? asString(record.url) ?? asString(record.downloadUrl);
    const name = asString(record.name);
    if (!archive || !name) return [];
    const archiveUrl = new URL(archive, base).toString();
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
    const id = (asString(record.id) ?? slug) || `skill-${index + 1}`;
    return [{
      id,
      name,
      description: asString(record.description) ?? "",
      version: asString(record.version),
      archiveUrl,
      publisher: asString(record.publisher),
      packageHash: asString(record.packageHash) ?? asString(record.hash),
      signature: asString(record.signature),
      publicKey: asString(record.publicKey),
      tags: asStringArray(record.tags),
    }];
  });
};

const canonicalManifestPayload = (packageHash: string, publisher: string | null): string =>
  JSON.stringify({ packageHash, publisher: publisher ?? null });

export const verifySkillSignature = (params: {
  packageHash: string;
  publisher: string | null;
  signature: string | null | undefined;
  publicKey: string | null | undefined;
}): boolean | null => {
  if (!params.signature || !params.publicKey) return null;
  try {
    const verifier = createVerify("sha256");
    verifier.update(canonicalManifestPayload(params.packageHash, params.publisher));
    verifier.end();
    return verifier.verify(params.publicKey, params.signature, "base64");
  } catch {
    return false;
  }
};

export const verificationFromFindings = (params: {
  skillId: string;
  packageHash: string;
  expectedHash: string | null;
  signatureValid: boolean | null;
  publisher: string | null;
  originUrl: string | null;
  findings: SkillVerificationResult["findings"];
}): SkillVerificationResult => {
  const hasCriticalFindings = params.findings.some((finding) => finding.severity === "critical");
  const expectedHashPresent = Boolean(params.expectedHash);
  const hashOk = expectedHashPresent && params.expectedHash === params.packageHash;
  const signatureOk = params.signatureValid === true;
  const signatureFailed = params.signatureValid === false;
  const status = hasCriticalFindings || (expectedHashPresent && !hashOk) || signatureFailed
    ? "failed"
    : hashOk || signatureOk
      ? "verified"
      : "unverified";
  return {
    skillId: params.skillId,
    status,
    packageHash: params.packageHash,
    expectedHash: params.expectedHash,
    signatureValid: params.signatureValid,
    publisher: params.publisher,
    originUrl: params.originUrl,
    findings: params.findings,
    verifiedAt: new Date().toISOString(),
  };
};

export const hashFiles = (files: SkillFileRecord[]): string => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(skillFileToBuffer(file));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const packageWarnings = (files: SkillFileRecord[]): SkillImportValidationIssue[] => {
  const warnings: SkillImportValidationIssue[] = [];
  if (!files.some((file) => file.path.startsWith("evals/"))) {
    warnings.push({ code: "missing-evals", message: "Imported skill has no evals/ directory." });
  }
  return warnings;
};

const extractPackages = (files: SkillFileRecord[], layout: Exclude<SkillImportAdapterKind, "auto">): SkillImportAdapterResult["packages"] => {
  const normalized = files.map((file) => ({ path: normalizePath(file.path), content: file.content, ...(file.encoding === "base64" ? { encoding: "base64" as const } : {}) })).filter((file) => file.path && !unsafePath(file.path));
  const skillFiles = normalized.filter((file) => file.path.endsWith("SKILL.md"));
  return skillFiles.flatMap((skillFile): SkillImportAdapterResult["packages"] => {
    const prefix = skillFile.path.endsWith("/SKILL.md") ? skillFile.path.slice(0, -"SKILL.md".length) : "";
    const packageFiles = normalized
      .filter((file) => !prefix || file.path.startsWith(prefix))
      .map((file) => ({ path: prefix ? file.path.slice(prefix.length) : file.path, content: file.content, ...(file.encoding === "base64" ? { encoding: "base64" as const } : {}) }))
      .filter((file) => file.path.length > 0);
    const skillText = skillFileText(skillFile);
    const nameMatch = skillText.match(/^name:\s*([^\n]+)/m);
    const descriptionMatch = skillText.match(/^description:\s*([^\n]+)/m);
    const name = (nameMatch?.[1] ?? skillFile.path.split("/").at(-2) ?? layout).trim().replace(/^['"]|['"]$/g, "");
    const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || layout;
    return [{
      id,
      name,
      description: (descriptionMatch?.[1] ?? "").trim().replace(/^['"]|['"]$/g, ""),
      files: packageFiles,
      warnings: packageWarnings(packageFiles),
    }];
  });
};

export const adaptSkillLayout = (layout: SkillImportAdapterKind, files: SkillFileRecord[]): SkillImportAdapterResult => {
  const detected: Exclude<SkillImportAdapterKind, "auto"> = layout === "auto" ? detectLayout(files) : layout;
  const packages = extractPackages(files, detected);
  const counts = new Map<string, number>();
  for (const pkg of packages) counts.set(pkg.id, (counts.get(pkg.id) ?? 0) + 1);
  const conflicts = packages
    .filter((pkg) => (counts.get(pkg.id) ?? 0) > 1)
    .map((pkg): SkillImportValidationIssue => ({ code: "adapter-name-conflict", message: `Multiple imported packages normalize to ${pkg.id}.`, path: pkg.files[0]?.path }));
  return { layout: detected, packages, conflicts };
};

const detectLayout = (files: SkillFileRecord[]): Exclude<SkillImportAdapterKind, "auto"> => {
  const paths = files.map((file) => normalizePath(file.path));
  if (paths.some((path) => path.includes(".codex-plugin/plugin.json") || path.startsWith("codex/"))) return "codex";
  if (paths.some((path) => path.includes(".claude-plugin/plugin.json") || path.includes(".claude/"))) return "claude";
  if (paths.some((path) => path.includes("openclaw") || path.endsWith("skills-config.md"))) return "openclaw";
  return "hermes";
};
