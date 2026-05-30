import { useMemo } from "react";
import type { ChatMessage, ToolCallRecord, ToolResultRecord } from "@shared/types";
import type { JsonRecord, JsonValue } from "@shared/json";

interface ToolActivityItem {
  id: string;
  title: string;
  status: "call" | "ok" | "failed" | "blocked";
  toolName: string;
  command: string;
  params: string;
  message: string;
  output: string;
}

const MAX_DISPLAY_OUTPUT_CHARS = 12_000;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: JsonValue | undefined): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const getString = (record: JsonRecord, key: string): string | null =>
  asString(record[key]);

const getNumber = (record: JsonRecord, key: string): number | null => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const stringifyJson = (value: JsonValue | undefined): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value, null, 2);
};

const boundedDisplay = (value: string): string => {
  if (value.length <= MAX_DISPLAY_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_DISPLAY_OUTPUT_CHARS).trimEnd()}\n...[display truncated; inspect with a narrower command or line range]...`;
};

const compactJsonParams = (input: JsonRecord): string =>
  Object.keys(input).length === 0 ? "" : JSON.stringify(input, null, 2);

const quoted = (value: string | null): string => {
  if (!value) return "";
  return /\s/.test(value) ? JSON.stringify(value) : value;
};

const lineRange = (input: JsonRecord): string => {
  const start =
    getNumber(input, "startLine") ??
    getNumber(input, "start_line") ??
    getNumber(input, "start");
  const end =
    getNumber(input, "endLine") ??
    getNumber(input, "end_line") ??
    getNumber(input, "end");

  if (start !== null && end !== null) return ` ${start}-${end} lines`;
  if (start !== null) return ` from line ${start}`;
  return "";
};

const buildCommandText = (toolName: string, input: JsonRecord): string => {
  const path = getString(input, "path");
  const pattern = getString(input, "pattern") ?? getString(input, "query");
  const command = getString(input, "command");
  const text = getString(input, "text") ?? getString(input, "content");

  if (toolName === "ls") return `ls ${quoted(path) || "."}`;
  if (toolName === "read_file") {
    return `read_file ${quoted(path) || "<path>"}${lineRange(input)}`;
  }
  if (toolName === "grep") return `grep ${quoted(pattern) || "<pattern>"} ${quoted(path) || "."}`;
  if (toolName === "bash") return command || toolName;
  if (toolName === "write_file") {
    return `write ${quoted(path) || "<path>"}${text ? ` (${text.length} chars)` : ""}`;
  }
  if (toolName === "edit_file" || toolName === "edit_range") {
    return `${toolName} ${quoted(path) || "<path>"}${lineRange(input)}`;
  }
  if (toolName === "mkdir" || toolName === "rm" || toolName === "exists") {
    return `${toolName} ${quoted(path) || "<path>"}`;
  }

  const args = Object.entries(input)
    .map(([key, value]) => `${key}=${typeof value === "string" ? quoted(value) : stringifyJson(value)}`)
    .join(" ");
  return args ? `${toolName} ${args}` : toolName;
};

const parseToolCall = (message: ChatMessage): ToolCallRecord | null => {
  const rawCall = message.metadata.call;
  if (!isRecord(rawCall)) return null;

  const id = getString(rawCall, "id");
  const name = getString(rawCall, "name");
  const input = rawCall.input;
  if (!id || !name || !isRecord(input)) return null;

  return {
    id,
    name,
    risk: rawCall.risk === "medium" || rawCall.risk === "high" ? rawCall.risk : "safe",
    input
  };
};

const parseToolResult = (message: ChatMessage): ToolResultRecord | null => {
  const rawResult = message.metadata.result;
  if (!isRecord(rawResult)) return null;

  const toolCallId = getString(rawResult, "toolCallId");
  const toolName = getString(rawResult, "toolName");
  const messageText = getString(rawResult, "message") ?? message.content;
  if (!toolCallId || !toolName) return null;

  return {
    toolCallId,
    toolName,
    ok: rawResult.ok === true,
    risk: rawResult.risk === "medium" || rawResult.risk === "high" ? rawResult.risk : "safe",
    blocked: rawResult.blocked === true,
    message: messageText,
    data: rawResult.data ?? null
  };
};

const outputFromBatchFiles = (files: JsonValue | undefined): string => {
  if (!Array.isArray(files)) return "";

  return files
    .map((item) => {
      if (!isRecord(item)) return stringifyJson(item);
      const path = getString(item, "path") ?? "<file>";
      const content = stringifyJson(item.content);
      const error = getString(item, "error");
      const offset = getNumber(item, "offset") ?? 1;
      const returnedLines = getNumber(item, "returned_lines");
      const totalLines = getNumber(item, "total_lines");
      const endLine = returnedLines !== null ? offset + returnedLines - 1 : null;
      const range = totalLines !== null
        ? ` lines ${offset}-${endLine ?? "?"}/${totalLines}`
        : "";
      return [`# ${path}${range}`, error ? `Error: ${error}` : content].filter(Boolean).join("\n");
    })
    .join("\n\n");
};

