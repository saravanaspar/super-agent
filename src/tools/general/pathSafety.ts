import {
  existsSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import {
  HARD_BLOCK_EXACT_PATHS,
  HARD_BLOCK_PATH_PREFIXES,
  SKIP_DIRS
} from "./constants";

export interface PathValidationOptions {
  allowMissingLeaf?: boolean;
  allowOutsideWorkspace?: boolean;
}

const mountedWorkspaceRoots =
  process.platform === "darwin"
    ? ["/Volumes"]
    : ["/run/media", "/media", "/mnt"];

export const normalizeSystemPath = (candidatePath: string): string => {
  const resolved = resolve(candidatePath || "/");
  return resolved.replace(/\/+$/, "") || "/";
};

const pathRelationInside = (
  parentPath: string,
  candidatePath: string
): boolean => {
  const relation = relative(parentPath, candidatePath);
  return (
    relation === "" ||
    (!relation.startsWith("..") && !isAbsolute(relation))
  );
};

const workspaceIsMountedProject = (workspacePath: string): boolean => {
  const normalizedWorkspace = normalizeSystemPath(workspacePath);

  return mountedWorkspaceRoots.some((root) => {
    const normalizedRoot = normalizeSystemPath(root);

    return (
      normalizedWorkspace !== normalizedRoot &&
      normalizedWorkspace.startsWith(`${normalizedRoot}/`)
    );
  });
};

const hardBlockPrefixCanBeBypassedForWorkspace = (
  prefix: string,
  candidatePath: string,
  workspacePath?: string
): boolean => {
  if (!workspacePath || !workspaceIsMountedProject(workspacePath)) {
    return false;
  }

  const normalizedPrefix = normalizeSystemPath(prefix);
  const normalizedCandidate = normalizeSystemPath(candidatePath);
  const normalizedWorkspace = normalizeSystemPath(workspacePath);

  const matchingMountRoot = mountedWorkspaceRoots
    .map(normalizeSystemPath)
    .find(
      (root) =>
        root === normalizedPrefix ||
        root.startsWith(`${normalizedPrefix}/`) ||
        normalizedPrefix.startsWith(`${root}/`)
    );

  if (!matchingMountRoot) {
    return false;
  }

  return pathRelationInside(normalizedWorkspace, normalizedCandidate);
};

export const assertNotHardBlockedPath = (
  candidatePath: string,
  originalPath: string,
  workspacePath?: string
): void => {
  const normalized = normalizeSystemPath(candidatePath || originalPath);

  if (HARD_BLOCK_EXACT_PATHS.has(normalized)) {
    throw new Error(`[ToolRegistry] Access to ${normalized} is always blocked`);
  }

  for (const prefix of HARD_BLOCK_PATH_PREFIXES) {
    const normalizedPrefix = normalizeSystemPath(prefix);
    const matchesPrefix =
      normalized === normalizedPrefix ||
      normalized.startsWith(`${normalizedPrefix}/`);

    if (!matchesPrefix) {
      continue;
    }

    if (
      hardBlockPrefixCanBeBypassedForWorkspace(
        normalizedPrefix,
        normalized,
        workspacePath
      )
    ) {
      continue;
    }

    throw new Error(
      `[ToolRegistry] Access to ${normalizedPrefix} is always blocked`
    );
  }
};

export const assertInsideWorkspace = (
  candidatePath: string,
  workspacePath: string,
  originalPath: string,
  allowOutsideWorkspace = false
): void => {
  const normalizedCandidate = normalizeSystemPath(candidatePath);
  const normalizedWorkspace = normalizeSystemPath(workspacePath);

  assertNotHardBlockedPath(
    normalizedCandidate,
    originalPath,
    normalizedWorkspace
  );

  if (pathRelationInside(normalizedWorkspace, normalizedCandidate)) {
    return;
  }

  if (allowOutsideWorkspace) {
    return;
  }

  throw new Error(`[ToolRegistry] Path outside workspace: ${originalPath}`);
};

const nearestExistingParent = (targetPath: string): string => {
  let current = dirname(targetPath);

  while (!existsSync(current)) {
    const parent = dirname(current);

    if (parent === current) {
      throw new Error(
        `[ToolRegistry] No existing parent directory for path: ${targetPath}`
      );
    }

    current = parent;
  }

  return current;
};

export const workspaceRealPath = (workspaceDir: string): string => {
  const resolved = resolve(workspaceDir || process.cwd());
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
};

export const validatePath = (
  workspaceDir: string,
  inputPath: string,
  options: PathValidationOptions = {}
): string => {
  const workspacePath = resolve(workspaceDir || process.cwd());
  const workspaceReal = workspaceRealPath(workspacePath);
  const originalPath = inputPath || ".";
  const target = isAbsolute(originalPath)
    ? resolve(originalPath)
    : resolve(workspacePath, originalPath);
  const allowOutsideWorkspace = options.allowOutsideWorkspace === true;

  assertInsideWorkspace(
    target,
    workspacePath,
    originalPath,
    allowOutsideWorkspace
  );

  if (existsSync(target)) {
    const realTarget = realpathSync.native(target);

    assertInsideWorkspace(
      realTarget,
      workspaceReal,
      originalPath,
      allowOutsideWorkspace
    );

    return target;
  }

  if (options.allowMissingLeaf !== true) {
    return target;
  }

  const parent = nearestExistingParent(target);
  const realParent = realpathSync.native(parent);

  assertInsideWorkspace(
    realParent,
    workspaceReal,
    originalPath,
    allowOutsideWorkspace
  );

  return target;
};

export const resolveExistingPath = (
  workspaceDir: string,
  inputPath = ".",
  launchPath?: string,
  allowOutsideWorkspace = false
): string => {
  const workspacePath = resolve(workspaceDir || process.cwd());
  const workspaceReal = workspaceRealPath(workspacePath);
  const candidates = isAbsolute(inputPath)
    ? [resolve(inputPath)]
    : [
        resolve(workspacePath, inputPath),
        ...(launchPath ? [resolve(launchPath, inputPath)] : [])
      ];

  for (const candidate of candidates) {
    try {
      assertInsideWorkspace(
        candidate,
        workspacePath,
        inputPath,
        allowOutsideWorkspace
      );

      if (!existsSync(candidate)) {
        continue;
      }

      const realTarget = realpathSync.native(candidate);

      assertInsideWorkspace(
        realTarget,
        workspaceReal,
        inputPath,
        allowOutsideWorkspace
      );

      return candidate;
    } catch {
      continue;
    }
  }

  return validatePath(workspacePath, inputPath, {
    allowOutsideWorkspace
  });
};

export const toWorkspaceRelative = (
  workspaceDir: string,
  filePath: string
): string => {
  if (!filePath) return "";
  if (!isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
  return relative(resolve(workspaceDir), filePath).replace(/\\/g, "/");
};

export const skippedWorkspacePathSegment = (
  workspaceDir: string,
  candidatePath: string
): string | null => {
  const normalizedWorkspace = normalizeSystemPath(workspaceDir || process.cwd());
  const normalizedCandidate = normalizeSystemPath(candidatePath);
  const relation = relative(normalizedWorkspace, normalizedCandidate);

  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    return null;
  }

  return (
    relation
      .replace(/\\/g, "/")
      .split("/")
      .find((segment) => SKIP_DIRS.has(segment)) ?? null
  );
};

export const isSkippedWorkspacePath = (
  workspaceDir: string,
  candidatePath: string
): boolean => skippedWorkspacePathSegment(workspaceDir, candidatePath) !== null;

export const assertNotSkippedWorkspacePath = (
  workspaceDir: string,
  candidatePath: string
): void => {
  const segment = skippedWorkspacePathSegment(workspaceDir, candidatePath);

  if (!segment) return;

  throw new Error(
    `[ToolRegistry] Path is inside skipped workspace directory: ${segment}`
  );
};

export const atomicWriteFile = (filePath: string, content: string): void => {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const tmp = join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);

  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      if (existsSync(tmp)) {
        unlinkSync(tmp);
      }
    } catch {
      // Best-effort cleanup only.
    }

    throw error;
  }
};
