import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export interface McpServerPermissions {
  network: boolean;
  filesystem: boolean;
}

export type McpTransport = "stdio" | "https";

export interface McpServerConfig {
  id: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  headers: Record<string, string>;
  env: Record<string, string>;
  autoStart: boolean;
  enabled: boolean;
  timeoutMs: number;
  permissions: McpServerPermissions;
}

export interface McpConfig {
  enabled: boolean;
  configPath: string | null;
  servers: McpServerConfig[];
  diagnostics: string[];
}

export interface RemoteMcpConnectorConfigInput {
  name: string;
  url: string;
  bearerToken?: string | undefined;
  autoStart?: boolean | undefined;
}

type YamlValue = string | number | boolean | null | YamlValue[] | YamlObject;
type YamlObject = { [key: string]: YamlValue };
type YamlContainer = YamlObject | YamlValue[];

interface ParsedLine {
  indent: number;
  text: string;
}

interface ParserFrame {
  indent: number;
  value: YamlContainer;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const SERVER_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MCP_SERVERS = 64;
const MAX_MCP_ARGS = 128;
const MAX_MCP_STRING_LENGTH = 16_384;
const SENSITIVE_CONFIG_PATTERN = /(?:authorization|bearer|api[_-]?key|token|secret|password|private[_-]?key)/i;

export const McpServerConfigSchema: z.ZodType<McpServerConfig> = z.object({
  id: z.string().regex(SERVER_ID_PATTERN).max(128),
  transport: z.enum(["stdio", "https"]),
  command: z.string().max(MAX_MCP_STRING_LENGTH),
  args: z.array(z.string().max(MAX_MCP_STRING_LENGTH)).max(MAX_MCP_ARGS),
  url: z.string().max(MAX_MCP_STRING_LENGTH),
  headers: z.record(z.string().regex(HEADER_NAME_PATTERN), z.string().max(MAX_MCP_STRING_LENGTH)),
  env: z.record(z.string().regex(ENV_NAME_PATTERN), z.string().max(MAX_MCP_STRING_LENGTH)),
  autoStart: z.boolean(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS),
  permissions: z.object({
    network: z.boolean(),
    filesystem: z.boolean(),
  }),
}).superRefine((server, ctx) => {
  if (server.transport === "stdio" && !server.command) {
    ctx.addIssue({ code: "custom", message: "stdio MCP servers require command" });
  }
  if (server.transport === "https" && !server.url) {
    ctx.addIssue({ code: "custom", message: "https MCP servers require url" });
  }
});

export const emptyMcpConfig = (configPath: string | null = null): McpConfig => ({
  enabled: false,
  configPath,
  servers: [],
  diagnostics: []
});

const stripComment = (line: string): string => {
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : "";

    if ((char === "'" || char === '"') && previous !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }

    if (char === "#" && quote === null) {
      return line.slice(0, index);
    }
  }

  return line;
};

const readYamlLines = (source: string): ParsedLine[] =>
  source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((rawLine) => {
      const withoutComment = stripComment(rawLine).replace(/\s+$/, "");
      return {
        indent: withoutComment.length - withoutComment.trimStart().length,
        text: withoutComment.trim()
      };
    })
    .filter((line) => line.text.length > 0);

const unquote = (value: string): string => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }

  return value;
};

const parseInlineArray = (value: string): YamlValue[] => {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => parseYamlScalar(item.trim()));
};

const parseYamlScalar = (value: string): YamlValue => {
  if (value === "{}") return {};
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) return parseInlineArray(value);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^(null|~)$/i.test(value)) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
};

const splitKeyValue = (text: string): [string, string] => {
  const separator = text.indexOf(":");
  if (separator < 0) return [text.trim(), ""];
  return [text.slice(0, separator).trim(), text.slice(separator + 1).trim()];
};

const nextContainerFor = (
  lines: ParsedLine[],
  currentIndex: number,
  currentIndent: number
): YamlContainer => {
  const nextLine = lines.slice(currentIndex + 1).find((line) => line.indent > currentIndent);
  return nextLine?.text.startsWith("- ") ? [] : {};
};

const parentFrameFor = (stack: ParserFrame[], indent: number): ParserFrame => {
  while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
    stack.pop();
  }

  return stack[stack.length - 1]!;
};

const assignMapping = (
  parent: ParserFrame,
  key: string,
  value: YamlValue
): void => {
  if (Array.isArray(parent.value)) {
    const objectValue: YamlObject = { [key]: value };
    parent.value.push(objectValue);
    return;
  }

  parent.value[key] = value;
};

