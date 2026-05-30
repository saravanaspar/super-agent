import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { JsonRecord, JsonValue } from "@shared/json";
import { toJsonRecord, toJsonValue } from "@shared/json";
import { redactSensitiveText } from "@shared/redaction";
import {
  isLocalHostname,
  isLoopbackIp,
  normalizeHostname,
  resolveHttpUrlForNetworkAccess
} from "@security/networkPolicy";
import type { McpServerConfig } from "./mcpConfig";
import type { McpServerRuntimeStatus, McpToolMetadata } from "./mcpClient";

const PROTOCOL_VERSION = "2025-06-18";
const PREVIEW_LIMIT = 8_192;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
type JsonRpcId = number | string;

type JsonRpcEnvelope = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

interface McpHttpResponse {
  status: number;
  url: string;
  headers: { get: (name: string) => string | null };
  body: IncomingMessage;
}

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedAppend = (current: string, next: string): string => {
  const combined = `${current}${redactSensitiveText(next)}`;
  if (combined.length <= PREVIEW_LIMIT) return combined;
  return combined.slice(combined.length - PREVIEW_LIMIT);
};

const readHeader = (headers: IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
};

const isRedirectStatus = (status: number): boolean => status >= 300 && status < 400;

const networkOptionsForMcpUrl = (rawUrl: string): { allowLocalhost: boolean } => {
  const parsed = new URL(rawUrl);
  const hostname = normalizeHostname(parsed.hostname);
  return { allowLocalhost: isLocalHostname(hostname) || isLoopbackIp(hostname) };
};

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

const isJsonRpcId = (value: unknown): value is JsonRpcId =>
  typeof value === "number" || typeof value === "string";

const jsonRpcErrorMessage = (error: unknown): string => {
  if (!isJsonRecord(error)) return "MCP HTTP request failed.";
  return typeof error.message === "string" ? error.message : "MCP HTTP request failed.";
};

