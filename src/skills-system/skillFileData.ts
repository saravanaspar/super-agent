import type { SkillFileRecord } from "@shared/types";

const TEXT_EXTENSIONS = new Set([
  "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "env", "go", "graphql",
  "h", "hpp", "html", "java", "js", "json", "jsx", "lock", "log", "lua", "md",
  "mdx", "mjs", "py", "rb", "rs", "sh", "sql", "svg", "toml", "ts", "tsx", "txt",
  "xml", "yaml", "yml", "zsh"
]);

const TEXT_FILENAMES = new Set(["dockerfile", "makefile", "license", "notice", "readme"]);

const extensionForPath = (path: string): string => {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
};

const filenameForPath = (path: string): string =>
  path.split("/").pop()?.toLowerCase() ?? "";

export const isTextSkillPath = (path: string): boolean => {
  const filename = filenameForPath(path);
  return TEXT_FILENAMES.has(filename) || TEXT_EXTENSIONS.has(extensionForPath(path));
};

const looksLikeText = (content: Buffer): boolean => {
  if (content.includes(0)) return false;
  const decoded = content.toString("utf8");
  if (decoded.includes("\uFFFD")) return false;
  const controlCharacters = [...decoded].filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && ![9, 10, 12, 13].includes(code);
  }).length;
  return controlCharacters === 0;
};

export const skillFileFromBuffer = (path: string, content: Buffer): SkillFileRecord => {
  if (isTextSkillPath(path) || looksLikeText(content)) {
    return { path, content: content.toString("utf8") };
  }

  return { path, content: content.toString("base64"), encoding: "base64" };
};

export const skillFileToBuffer = (file: SkillFileRecord): Buffer =>
  file.encoding === "base64"
    ? Buffer.from(file.content, "base64")
    : Buffer.from(file.content, "utf8");

export const skillFileText = (file: SkillFileRecord): string =>
  file.encoding === "base64" ? "" : file.content;

export const skillFileByteLength = (file: SkillFileRecord): number =>
  skillFileToBuffer(file).length;

export const normalizeSkillFileRecord = (file: SkillFileRecord): SkillFileRecord => ({
  path: file.path,
  content: file.content,
  ...(file.encoding === "base64" ? { encoding: "base64" as const } : {})
});
