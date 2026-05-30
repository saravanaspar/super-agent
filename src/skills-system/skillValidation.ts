import type { SkillFileRecord } from "@shared/types";
import { skillFileText } from "./skillFileData";

const EXCLUDED_DIR_PARTS = new Set(["__pycache__", "node_modules"]);
const ROOT_EXCLUDED_DIR_PARTS = new Set(["evals"]);
const ALLOWED_PROPERTIES = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
  "platforms",
  "packages",
  "required_bins",
  "required_env",
  "required_files",
  "allow_network",
  "allow-network",
  "network",
  "allowed_env",
  "allowed-env",
  "env_allowlist",
  "env-allowlist",
  "write_roots",
  "write-roots",
  "max_runtime_ms",
  "max-runtime-ms",
]);

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface SkillValidationResult {
  valid: boolean;
  message: string;
}

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^\.\//, "");

const pathParts = (path: string): string[] =>
  normalizePath(path).split("/").filter(Boolean);

const countsAsSkillMd = (path: string): boolean => {
  const parts = pathParts(path);
  const dirParts = parts.slice(0, -1);

  if (dirParts.some((part) => EXCLUDED_DIR_PARTS.has(part))) return false;
  if (dirParts.length > 0 && ROOT_EXCLUDED_DIR_PARTS.has(dirParts[0] ?? "")) {
    return false;
  }

  return true;
};

const stripQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseScalar = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") || trimmed.startsWith("{"))
    return Symbol("non-string");
  return stripQuotes(trimmed);
};