const responseResult = (message: unknown, id: JsonRpcId): unknown => {
  if (Array.isArray(message)) {
    for (const item of message) {
      const result = responseResult(item, id);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  if (!isJsonRecord(message) || message.id !== id) return undefined;
  if (isJsonRecord(message.error)) throw new Error(jsonRpcErrorMessage(message.error));
  return message.result;
};

const parseSseEventBlock = (eventBlock: string): unknown[] => {
  const data = eventBlock
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return [];
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
};

export class McpHttpClient {
  private nextRequestId = 1;
  private initialized = false;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private responsePreview = "";
  private toolsCache: McpToolMetadata[] = [];
  private sessionId: string | null = null;

  constructor(private readonly config: McpServerConfig) {}

  status(): McpServerRuntimeStatus {
    return {
      serverId: this.config.id,
      running: this.initialized,
      startedAt: this.startedAt,
      lastError: this.lastError,
      stderrPreview: this.responsePreview,
      toolCount: this.toolsCache.length
    };
  }

  async start(): Promise<void> {
    if (this.initialized) return;
    this.lastError = null;
    this.responsePreview = "";
    await this.initialize();
    this.startedAt = new Date().toISOString();
  }

  async stop(): Promise<void> {
    if (this.sessionId) {
      await this.deleteSession();
    }
    this.initialized = false;
    this.sessionId = null;
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
    const result = await this.request("tools/call", { name: toolName, arguments: args });
    return toJsonValue(result);
  }

  private async initialize(): Promise<void> {
    const result = await this.postRequest("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "super-agent", version: "0.1.0" }
    });
    if (!isJsonRecord(result)) throw new Error("MCP HTTP server returned an invalid initialize result.");
    this.initialized = true;
    await this.sendNotification("notifications/initialized", {});
  }

  private async request(method: string, params: JsonRecord): Promise<unknown> {
    try {
      return await this.postRequest(method, params);
    } catch (error) {
      if (this.sessionId && error instanceof Error && error.message.includes("HTTP 404")) {
        this.initialized = false;
        this.sessionId = null;
        await this.start();
        return this.postRequest(method, params);
      }
      throw error;
    }
  }

  private async sendNotification(method: string, params: JsonRecord): Promise<void> {
    await this.postJson({ jsonrpc: "2.0", method, params }, false, async () => null);
  }

  private async postRequest(method: string, params: JsonRecord): Promise<unknown> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return this.postJson({ jsonrpc: "2.0", id, method, params }, true, async (response) => this.parseResponse(response, id));
  }

  private async postJson<T>(
    payload: JsonRecord,
    expectBody: boolean,
    parse: (response: McpHttpResponse) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();

    try {
      const response = await this.openHttpRequest("POST", payload, controller.signal);
      this.captureSession(response);
      this.assertUsableResponse(response);
      if (!expectBody && response.status === 202) {
        response.body.resume();
        return parse(response);
      }
      return await parse(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = redactSensitiveText(message);
      throw new Error(this.lastError);
    } finally {
      clearTimeout(timer);
    }
  }

  private requestHeaders(): Record<string, string> {
    return {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...this.config.headers,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {})
    };
  }

  private async openHttpRequest(
    method: "POST" | "DELETE",
    payload: JsonRecord | null,
    signal: AbortSignal,
  ): Promise<McpHttpResponse> {
    const networkOptions = networkOptionsForMcpUrl(this.config.url);
    const resolved = await resolveHttpUrlForNetworkAccess(this.config.url, networkOptions);
    const isAllowedLocalHttp = resolved.url.protocol === "http:" && networkOptions.allowLocalhost;
    if (resolved.url.protocol !== "https:" && !isAllowedLocalHttp) {
      throw new Error("Remote MCP connectors must use HTTPS; localhost HTTP is allowed for development.");
    }

    const client = resolved.url.protocol === "https:" ? https : http;
    const body = payload ? JSON.stringify(payload) : null;

    return new Promise<McpHttpResponse>((resolve, reject) => {
      const request = client.request(
        resolved.url,
        {
          method,
          headers: this.requestHeaders(),
          signal,
          lookup: resolved.address
            ? (_hostname, _options, callback) => {
                callback(null, resolved.address ?? "", resolved.family ?? 4);
              }
            : undefined,
        },
        (response) => {
          resolve({
            status: response.statusCode ?? 0,
            url: resolved.url.href,
            headers: { get: (name) => readHeader(response.headers, name) },
            body: response,
          });
        },
      );

      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }

  private captureSession(response: McpHttpResponse): void {
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId) this.sessionId = sessionId;
  }

  private assertUsableResponse(response: McpHttpResponse): void {
    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      response.body.resume();
      throw new Error(
        location
          ? `MCP HTTP redirects are not followed. Configure the final endpoint instead of redirecting to ${location}.`
          : "MCP HTTP redirects are not followed. Configure the final endpoint instead."
      );
    }
    if (response.status < 200 || response.status >= 300) {
      response.body.resume();
      throw new Error(`MCP HTTP request failed with HTTP ${response.status}.`);
    }
  }

  private async parseResponse(response: McpHttpResponse, id: JsonRpcId): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
      return this.parseSseResponse(response, id);
    }

    if (!contentType.includes("application/json")) {
      throw new Error(`MCP HTTP response used unsupported content type: ${contentType || "unknown"}.`);
    }

    const body = await this.readResponseText(response);
    this.responsePreview = boundedAppend(this.responsePreview, body.slice(0, PREVIEW_LIMIT));
    const parsed = JSON.parse(body) as unknown;
    const result = responseResult(parsed, id);
    if (result === undefined) throw new Error("MCP HTTP response id did not match the request id.");
    return result;
  }

  private async readResponseText(response: McpHttpResponse): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      totalBytes += buffer.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        response.body.destroy();
        throw new Error("MCP HTTP response exceeded maximum size.");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async parseSseResponse(response: McpHttpResponse, id: JsonRpcId): Promise<unknown> {
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;

    for await (const value of response.body) {
      const chunkBuffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      totalBytes += chunkBuffer.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        response.body.destroy();
        throw new Error("MCP HTTP SSE response exceeded maximum size.");
      }

      const chunk = decoder.decode(chunkBuffer, { stream: true }).replace(/\r\n/g, "\n");
      if (chunk) {
        buffer += chunk;
        this.responsePreview = boundedAppend(this.responsePreview, chunk.slice(0, PREVIEW_LIMIT));
      }

      for (;;) {
        const separator = buffer.indexOf("\n\n");
        if (separator < 0) break;
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const result = this.handleSseMessages(parseSseEventBlock(block), id);
        if (result !== undefined) {
          response.body.destroy();
          return result;
        }
      }
    }

    const remaining = decoder.decode().replace(/\r\n/g, "\n");
    if (remaining) buffer += remaining;
    const result = this.handleSseMessages(parseSseEventBlock(buffer), id);
    if (result !== undefined) return result;
    throw new Error("MCP HTTP SSE response did not include the matching JSON-RPC response.");
  }

  private handleSseMessages(messages: unknown[], id: JsonRpcId): unknown {
    for (const message of messages) {
      const maybeRequest = message as JsonRpcEnvelope;
      if (isJsonRecord(message) && isJsonRpcId(maybeRequest.id) && typeof maybeRequest.method === "string") {
        this.responsePreview = boundedAppend(this.responsePreview, `\nUnsupported MCP server request over SSE: ${maybeRequest.method}`);
        continue;
      }
      const result = responseResult(message, id);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  private async deleteSession(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();

    try {
      const response = await this.openHttpRequest("DELETE", null, controller.signal);
      response.body.resume();
    } catch {
      this.lastError = "MCP HTTP session delete failed.";
    } finally {
      clearTimeout(timer);
    }
  }
}
