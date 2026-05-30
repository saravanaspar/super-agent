import { describe, expect, it } from "vitest";
import { chooseAgenticPatterns, formatPatternDecision } from "@agent/patterns/agenticPatternFramework";
import type { ChatSubmitRequest, ModelOption } from "@shared/types";

const model: ModelOption = { provider: "stub", model: "stub-fast", label: "Stub", supportsThinking: true };

const request = (prompt: string, overrides: Partial<ChatSubmitRequest> = {}): ChatSubmitRequest => ({
  sessionId: null,
  prompt,
  model,
  permissionMode: "allow_safe_tools",
  agentKind: "general",
  attachments: [],
  ...overrides
});

describe("agentic pattern decision framework", () => {
  it("applies the exact decision-tree branches for a coding task", () => {
    const decision = chooseAgenticPatterns(request("Implement the exact framework with tests", { agentKind: "coding" }), []);
    expect(decision.path.selected).toBe("known_path");
    expect(decision.flow.selected).toBe("sequential_workflow");
    expect(decision.tooling.selected).toBe("tool_enabled_agent");
    expect(decision.execution.selected).toBe("planning_pattern");
    expect(decision.priority.selected).toBe("quality_first_pattern");
    expect(decision.agents.selected).toBe("single_agent_pattern");
  });

  it("uses adaptive ReAct behavior for browser exploration", () => {
    const decision = chooseAgenticPatterns(request("Browse this site and explore what changed", { agentKind: "browser" }), []);
    expect(decision.path.selected).toBe("unknown_path");
    expect(decision.flow.selected).toBe("parallel_dynamic_flow");
    expect(decision.tooling.selected).toBe("tool_enabled_agent");
    expect(decision.execution.selected).toBe("react_pattern");
  });

  it("formats the framework decision visibly", () => {
    const decision = chooseAgenticPatterns(request("Quick draft answer"), []);
    const formatted = formatPatternDecision(decision);
    expect(formatted).toContain("Are the steps to the solution known in advance?");
    expect(formatted).toContain("Would multiple agents work together better than one?");
    expect(formatted).toContain("Single-Agent Pattern");
  });
});