const parseYamlObject = (source: string): YamlObject => {
  const lines = readYamlLines(source);
  const root: YamlObject = {};
  const stack: ParserFrame[] = [{ indent: -1, value: root }];

  lines.forEach((line, index) => {
    const parent = parentFrameFor(stack, line.indent);

    if (line.text.startsWith("- ")) {
      if (!Array.isArray(parent.value)) {
        throw new Error("YAML list item found under a mapping value.");
      }

      const itemText = line.text.slice(2).trim();
      parent.value.push(parseYamlScalar(itemText));
      return;
    }

    const [key, rawValue] = splitKeyValue(line.text);
    if (!key) throw new Error("YAML mapping key is empty.");

    if (rawValue.length > 0) {
      assignMapping(parent, key, parseYamlScalar(rawValue));
      return;
    }

    const container = nextContainerFor(lines, index, line.indent);
    assignMapping(parent, key, container);
    stack.push({ indent: line.indent, value: container });
  });

  return root;
};

const isRecord = (value: YamlValue | undefined): value is YamlObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: YamlValue | undefined): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asBoolean = (value: YamlValue | undefined, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const asTimeout = (value: YamlValue | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(Math.trunc(value), MAX_TIMEOUT_MS));
};

const asStringArray = (value: YamlValue | undefined): string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
};

const asScalarRecord = (
  value: YamlValue | undefined,
  workspaceDir: string,
  diagnostics: string[],
  label: string
): Record<string, string> => {
  if (!isRecord(value)) return {};
  const output: Record<string, string> = {};

  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      diagnostics.push(`Ignoring non-scalar MCP ${label} value: ${key}`);
      continue;
    }

    output[key] = interpolate(String(item), workspaceDir, diagnostics);
  }

  return output;
};

const interpolate = (
  value: string,
  workspaceDir: string,
  diagnostics: string[]
): string =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (name === "SUPER_AGENT_WORKSPACE_DIR") return workspaceDir;
    const envValue = process.env[name];
    if (envValue === undefined) {
      diagnostics.push(`Missing environment variable referenced in MCP config: ${name}`);
      return "";
    }

    return envValue;
  });

const asEnvRecord = (
  value: YamlValue | undefined,
  workspaceDir: string,
  diagnostics: string[]
): Record<string, string> => {
  const env = asScalarRecord(value, workspaceDir, diagnostics, "environment variable");

  for (const key of Object.keys(env)) {
    if (!ENV_NAME_PATTERN.test(key)) {
      diagnostics.push(`Ignoring invalid MCP environment variable name: ${key}`);
      delete env[key];
    }
  }

  return env;
};

const asHeaderRecord = (
  value: YamlValue | undefined,
  workspaceDir: string,
  diagnostics: string[]
): Record<string, string> => {
  const headers = asScalarRecord(value, workspaceDir, diagnostics, "header");

  for (const key of Object.keys(headers)) {
    if (!HEADER_NAME_PATTERN.test(key)) {
      diagnostics.push(`Ignoring invalid MCP HTTP header name: ${key}`);
      delete headers[key];
    }
  }

  return headers;
};

const isLocalHttpUrl = (url: URL): boolean =>
  url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);

const parseMcpUrl = (id: string, value: string | null, diagnostics: string[]): string | null => {
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" || isLocalHttpUrl(parsed)) return parsed.toString();
  } catch {
    diagnostics.push(`Ignoring MCP server ${id} because url is invalid.`);
    return null;
  }

  diagnostics.push(`Ignoring MCP server ${id} because HTTPS transport requires an https URL, except localhost http for development.`);
  return null;
};

