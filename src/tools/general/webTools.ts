import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { JsonRecord } from "@shared/json";
import type { ToolDefinition } from "@tool-registry/types";
import { failureResult, successResult } from "@tool-registry/types";
import { resolveHttpUrlForNetworkAccess } from "../../security/networkPolicy";

const searchWebInput = z.object({
  query: z.string().min(1),
  num_results: z.number().int().positive().optional()
});

const webFetchInput = z.object({
  url: z.string().url(),
  max_chars: z.number().int().positive().optional(),
  max_bytes: z.number().int().positive().optional(),
  max_redirects: z.number().int().min(0).optional(),
  timeout_ms: z.number().int().positive().optional()
});

type SearchWebInput = z.infer<typeof searchWebInput>;
type WebFetchInput = z.infer<typeof webFetchInput>;

const parameters = (properties: JsonRecord, required: string[] = []): JsonRecord => ({ type: "object", properties, required });

const resolveSafeExecutable = (name: string): string => {
  const resolved = spawnSync("sh", ["-lc", "command -v \"$1\"", "sh", name], { encoding: "utf8", timeout: 2000, maxBuffer: 8192 });
  const candidate = String(resolved.stdout || "").split(/\r?\n/)[0]?.trim() ?? "";
  if (!candidate || !isAbsolute(candidate)) return "";
  if (candidate.includes("/node_modules/.bin/") || candidate.startsWith(`${process.cwd()}/`)) return "";

  try {
    const stats = statSync(candidate);
    const parentStats = statSync(dirname(candidate));
    if (!stats.isFile()) return "";
    if ((parentStats.mode & 0o002) !== 0) return "";
    return candidate;
  } catch {
    return "";
  }
};

const stripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const extractTitle = (html: string): string => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return stripHtml(match?.[1] ?? "");
};

interface SafeFetchResponse {
  status: number;
  url: string;
  bytes: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}

const readHeader = (
  headers: IncomingHttpHeaders,
  name: string
): string | null => {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
};

const requestPinnedUrl = async (
  rawUrl: string,
  init: RequestInit,
  maxBytes: number
): Promise<SafeFetchResponse> => {
  const resolved = await resolveHttpUrlForNetworkAccess(rawUrl);
  const client = resolved.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = client.request(
      resolved.url,
      {
        method: "GET",
        headers: init.headers as Record<string, string>,
        signal: init.signal ?? undefined,
        lookup: resolved.address
          ? (_hostname, _options, callback) => {
              callback(null, resolved.address ?? "", resolved.family ?? 4);
            }
          : undefined
      },
      (response) => {
        response.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            fail(new Error("URL fetch exceeded maximum response size."));
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });

        response.on("end", () => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            url: resolved.url.href,
            bytes: totalBytes,
            headers: {
              get: (name) => readHeader(response.headers, name)
            },
            text: () => Promise.resolve(body)
          });
        });
      }
    );

    request.on("error", (error) => fail(error));
    request.end();
  });
};

const fetchWithSafeRedirects = async (
  startUrl: string,
  init: RequestInit,
  maxRedirects: number,
  maxBytes: number
): Promise<SafeFetchResponse> => {
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await requestPinnedUrl(currentUrl, init, maxBytes);

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirectCount === maxRedirects) {
      throw new Error("URL fetch exceeded maximum redirects.");
    }

    currentUrl = new URL(location, currentUrl).href;
  }

  throw new Error("URL fetch exceeded maximum redirects.");
};

const searchWebTool: ToolDefinition<SearchWebInput> = {
  name: "search_web",
  description: "Search the web using DuckDuckGo through ddgr when installed.",
  category: "general",
  risk: "medium",
  inputSchema: searchWebInput,
  parameters: parameters({ query: { type: "string" }, num_results: { type: "number" } }, ["query"]),
  execute(input) {
    const count = Math.max(1, Math.min(input.num_results ?? 5, 10));
    const ddgrPath = resolveSafeExecutable("ddgr");
    if (!ddgrPath) return Promise.resolve(failureResult("Search unavailable. Install ddgr or use browser tools.", { query: input.query, count: 0, results: [] }));
    const result = spawnSync(ddgrPath, ["--json", "-n", String(count), "--", input.query], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    if (result.error) return Promise.resolve(failureResult("Search unavailable. ddgr failed.", { query: input.query, error: result.error.message }));
    try {
      const parsed = JSON.parse(result.stdout || "[]") as unknown;
      const results = Array.isArray(parsed) ? parsed : [parsed];
      return Promise.resolve(successResult("Web search completed.", { query: input.query, count: results.length, results: results as JsonRecord[] }));
    } catch {
      return Promise.resolve(failureResult("Search returned invalid JSON.", { query: input.query }));
    }
  }
};

const webFetchTool: ToolDefinition<WebFetchInput> = {
  name: "web_fetch",
  description: "Fetch the content of a URL and extract readable text. Blocks local/private network targets and unsafe redirects.",
  category: "general",
  risk: "medium",
  inputSchema: webFetchInput,
  parameters: parameters({ url: { type: "string" }, max_chars: { type: "number" }, max_bytes: { type: "number" }, max_redirects: { type: "number" }, timeout_ms: { type: "number" } }, ["url"]),
  async execute(input) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(500, Math.min(input.timeout_ms ?? 15000, 15000)));
    timeout.unref?.();

    try {
      const maxChars = Math.max(1, Math.min(input.max_chars ?? 10000, 100000));
      const maxBytes = Math.max(1024, Math.min(input.max_bytes ?? 1024 * 1024, 1024 * 1024));
      const maxRedirects = Math.max(0, Math.min(input.max_redirects ?? 5, 10));
      const response = await fetchWithSafeRedirects(
        input.url,
        {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; SuperAgent/0.1)" }
        },
        maxRedirects,
        maxBytes
      );
      const text = await response.text();
      const stripped = stripHtml(text);
      return successResult("URL fetched.", { url: response.url, status: response.status, bytes: response.bytes, truncated: response.bytes > maxBytes || stripped.length > maxChars, title: extractTitle(text), content: stripped.slice(0, maxChars) });
    } catch (error) {
      return failureResult(error instanceof Error ? error.message : "Web fetch failed.", { url: input.url }, true);
    } finally {
      clearTimeout(timeout);
    }
  }
};

export const webTools: ToolDefinition[] = [searchWebTool, webFetchTool];