const parseFrontmatter = (frontmatterText: string): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const lines = frontmatterText.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || /^\s/.test(line)) continue;

    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid YAML in frontmatter: ${line}`);
    }

    const key = match[1] ?? "";
    const rawValue = (match[2] ?? "").trim();

    if ([">", "|", ">-", "|-"].includes(rawValue)) {
      const continuation: string[] = [];
      index += 1;
      while (index < lines.length) {
        const continuationLine = lines[index] ?? "";
        if (!/^(?: {2}|\t)/.test(continuationLine)) break;
        continuation.push(continuationLine.trim());
        index += 1;
      }
      index -= 1;
      result[key] = continuation.join(" ");
      continue;
    }

    result[key] = parseScalar(rawValue);
  }

  return result;
};

const frontmatterMatch = (content: string): RegExpMatchArray | null =>
  content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

export const parseSkillMarkdown = (content: string): ParsedSkillMarkdown => {
  if (!content.startsWith("---")) {
    throw new Error("SKILL.md missing frontmatter (no opening ---)");
  }

  const match = frontmatterMatch(content);
  if (!match) {
    throw new Error("SKILL.md missing frontmatter (no closing ---)");
  }

  const frontmatter = parseFrontmatter(match[1] ?? "");
  const name =
    typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description =
    typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : "";

  return {
    name,
    description,
    body: content.slice(match[0].length).trimStart(),
    frontmatter,
  };
};

export const buildSkillMarkdown = (
  name: string,
  description: string,
  body: string,
): string =>
  [
    "---",
    `name: ${name.trim()}`,
    `description: ${description.trim()}`,
    "---",
    "",
    body.trim(),
  ].join("\n");

const frontmatterScalar = (value: string): string =>
  value.includes(":") || value.includes("#") ? JSON.stringify(value.trim()) : value.trim();

export const rewriteSkillMarkdownIdentity = (
  content: string,
  name: string,
  description: string,
): string => {
  const match = frontmatterMatch(content);
  if (!match) return buildSkillMarkdown(name, description, content);

  const lines = (match[1] ?? "").split("\n");
  let sawName = false;
  let sawDescription = false;
  const rewritten = lines.map((line) => {
    if (/^name\s*:/i.test(line)) {
      sawName = true;
      return `name: ${frontmatterScalar(name)}`;
    }
    if (/^description\s*:/i.test(line)) {
      sawDescription = true;
      return `description: ${frontmatterScalar(description)}`;
    }
    return line;
  });

  if (!sawName) rewritten.unshift(`name: ${frontmatterScalar(name)}`);
  if (!sawDescription) {
    rewritten.splice(sawName ? 1 : 0, 0, `description: ${frontmatterScalar(description)}`);
  }

  return ["---", ...rewritten, "---", "", content.slice(match[0].length).trimStart()].join("\n");
};

export const syncSkillMarkdownFile = (
  files: SkillFileRecord[],
  skillMarkdown: string,
): SkillFileRecord[] => {
  const normalized = files
    .map((file) => ({
      path: normalizePath(file.path.trim()),
      content: file.content,
      ...(file.encoding === "base64" ? { encoding: "base64" as const } : {})
    }))
    .filter((file) => file.path.length > 0);
  const existingIndex = normalized.findIndex(
    (file) => file.path === "SKILL.md",
  );

  if (existingIndex >= 0) {
    normalized[existingIndex] = { path: "SKILL.md", content: skillMarkdown };
    return normalized;
  }

  return [{ path: "SKILL.md", content: skillMarkdown }, ...normalized];
};

export const validateSkillFiles = (
  files: SkillFileRecord[],
): SkillValidationResult => {
  const normalized = files.map((file) => ({
    path: normalizePath(file.path),
    content: file.content,
    ...(file.encoding === "base64" ? { encoding: "base64" as const } : {})
  }));
  const rootSkill = normalized.find((file) => file.path === "SKILL.md");

  if (!rootSkill) {
    return { valid: false, message: "SKILL.md not found" };
  }

  const skillMdFiles = normalized.filter((file) => {
    const parts = pathParts(file.path);
    return parts[parts.length - 1] === "SKILL.md" && countsAsSkillMd(file.path);
  });

  if (skillMdFiles.length > 1) {
    const extras = skillMdFiles
      .filter((file) => file.path !== "SKILL.md")
      .map((file) => file.path)
      .sort();
    return {
      valid: false,
      message: [
        `Found ${skillMdFiles.length} SKILL.md files, but a skill must contain exactly one at <folder>/SKILL.md. The Skills API and claude.ai reject multiple on upload (only Claude Code's filesystem loads nested skills). Extra: ${extras.join(", ")}.`,
        "  - Separate skills: package each on its own, or build a plugin (skills/<name>/SKILL.md).",
        "  - Supporting docs: rename to non-SKILL.md files (e.g. references/<topic>.md).",
        "  - Swept in by mistake: package only the one skill directory.",
      ].join("\n"),
    };
  }

  const content = skillFileText(rootSkill);
  if (!content.startsWith("---")) {
    return { valid: false, message: "No YAML frontmatter found" };
  }

  const match = frontmatterMatch(content);
  if (!match) {
    return { valid: false, message: "Invalid frontmatter format" };
  }

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(match[1] ?? "");
  } catch (error) {
    return {
      valid: false,
      message:
        error instanceof Error ? error.message : "Invalid YAML in frontmatter",
    };
  }

  const unexpectedKeys = Object.keys(frontmatter).filter(
    (key) => !ALLOWED_PROPERTIES.has(key),
  );
  if (unexpectedKeys.length) {
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpectedKeys.sort().join(", ")}. Allowed properties are: ${Array.from(ALLOWED_PROPERTIES).sort().join(", ")}`,
    };
  }

  if (!("name" in frontmatter)) {
    return { valid: false, message: "Missing 'name' in frontmatter" };
  }
  if (!("description" in frontmatter)) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }

  const name = frontmatter.name;
  if (typeof name !== "string") {
    return {
      valid: false,
      message: `Name must be a string, got ${name === null ? "NoneType" : typeof name}`,
    };
  }
  const trimmedName = name.trim();
  if (trimmedName) {
    if (!/^[a-z0-9-]+$/.test(trimmedName)) {
      return {
        valid: false,
        message: `Name '${trimmedName}' should be kebab-case (lowercase letters, digits, and hyphens only)`,
      };
    }
    if (
      trimmedName.startsWith("-") ||
      trimmedName.endsWith("-") ||
      trimmedName.includes("--")
    ) {
      return {
        valid: false,
        message: `Name '${trimmedName}' cannot start/end with hyphen or contain consecutive hyphens`,
      };
    }
    if (trimmedName.length > 64) {
      return {
        valid: false,
        message: `Name is too long (${trimmedName.length} characters). Maximum is 64 characters.`,
      };
    }
  }

  const description = frontmatter.description;
  if (typeof description !== "string") {
    return {
      valid: false,
      message: `Description must be a string, got ${description === null ? "NoneType" : typeof description}`,
    };
  }
  const trimmedDescription = description.trim();
  if (trimmedDescription) {
    if (trimmedDescription.includes("<") || trimmedDescription.includes(">")) {
      return {
        valid: false,
        message: "Description cannot contain angle brackets (< or >)",
      };
    }
    if (trimmedDescription.length > 1024) {
      return {
        valid: false,
        message: `Description is too long (${trimmedDescription.length} characters). Maximum is 1024 characters.`,
      };
    }
  }

  const compatibility = frontmatter.compatibility;
  if (compatibility) {
    if (typeof compatibility !== "string") {
      return {
        valid: false,
        message: `Compatibility must be a string, got ${typeof compatibility}`,
      };
    }
    if (compatibility.length > 500) {
      return {
        valid: false,
        message: `Compatibility is too long (${compatibility.length} characters). Maximum is 500 characters.`,
      };
    }
  }

  return { valid: true, message: "Skill is valid!" };
};

export interface GeneratedSkillQualityOptions {
  requireEvals?: boolean | undefined;
  requireResourceReferences?: boolean | undefined;
}

const MIN_GENERATED_SKILL_EVALS = 3;

const sectionPattern = (label: string): RegExp =>
  new RegExp(`^##\\s+${label}(?:\\s|$)`, "im");