const outputFromResult = (result: ToolResultRecord): string => {
  if (isRecord(result.data)) {
    const batchFiles = outputFromBatchFiles(result.data.files);
    if (batchFiles) return boundedDisplay(batchFiles);

    const stdout = stringifyJson(result.data.stdout);
    const stderr = stringifyJson(result.data.stderr);
    const output = stringifyJson(result.data.output);
    const entries = stringifyJson(result.data.entries);
    const items = stringifyJson(result.data.items);
    const files = stringifyJson(result.data.files);
    const combined = [stdout, stderr, output, entries, items, files]
      .filter((item) => item.trim().length > 0)
      .join("\n\n")
      .trim();

    return boundedDisplay(combined || stringifyJson(result.data));
  }

  return boundedDisplay(stringifyJson(result.data));
};

const statusFromResult = (result: ToolResultRecord): ToolActivityItem["status"] =>
  result.blocked ? "blocked" : result.ok ? "ok" : "failed";

const titleFromResult = (result: ToolResultRecord, command: string): string => {
  if (result.blocked) return `Blocked ${command || result.toolName}`;
  if (result.ok) return `Ran ${command || result.toolName}`;
  return `Failed ${command || result.toolName}`;
};

const itemsFromMessages = (messages: ChatMessage[]): ToolActivityItem[] => {
  const calls = new Map<string, ToolCallRecord>();
  const items: ToolActivityItem[] = [];

  for (const message of messages) {
    const call = parseToolCall(message);
    if (call) {
      calls.set(call.id, call);
      continue;
    }

    const result = parseToolResult(message);
    if (!result) {
      items.push({
        id: message.id,
        title: message.content || "Tool activity",
        status: message.status === "failed" || message.status === "blocked" ? message.status : "call",
        toolName: "tool",
        command: "",
        params: "",
        message: message.content,
        output: ""
      });
      continue;
    }

    const matchingCall = calls.get(result.toolCallId);
    const command = matchingCall ? buildCommandText(matchingCall.name, matchingCall.input) : result.toolName;
    items.push({
      id: message.id,
      title: titleFromResult(result, command),
      status: statusFromResult(result),
      toolName: result.toolName,
      command,
      params: matchingCall ? compactJsonParams(matchingCall.input) : "",
      message: result.message,
      output: outputFromResult(result)
    });
    calls.delete(result.toolCallId);
  }

  for (const call of calls.values()) {
    const command = buildCommandText(call.name, call.input);
    items.push({
      id: call.id,
      title: `Running ${command}`,
      status: "call",
      toolName: call.name,
      command,
      params: compactJsonParams(call.input),
      message: "",
      output: ""
    });
  }

  return items;
};

const previewLines = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 2)
    .join("\n");

function ToolOutput({ output }: { output: string }) {
  const trimmed = output.trim();
  if (!trimmed) return null;

  const preview = previewLines(trimmed);
  const showPreview = preview && preview !== trimmed;

  return (
    <div className="tool-output-block">
      {showPreview ? (
        <div className="tool-output-preview">
          <div className="tool-field-label">Preview</div>
          <pre>{preview}</pre>
        </div>
      ) : null}
      <div className="tool-field-label">Output</div>
      <pre className="tool-output-scroll">{trimmed}</pre>
    </div>
  );
}

function ToolActivityCard({ item }: { item: ToolActivityItem }) {
  return (
    <article className={`tool-activity-card ${item.status}`}>
      <div className="tool-activity-title">{item.title}</div>
      {item.command ? <code className="tool-command">{item.command}</code> : null}
      {item.params ? (
        <details className="tool-params">
          <summary>Parameters</summary>
          <pre>{item.params}</pre>
        </details>
      ) : null}
      {item.message ? <div className="tool-message">{item.message}</div> : null}
      <ToolOutput output={item.output} />
    </article>
  );
}

export function ToolActivity({ messages }: { messages: ChatMessage[] }) {
  const items = useMemo(() => itemsFromMessages(messages), [messages]);
  if (items.length === 0) return null;

  return (
    <div className="tool-activity-list">
      {items.map((item) => (
        <ToolActivityCard item={item} key={item.id} />
      ))}
    </div>
  );
}