const normalizeServer = (
  id: string,
  value: YamlValue,
  workspaceDir: string,
  diagnostics: string[]
): McpServerConfig | null => {
  if (!SERVER_ID_PATTERN.test(id)) {
    diagnostics.push(`Ignoring MCP server with invalid id: ${id}`);
    return null;
  }

  if (!isRecord(value)) {
    diagnostics.push(`Ignoring MCP server ${id} because its config is not a mapping.`);
    return null;
  }

  const configuredTransport = asString(value.transport);
  const url = parseMcpUrl(id, asString(value.url), diagnostics);
  const transport = configuredTransport === "https" ? "https" : configuredTransport === "stdio" ? "stdio" : url ? "https" : "stdio";
  const command = asString(value.command);

  if (configuredTransport && configuredTransport !== "stdio" && configuredTransport !== "https") {
    diagnostics.push(`Ignoring MCP server ${id} because transport is unsupported: ${configuredTransport}`);
    return null;
  }

  if (transport === "stdio" && !command) {
    diagnostics.push(`Ignoring MCP server ${id} because command is missing.`);
    return null;
  }

  if (transport === "https" && !url) {
    diagnostics.push(`Ignoring MCP server ${id} because url is missing.`);
    return null;
  }

  const permissions = isRecord(value.permissions) ? value.permissions : {};

  return {
    id,
    transport,
    command: command ? interpolate(command, workspaceDir, diagnostics) : "",
    args: asStringArray(value.args).map((arg) => interpolate(arg, workspaceDir, diagnostics)),
    url: url ?? "",
    headers: asHeaderRecord(value.headers, workspaceDir, diagnostics),
    env: asEnvRecord(value.env, workspaceDir, diagnostics),
    autoStart: asBoolean(value.auto_start, false),
    enabled: asBoolean(value.enabled, true),
    timeoutMs: asTimeout(value.timeout_ms),
    permissions: {
      network: asBoolean(permissions.network, transport === "https"),
      filesystem: asBoolean(permissions.filesystem, false)
    }
  };
};

export const validateMcpServerConfig = (server: McpServerConfig): string[] => {
  const parsed = McpServerConfigSchema.safeParse(server);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

export const normalizeMcpServerId = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);

const authorizationHeaderValue = (bearerToken: string | undefined): string | null => {
  const value = bearerToken?.trim();
  if (!value) return null;
  return /^Bearer\s+/i.test(value) ? value : `Bearer ${value}`;
};

export const createRemoteMcpServerConfig = (
  input: RemoteMcpConnectorConfigInput,
  workspaceDir: string,
): McpServerConfig => {
  const diagnostics: string[] = [];
  const id = normalizeMcpServerId(input.name);
  if (!id) throw new Error("MCP connector name must contain letters or numbers.");

  const url = parseMcpUrl(id, input.url.trim(), diagnostics);
  if (!url) throw new Error(diagnostics[0] ?? "MCP connector URL is invalid.");

  const authorization = authorizationHeaderValue(input.bearerToken);
  const server: McpServerConfig = {
    id,
    transport: "https",
    command: "",
    args: [],
    url,
    headers: authorization ? { Authorization: authorization } : {},
    env: {},
    autoStart: input.autoStart !== false,
    enabled: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    permissions: { network: true, filesystem: false }
  };

  const validationErrors = validateMcpServerConfig(server);
  if (validationErrors.length > 0) {
    throw new Error(`MCP connector config is invalid: ${validationErrors.join("; ")}`);
  }

  return {
    ...server,
    url: interpolate(server.url, workspaceDir, diagnostics),
  };
};

