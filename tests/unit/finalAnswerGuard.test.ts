import { describe, expect, it } from "vitest";
import { getGatedFinalAnswerRepair } from "@agent/agentGraph";
import type { RuntimeGateVerification } from "@agent/runtimeGates";

const verification = (kind: RuntimeGateVerification["kind"]): RuntimeGateVerification => ({
  kind,
  complete: true,
  summary: "complete",
  nextAction: "produce final answer",
  progressMessage: "ready",
  continuationMessage: "continue",
  metadata: {}
});

describe("gated final answer guard", () => {
  it("rejects plan-only review responses after review evidence is complete", () => {
    const repair = getGatedFinalAnswerRepair(
      [verification("review")],
      "Plan: Search for 'eval' in server.js with 2 lines of context."
    );

    expect(repair?.kind).toBe("review");
    expect(repair?.reason).toContain("only a plan");
    expect(repair?.continuationMessage).toContain("final review report");
  });

  it("accepts structured final review reports", () => {
    const repair = getGatedFinalAnswerRepair(
      [verification("review")],
      [
        "Verdict: prototype, not production-ready.",
        "Scope reviewed: package.json, server.js, public/index.html.",
        "Verification: npm test was considered but no real test script exists.",
        "Findings: missing input validation and no automated tests.",
        "Fixes: validate socket payloads and add tests."
      ].join("\n")
    );

    expect(repair).toBeNull();
  });

  it("rejects plan-only goal responses after goal evidence is complete", () => {
    const repair = getGatedFinalAnswerRepair(
      [verification("goal")],
      "Next step: run the tests and then decide if anything else is needed."
    );

    expect(repair?.kind).toBe("goal");
    expect(repair?.continuationMessage).toContain("final completion report");
  });
});

  it("rejects final review reports that claim a blocked shell command succeeded", () => {
    const reviewVerification = verification("review");
    reviewVerification.metadata = {
      blockedShellIssues: [
        "Shell command `node server.js & sleep 2; pkill -f node` was blocked and did not run."
      ]
    };

    const repair = getGatedFinalAnswerRepair(
      [reviewVerification],
      [
        "Verdict: prototype, not production-ready.",
        "Scope reviewed: package.json, server.js, public/index.html.",
        "Verification: npm start was run - executed successfully with no runtime errors observed.",
        "Findings: resource depletion bug.",
        "Concrete fixes: decrement resource values."
      ].join("\n")
    );

    expect(repair?.kind).toBe("review");
    expect(repair?.reason).toContain("blocked shell-command evidence");
    expect(repair?.continuationMessage).toContain("did not run");
  });
