import { describe, expect, it } from "vitest";
import { buildRuntimeGates } from "../../src/agent/runtimeGates";
import type { RoutedChatSubmitRequest } from "@shared/types";

const request = (commandName: "review" | "goal" | null): RoutedChatSubmitRequest => ({
  sessionId: null,
  prompt: "review and understand codebase",
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
  command: commandName
    ? {
        name: commandName,
        raw: `/${commandName} review and understand codebase`,
        input: "review and understand codebase",
        goal: "review and understand codebase",
        reviewTarget: "review and understand codebase"
      }
    : null
});

describe("runtime gates", () => {
  it("does not add the generic evidence gate for explicit /review because review has its own read coverage gate", () => {
    const gates = buildRuntimeGates({
      request: request("review"),
      messages: [],
      workspaceDir: "/repo"
    });

    expect(gates.map((gate) => gate.kind)).toEqual(["review"]);
  });
});