const hasAnySection = (body: string, labels: string[]): boolean =>
  labels.some((label) => sectionPattern(label).test(body));

const isReferencePath = (path: string): boolean =>
  path.startsWith("references/") &&
  /\.(?:md|txt|json|yaml|yml|html)$/i.test(path);

const isScriptPath = (path: string): boolean =>
  path.startsWith("scripts/") &&
  /\.(?:py|js|ts|mjs|cjs|sh|bash|rb|go|rs)$/i.test(path);

const isAssetPath = (path: string): boolean => path.startsWith("assets/");

const parseEvals = (file: SkillFileRecord | undefined): string | null => {
  if (!file)
    return `Generated skills must include evals/evals.json with at least ${MIN_GENERATED_SKILL_EVALS} realistic test prompts.`;
  try {
    const parsed = JSON.parse(skillFileText(file)) as unknown;
    if (!parsed || typeof parsed !== "object")
      return "evals/evals.json must be a JSON object.";
    const evals = (parsed as { evals?: unknown }).evals;
    if (!Array.isArray(evals) || evals.length < MIN_GENERATED_SKILL_EVALS) {
      return `evals/evals.json must contain at least ${MIN_GENERATED_SKILL_EVALS} evals.`;
    }
    for (const [index, item] of evals.entries()) {
      if (!item || typeof item !== "object") {
        return `evals/evals.json eval ${index + 1} must be an object.`;
      }
      const record = item as {
        prompt?: unknown;
        expected_output?: unknown;
        expectations?: unknown;
      };
      if (typeof record.prompt !== "string" || !record.prompt.trim()) {
        return `evals/evals.json eval ${index + 1} is missing a prompt.`;
      }
      if (
        typeof record.expected_output !== "string" ||
        !record.expected_output.trim()
      ) {
        return `evals/evals.json eval ${index + 1} is missing expected_output.`;
      }
      if (
        "expectations" in record &&
        (!Array.isArray(record.expectations) ||
          !record.expectations.every(
            (expectation) =>
              typeof expectation === "string" && expectation.trim(),
          ))
      ) {
        return `evals/evals.json eval ${index + 1} expectations must be non-empty strings.`;
      }
    }
  } catch (error) {
    return `evals/evals.json is invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`;
  }
  return null;
};

