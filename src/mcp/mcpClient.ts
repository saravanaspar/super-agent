import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonRecord, JsonValue } from "@shared/json";
import { toJsonRecord, toJsonValue } from "@shared/json";
import { redactSensitiveText } from "@shared/redaction";
import type { McpServerConfig } from "./mcpConfig";

export interface McpToolMetadata {
  name: string;
  description: string;
  inputSchema: JsonRecord;
}

export interface McpServerRuntimeStatus {
  serverId: string;
  running: boolean;
  startedAt: string | null;
  lastError: string | null;
  stderrPreview: string;
  toolCount: number;
}

type JsonRpcId = number | string;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

const PROTOCOL_VERSION = "2024-11-05";
const STDERR_LIMIT = 8_192;

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedAppend = (current: string, next: string): string => {
  const combined = `${current}${redactSensitiveText(next)}`;
  if (combined.length <= STDERR_LIMIT) return combined;
  return combined.slice(combined.length - STDERR_LIMIT);
};

const baseServerEnv = (workspaceDir: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  HOME: workspaceDir,
  TMPDIR: process.env.TMPDIR || "/tmp",
  TEMP: process.env.TEMP || process.env.TMPDIR || "/tmp",
  SystemRoot: process.env.SystemRoot,
  MCP_SERVER_REQUESTOR: "super-agent"
});

const normalizeTool = (value: unknown): McpToolMetadata | null => {
  if (!isJsonRecord(value) || typeof value.name !== "string") return null;

  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : "",
    inputSchema: toJsonRecord(value.inputSchema)
  };
};

const extractTools = (result: unknown): { tools: McpToolMetadata[]; nextCursor: string | null } => {
  if (!isJsonRecord(result) || !Array.isArray(result.tools)) {
    return { tools: [], nextCursor: null };
  }

  return {
    tools: result.tools.flatMap((tool) => {
      const normalized = normalizeTool(tool);
      return normalized ? [normalized] : [];
    }),
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null
  };
};

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private stdoutBuffer = "";
  private stderrPreview = "";
  private initialized = false;
  private stopping = false;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private toolsCache: McpToolMetadata[] = [];

  constructor(
    private readonly config: McpServerConfig,
    private readonly workspaceDir: string
  ) {}

  status(): McpServerRuntimeStatus {
    return {
      serverId: this.config.id,
      running: this.child !== null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      stderrPreview: this.stderrPreview,
      toolCount: this.toolsCache.length
    };
  }

  async start(): Promise<void> {
    if (this.child && this.initialized) return;
    if (this.child && !this.initialized) await this.stop();

    this.lastError = null;
    this.stopping = false;
    this.stdoutBuffer = "";
    this.stderrPreview = "";
    this.child = spawn(this.config.command, this.config.args, {
      cwd: this.workspaceDir,
      env: { ...baseServerEnv(this.workspaceDir), ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.startedAt = new Date().toISOString();

    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrPreview = boundedAppend(this.stderrPreview, chunk.toString("utf8"));
    });
    this.child.on("error", (error) => {
      this.lastError = error.message;
      this.rejectAll(error);
    });
    this.child.on("close", (code, signal) => {
      const stderrDetail = this.stderrPreview ? ` stderr: ${this.stderrPreview}` : "";
      const message = `MCP server ${this.config.id} exited with code ${code ?? "null"}${signal ? ` and signal ${signal}` : ""}.${stderrDetail}`;
      const intentionalStop = this.stopping;
      this.stopping = false;
      this.lastError = code === 0 || intentionalStop ? null : message;
      this.child = null;
      this.initialized = false;
      this.rejectAll(new Error(message));
    });

    await this.initialize();
  }

  async stop(): Promise<void> {
    const activeChild = this.child;
    if (!activeChild) return;

    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        activeChild.kill("SIGKILL");
        resolve();
      }, 1_000);
      timer.unref?.();
      activeChild.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      activeChild.kill("SIGTERM");
    });
  }

  async listTools(): Promise<McpToolMetadata[]> {
    await this.start();
    const tools: McpToolMetadata[] = [];
    let cursor: string | null = null;

    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      const page = extractTools(result);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    this.toolsCache = tools;
    return tools;
  }

  async callTool(toolName: string, args: JsonRecord): Promise<JsonValue> {
    await this.start();
    const result = await this.request("tools/call", {
      name: toolName,
      arguments: args
    });
    return toJsonValue(result);
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "super-agent", version: "0.1.0" }
    });
    this.sendNotification("notifications/initialized", {});
    this.initialized = true;
  }

  private request(method: string, params: JsonRecord): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("MCP server is not running."));

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.config.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private sendNotification(method: string, params: JsonRecord): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) return;

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!rawLine) continue;
      this.handleMessage(rawLine);
    }
  }

  private handleMessage(rawLine: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      this.stderrPreview = boundedAppend(this.stderrPreview, `\nInvalid MCP JSON received: ${rawLine}`);
      return;
    }

    if (!isJsonRecord(parsed)) return;

    if ((typeof parsed.id === "number" || typeof parsed.id === "string") && typeof parsed.method === "string") {
      this.sendResponseError(parsed.id, -32601, `Unsupported MCP client request method: ${parsed.method}`);
      return;
    }

    if (typeof parsed.method === "string") {
      this.stderrPreview = boundedAppend(this.stderrPreview, `\nMCP notification: ${parsed.method}`);
      return;
    }

    if (typeof parsed.id !== "number" && typeof parsed.id !== "string") return;

    const pending = this.pending.get(parsed.id);
    if (!pending) return;

    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);

    const error = parsed.error;
    if (isJsonRecord(error)) {
      pending.reject(new Error(typeof error.message === "string" ? error.message : "MCP request failed."));
      return;
    }

    pending.resolve(parsed.result);
  }

  private sendResponseError(id: JsonRpcId, code: number, message: string): void {
    this.child?.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    })}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
