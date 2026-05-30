import type { SkillFileRecord, SkillRecord } from "@shared/types";
import { isBinarySkillFile } from "../../skillFileDisplay";
import type { FileTreeNode, VisibleLibraryKey } from "./libraryTypes";

export const sectionOrder: VisibleLibraryKey[] = [
  "plugins",
  "skills",
  "mcp",
  "artifacts",
];

export const itemTitle = (item: unknown): string => {
  if (typeof item !== "object" || item === null) return "Untitled";

  const record = item as Record<string, unknown>;

  for (const key of ["name", "title", "label", "model", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }

  return "Untitled";
};

export const itemDescription = (item: unknown): string => {
  if (typeof item !== "object" || item === null) return "";

  const record = item as Record<string, unknown>;

  for (const key of ["description", "instructions", "contentType", "provider"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }

  return "";
};

export const activeSkill = (
  skills: SkillRecord[],
  activeSkillId: string | null,
): SkillRecord | null =>
  skills.find((skill) => skill.id === activeSkillId) ?? skills[0] ?? null;

export const skillFiles = (skill: SkillRecord): SkillFileRecord[] =>
  skill.files.length
    ? skill.files
    : [{ path: "SKILL.md", content: skill.instructions }];

export const fileKind = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext || ext === path) return "text";
  return ext;
};

export const isMarkdownFile = (path: string): boolean => /\.mdx?$/i.test(path);
export const isHtmlFile = (path: string): boolean => /\.html?$/i.test(path);
export const isJsonFile = (path: string): boolean => /\.json$/i.test(path);
export const isYamlFile = (path: string): boolean => /\.ya?ml$/i.test(path);
export const isImageFile = (path: string): boolean => /\.(png|jpe?g|gif|svg|webp)$/i.test(path);

export const isPreviewableFile = (path: string): boolean =>
  isMarkdownFile(path) ||
  isHtmlFile(path) ||
  isJsonFile(path) ||
  isYamlFile(path) ||
  isImageFile(path);

export const readableSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const estimateTokens = (value: string): number =>
  Math.max(1, Math.ceil(value.length / 4));

export const formatDate = (value: string | null | undefined): string => {
  if (!value) return "-";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "-";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(new Date(time));
};

export const formatJsonContent = (content: string): string => {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
};

export const formatYamlContent = (content: string): string =>
  content
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();

export const mimeForImage = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
};

export const contentDataUri = (file: SkillFileRecord): string => {
  if (file.content.startsWith("data:")) return file.content;
  if (isBinarySkillFile(file)) return `data:${mimeForImage(file.path)};base64,${file.content}`;
  return `data:${mimeForImage(file.path)};utf8,${encodeURIComponent(file.content)}`;
};

export const normalizeImportedFilename = (name: string): string =>
  name.trim() || "skill.skill";

export const fileToBase64 = async (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.readAsDataURL(file);
  });

export const buildFileTree = (files: SkillFileRecord[], rootName: string): FileTreeNode => {
  const root: FileTreeNode = {
    name: rootName,
    path: "",
    children: [],
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;

    parts.forEach((part, index) => {
      const nodePath = parts.slice(0, index + 1).join("/");
      let child = current.children.find((item) => item.name === part);

      if (!child) {
        child = {
          name: part,
          path: nodePath,
          children: [],
        };
        current.children.push(child);
      }

      if (index === parts.length - 1) {
        child.file = file;
      }

      current = child;
    });
  }

  const sortTree = (node: FileTreeNode): void => {
    node.children.sort((a, b) => {
      const aFolder = a.children.length > 0 && !a.file;
      const bFolder = b.children.length > 0 && !b.file;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortTree);
  };

  sortTree(root);
  return root;
};

export const collectFolderPaths = (node: FileTreeNode): string[] => {
  const paths: string[] = [];
  for (const child of node.children) {
    if (child.children.length > 0) {
      paths.push(child.path, ...collectFolderPaths(child));
    }
  }
  return paths;
};

export const previewNotice = (path: string): string => {
  const kind = fileKind(path).toUpperCase();
  return `${kind} files are shown in raw code view. Preview rendering is available for Markdown, HTML, JSON, YAML, and image assets.`;
};

export const stripMarkdownFrontmatter = (content: string): string =>
  content
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .trimStart();