export const validateGeneratedSkillQuality = (
  files: SkillFileRecord[],
  options: GeneratedSkillQualityOptions = {},
): SkillValidationResult => {
  const baseValidation = validateSkillFiles(files);
  if (!baseValidation.valid) return baseValidation;

  const normalized = files.map((file) => ({
    path: normalizePath(file.path),
    content: file.content,
    ...(file.encoding === "base64" ? { encoding: "base64" as const } : {})
  }));
  const rootSkill = normalized.find((file) => file.path === "SKILL.md");
  if (!rootSkill) return { valid: false, message: "SKILL.md not found" };

  const parsed = parseSkillMarkdown(skillFileText(rootSkill));
  const body = parsed.body.trim();
  const errors: string[] = [];

  const hasActionableWorkflow = /\b(inspect|detect|read|check|verify|validate|run|open|search|compare|generate|update|install|fallback|recover)\b/i.test(body);
  const hasConcreteExamples = /\b(example|for example|sample|input:|output:|prompt:)\b/i.test(body);
  const hasExplicitFailures = /\b(if .* fails|fallback|do not|never|avoid|when not|error|invalid|unsupported)\b/i.test(body);

  if (!hasActionableWorkflow || !hasConcreteExamples || !hasExplicitFailures) {
    errors.push(
      "Generated skill is too thin. Add concrete workflow steps, examples, edge cases, failure handling, and quality checks before installing.",
    );
  }

  const requiredSectionGroups: Array<{ name: string; labels: string[] }> = [
    { name: "Purpose", labels: ["Purpose", "Goal", "What this skill does"] },
    {
      name: "When to use",
      labels: ["When to use", "Trigger conditions", "Use this skill when"],
    },
    {
      name: "When not to use",
      labels: ["When not to use", "Do not use", "Avoid using"],
    },
    {
      name: "Workflow",
      labels: ["Workflow", "Procedure", "Method", "Process"],
    },
    {
      name: "Output requirements",
      labels: ["Output requirements", "Output format", "Deliverables"],
    },
    {
      name: "References and scripts",
      labels: ["References and scripts", "Resources", "Bundled resources"],
    },
    {
      name: "Quality checks",
      labels: ["Quality checks", "Validation", "Verification"],
    },
  ];

  for (const group of requiredSectionGroups) {
    if (!hasAnySection(body, group.labels)) {
      errors.push(`SKILL.md must include a ## ${group.name} section.`);
    }
  }

  if (
    !/\b(use this skill|use when|whenever|trigger)\b/i.test(parsed.description)
  ) {
    errors.push(
      "Description must be trigger-focused and say when to use the skill.",
    );
  }

  if (!/\b(inspect|detect|read|check|verify|validate)\b/i.test(body)) {
    errors.push(
      "Workflow must include project/context inspection before generating output.",
    );
  }

  if (
    !/\b(do not invent|never invent|official|source|documentation|reference)\b/i.test(
      body,
    )
  ) {
    errors.push(
      "Skill must tell the agent not to invent unsupported APIs, packages, commands, or facts, and to rely on sources/references.",
    );
  }

  const placeholderPatterns = [
    /\bTODO\b/i,
    /\bTBD\b/i,
    /<your[-_\s]?name>/i,
    /hypothetical/i,
    /fake package/i,
    /example\.com/i,
    /omitted for brevity/i,
    /etc\.\s*$/im,
  ];
  for (const pattern of placeholderPatterns) {
    if (
      pattern.test(skillFileText(rootSkill)) ||
      normalized.some(
        (file) => file.path !== "SKILL.md" && pattern.test(skillFileText(file)),
      )
    ) {
      errors.push(
        "Skill package contains placeholder, hypothetical, or incomplete content. Replace it with concrete, verified instructions.",
      );
      break;
    }
  }

  const referenceFiles = normalized.filter((file) =>
    isReferencePath(file.path),
  );
  const scriptFiles = normalized.filter((file) => isScriptPath(file.path));
  const assetFiles = normalized.filter((file) => isAssetPath(file.path));

  if (referenceFiles.length === 0) {
    errors.push(
      "Generated skills must include at least one references/* file with source material, docs links, schemas, examples, or domain rules used by the workflow.",
    );
  }

  const linkReference = referenceFiles.find((file) =>
    /(^|\/)links\.md$/i.test(file.path),
  );
  if (linkReference) {
    const urls = skillFileText(linkReference).match(/https?:\/\/[^\s)>'"]+/g) ?? [];
    if (urls.length < 2) {
      errors.push(
        "references/links.md must include at least two concrete source URLs when used as the only downloaded/linked reference index.",
      );
    }
  }

  if (options.requireResourceReferences ?? true) {
    for (const file of [...referenceFiles, ...scriptFiles, ...assetFiles]) {
      if (!body.includes(file.path)) {
        errors.push(
          `Bundled file '${file.path}' must be referenced from SKILL.md with when/how to use it.`,
        );
      }
    }
  }

  for (const file of referenceFiles) {
    const content = skillFileText(file);
    if (!content.trim()) {
      errors.push(`Reference file '${file.path}' is empty.`);
    }
    if (
      content.length > 80_000 &&
      !/table of contents|toc/i.test(content.slice(0, 2_000))
    ) {
      errors.push(
        `Large reference '${file.path}' must begin with a table of contents.`,
      );
    }
  }

  for (const file of scriptFiles) {
    const content = skillFileText(file);
    const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) {
      errors.push(
        `Script '${file.path}' must start with a shebang so execution behavior is explicit.`,
      );
    }
    if (
      !/usage:|args?:|input:|arguments:/i.test(content.slice(0, 2_000))
    ) {
      errors.push(
        `Script '${file.path}' must document usage, inputs, or arguments near the top.`,
      );
    }
    if (
      /\b(rm\s+-rf\s+\/|curl\s+[^|\n]*\|\s*(sh|bash)|wget\s+[^|\n]*\|\s*(sh|bash))\b/i.test(
        content,
      )
    ) {
      errors.push(`Script '${file.path}' contains unsafe shell behavior.`);
    }
  }

  if (options.requireEvals ?? true) {
    const evalError = parseEvals(
      normalized.find((file) => file.path === "evals/evals.json"),
    );
    if (evalError) errors.push(evalError);
  }

  if (errors.length) {
    return {
      valid: false,
      message: [
        "Generated skill review warnings:",
        ...errors.map((error) => `- ${error}`),
      ].join("\n"),
    };
  }

  return {
    valid: true,
    message: "Generated skill review passed.",
  };
};
