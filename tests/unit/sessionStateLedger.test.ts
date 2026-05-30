import { describe, expect, it } from "vitest";
import {
  SESSION_STATE_PREFIX,
  SessionStateLedger,
  injectSessionStateMessage
} from "@agent/sessionStateLedger";
import type { RuntimeGateVerification } from "@agent/runtimeGates";
import type {
  ChatMessage,
  RoutedChatSubmitRequest,
  ToolCallRecord,
  ToolResultRecord
} from "@shared/types";
import type { JsonRecord, JsonValue } from "@shared/json";

const request = (prompt = "review this"): RoutedChatSubmitRequest => ({
  sessionId: "session-1",
  prompt,
  model: {
    provider: "stub",
    model: "stub",
    label: "Stub",
    supportsThinking: true,
    contextWindow: 8192
  },
  permissionMode: "allow_safe_tools",
  agentKind: "general",
  attachments: [],
  command: null
});

const toolCall = (name: string, input: JsonRecord): ToolCallRecord => ({
  id: `${name}-call`,
  name,
  input,
  risk: "safe"
});

const toolResult = (
  toolName: string,
  data: JsonValue,
  overrides: Partial<ToolResultRecord> = {}
): ToolResultRecord => ({
  toolCallId: `${toolName}-call`,
  toolName,
  ok: overrides.ok ?? true,
  risk: overrides.risk ?? "safe",
  blocked: overrides.blocked ?? false,
  message: overrides.message ?? "ok",
  data
});

const reviewVerification = (complete = true): RuntimeGateVerification => ({
  kind: "review",
  complete,
  summary: complete ? "Review coverage is complete." : "Review coverage is incomplete.",
  nextAction: complete ? "final review, not more reads" : "read server.js",
  progressMessage: complete ? "Review evidence is ready." : "Inspecting source files.",
  continuationMessage: complete ? "Produce final review." : "Read server.js.",
  metadata: {
    files: [
      {
        path: "server.js",
        totalLines: 159,
        readUntilLine: complete ? 159 : 80,
        complete,
        blocked: false
      }
    ]
  }
});

const ledgerText = (ledger: SessionStateLedger, verifications: RuntimeGateVerification[] = [reviewVerification()]): string =>
  ledger.buildMessage({ runtimeVerifications: verifications }).content;

describe("SessionStateLedger", () => {
  it("injects a current session state system message before provider calls", () => {
    const ledger = new SessionStateLedger({
      request: request(),
      messages: [],
      workspaceDir: "/repo"
    });
    const injected = injectSessionStateMessage(
      [
        { role: "system", content: "Long-term memory" },
        { role: "user", content: "review" }
      ],
      ledger.buildMessage({ runtimeVerifications: [reviewVerification()] })
    );

    expect(injected[1]?.role).toBe("system");
    expect(injected[1]?.content).toContain(SESSION_STATE_PREFIX);
    expect(injected[2]?.role).toBe("user");
  });

  it("states that a fully read file is complete and available on the next turn", () => {
    const ledger = new SessionStateLedger({
      request: request(),
      messages: [],
      workspaceDir: "/repo"
    });

    ledger.recordToolResult(
      toolCall("read_file", { path: "server.js", offset: 1, limit: 159 }),
      toolResult("read_file", {
        path: "server.js",
        offset: 1,
        returned_lines: 159,
        total_lines: 159,
        content: "const app = {};"
      })
    );

    const text = ledgerText(ledger);
    expect(text).toContain("server.js: read complete");
    expect(text).toContain("content available");
    expect(text).toContain("final review, not more reads");
  });

  it("turns duplicate read skips into an explicit do-not-reread instruction", () => {
    const ledger = new SessionStateLedger({
      request: request(),
      messages: [],
      workspaceDir: "/repo"
    });

    ledger.recordToolResult(
      toolCall("read_file", { path: "server.js", offset: 1, limit: 159 }),
      toolResult("read_file", {
        path: "server.js",
        duplicate_read: true,
        content_returned: false,
        previous_result_still_valid: true,
        allowed_next_actions: ["search", "edit", "final"]
      }, {
        message: "Repeated covered read skipped."
      })
    );

    const text = ledgerText(ledger);
    expect(text).toContain("server.js: already read; previous result valid");
    expect(text).toContain("Do not call read_file for server.js again unless it changed");
  });

  it("clears stale read coverage and requires changed-region inspection after edits", () => {
    const ledger = new SessionStateLedger({
      request: request(),
      messages: [],
      workspaceDir: "/repo"
    });

    ledger.recordToolResult(
      toolCall("read_file", { path: "server.js" }),
      toolResult("read_file", {
        path: "server.js",
        offset: 1,
        returned_lines: 159,
        total_lines: 159,
        content: "const app = {};"
      })
    );
    ledger.recordToolResult(
      toolCall("edit_file", { path: "server.js", replacement: "const app = fixed;" }),
      toolResult("edit_file", { path: "server.js" })
    );

    const text = ledgerText(ledger);
    expect(text).not.toContain("server.js: read complete, content available");
    expect(text).toContain("Dirty files: server.js");
    expect(text).toContain("Files requiring inspection: server.js");
    expect(text).toContain("Files requiring verification: server.js");
    expect(text).toContain("inspect changed file/range");
  });

  it("records repeated no-progress calls so the model changes query or finalizes", () => {
    const ledger = new SessionStateLedger({
      request: request(),
      messages: [],
      workspaceDir: "/repo"
    });

    ledger.recordToolResult(
      toolCall("grep", { pattern: "let unitIdCounter", path: "server.js" }),
      toolResult("grep", {
        pattern: "let unitIdCounter",
        count: 0,
        no_progress: true,
        input: { pattern: "let unitIdCounter", path: "server.js" }
      })
    );

    const text = ledgerText(ledger);
    expect(text).toContain("grep");
    expect(text).toContain("let unitIdCounter");
    expect(text).toContain("Do not repeat exact duplicate/no-progress");
  });

  it("adds a review-to-edit mode switch when the user asks to fix prior findings", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        sessionId: "session-1",
        role: "assistant",
        content: "Verdict: concerns. Scope reviewed: server.js. Findings by severity: high.",
        status: "complete",
        createdAt: new Date().toISOString(),
        metadata: {}
      },
      {
        id: "user-1",
        sessionId: "session-1",
        role: "user",
        content: "can u fix them",
        status: "complete",
        createdAt: new Date().toISOString(),
        metadata: {}
      }
    ];
    const ledger = new SessionStateLedger({
      request: request("can u fix them"),
      messages,
      workspaceDir: "/repo"
    });

    const text = ledgerText(ledger);
    expect(text).toContain("Mode switch:");
    expect(text).toContain("Do not restart review");
    expect(text).toContain("inspect changed regions, then run verification");
  });
});
