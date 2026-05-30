const ignoredDirectoryNameList = [
  ".angular",
  ".cache",
  ".dart_tool",
  ".git",
  ".gradle",
  ".hg",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".spar-harness",
  ".super-agent",
  ".svn",
  ".svelte-kit",
  ".terraform",
  ".turbo",
  ".venv",
  ".vite",
  "Debug",
  "Release",
  "__pycache__",
  "bin",
  "build",
  "coverage",
  "dist",
  "env",
  "artifacts",
  "node_modules",
  "obj",
  "out",
  "target",
  "vendor",
  "venv"
] as const;

export const ignoredDirectoryNames = new Set<string>(ignoredDirectoryNameList);

export const normalizeIgnoredPath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^\.\//, "");

export const ignoredPathSegments = (path: string): string[] =>
  normalizeIgnoredPath(path).split("/").filter(Boolean);

export const shouldIgnoreDirectoryName = (name: string): boolean =>
  ignoredDirectoryNames.has(name);

export const ignoredDirectorySegmentInPath = (path: string): string | null =>
  ignoredPathSegments(path).find(shouldIgnoreDirectoryName) ?? null;

export const containsIgnoredDirectory = (path: string): boolean =>
  ignoredDirectorySegmentInPath(path) !== null;