const validateServer = (server: McpServerConfig, diagnostics: string[]): McpServerConfig | null => {
  const parsed = McpServerConfigSchema.safeParse(server);
  if (parsed.success) return parsed.data;
  diagnostics.push(
    `Ignoring MCP server ${server.id} because schema validation failed: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
  );
  return null;
};

const configContainsSensitiveValue = (source: string): boolean => SENSITIVE_CONFIG_PATTERN.test(source);

const ensureConfigFilePermissions = (path: string, source: string, diagnostics: string[]): void => {
  if (process.platform === "win32" || !configContainsSensitiveValue(source)) return;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) === 0) return;
    chmodSync(path, mode & 0o700);
    diagnostics.push("Restricted MCP config file permissions because it contains sensitive-looking values.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(`MCP config contains sensitive-looking values but file permissions could not be restricted: ${message}`);
  }
};

const yamlString = (value: string): string => JSON.stringify(value);

const renderScalarMap = (map: Record<string, string>, indent: string): string[] => {
  const entries = Object.entries(map);
  if (entries.length === 0) return [`${indent}{}`];
  return entries.map(([key, value]) => `${indent}${key}: ${yamlString(value)}`);
};

const renderStringList = (values: string[], indent: string): string[] =>
  values.length === 0 ? [`${indent}[]`] : values.map((value) => `${indent}- ${yamlString(value)}`);

const renderMcpConfig = (servers: McpServerConfig[]): string => {
  const lines = ["mcp:", "  enabled: true", "  servers:"];
  for (const server of servers) {
    lines.push(`    ${server.id}:`);
    lines.push(`      enabled: ${server.enabled ? "true" : "false"}`);
    lines.push(`      transport: ${server.transport}`);
    if (server.transport === "stdio") {
      lines.push(`      command: ${yamlString(server.command)}`);
      lines.push("      args:");
      lines.push(...renderStringList(server.args, "        "));
      lines.push("      env:");
      lines.push(...renderScalarMap(server.env, "        "));
    } else {
      lines.push(`      url: ${yamlString(server.url)}`);
      lines.push("      headers:");
      lines.push(...renderScalarMap(server.headers, "        "));
    }
    lines.push(`      auto_start: ${server.autoStart ? "true" : "false"}`);
    lines.push(`      timeout_ms: ${server.timeoutMs}`);
    lines.push("      permissions:");
    lines.push(`        network: ${server.permissions.network ? "true" : "false"}`);
    lines.push(`        filesystem: ${server.permissions.filesystem ? "true" : "false"}`);
  }
  return `${lines.join("\n")}\n`;
};

const firstTopLevelLineAfter = (lines: string[], startIndex: number): number => {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) return index;
  }
  return lines.length;
};

const replaceMcpBlock = (source: string, block: string): string => {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^mcp\s*:/.test(line));
  if (start < 0) {
    const trimmed = source.trimEnd();
    return trimmed ? `${trimmed}\n\n${block}` : block;
  }

  const end = firstTopLevelLineAfter(lines, start);
  const nextLines = [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...lines.slice(end)];
  return `${nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
};

export const saveMcpServerConfig = (
  configPath: string | null,
  currentServers: McpServerConfig[],
  server: McpServerConfig,
): McpServerConfig[] => {
  if (!configPath) throw new Error("MCP config path is not configured.");
  const resolvedPath = resolveConfigPath(configPath);
  if (!resolvedPath) throw new Error("MCP config path is not configured.");

  const validationErrors = validateMcpServerConfig(server);
  if (validationErrors.length > 0) {
    throw new Error(`MCP connector config is invalid: ${validationErrors.join("; ")}`);
  }

  const servers = [
    ...currentServers.filter((item) => item.id !== server.id),
    server
  ];
  const existing = existsSync(resolvedPath) ? readFileSync(resolvedPath, "utf8") : "";
  const nextSource = replaceMcpBlock(existing, renderMcpConfig(servers));
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, nextSource, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(resolvedPath, 0o600);
  return servers;
};

const resolveConfigPath = (pathValue: string | null): string | null => {
  if (!pathValue) return null;
  return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue);
};

export const loadMcpConfig = (
  configPath: string | null,
  workspaceDir: string
): McpConfig => {
  const resolvedPath = resolveConfigPath(configPath);

  if (!resolvedPath || !existsSync(resolvedPath)) {
    return emptyMcpConfig(resolvedPath);
  }

  const diagnostics: string[] = [];
  const source = readFileSync(resolvedPath, "utf8");
  ensureConfigFilePermissions(resolvedPath, source, diagnostics);

  let parsed: YamlObject;
  try {
    parsed = parseYamlObject(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...emptyMcpConfig(resolvedPath),
      diagnostics: [`Invalid MCP YAML config: ${message}`],
    };
  }

  const mcpRoot = isRecord(parsed.mcp) ? parsed.mcp : null;

  if (!mcpRoot) {
    return emptyMcpConfig(resolvedPath);
  }

  const serversRoot = isRecord(mcpRoot.servers) ? mcpRoot.servers : {};
  if (mcpRoot.servers !== undefined && !isRecord(mcpRoot.servers)) {
    diagnostics.push("MCP config field mcp.servers must be a mapping.");
  }
  const serverEntries = Object.entries(serversRoot).slice(0, MAX_MCP_SERVERS);
  if (Object.keys(serversRoot).length > MAX_MCP_SERVERS) {
    diagnostics.push(`Only the first ${MAX_MCP_SERVERS} MCP servers were loaded from config.`);
  }
  const servers = serverEntries.flatMap(([id, serverValue]) => {
    const normalized = normalizeServer(id, serverValue, workspaceDir, diagnostics);
    const validated = normalized ? validateServer(normalized, diagnostics) : null;
    return validated ? [validated] : [];
  });

  return {
    enabled: asBoolean(mcpRoot.enabled, true),
    configPath: resolvedPath,
    servers,
    diagnostics
  };
};
