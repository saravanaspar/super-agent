import { describe, expect, it } from "vitest";
import { routeAgentKind } from "@agent/intentRouter";
import type { ChatSubmitRequest, ModelOption } from "@shared/types";

const model: ModelOption = {
  provider: "stub",
  model: "stub-fast",
  label: "Stub",
  supportsThinking: true,
};

const request = (prompt: string, overrides: Partial<ChatSubmitRequest> = {}): ChatSubmitRequest => ({
  sessionId: null,
  prompt,
  model,
  permissionMode: "allow_safe_tools",
  attachments: [],
  ...overrides,
});

describe("intent router", () => {
  it("routes agent mode in the backend instead of relying on user UI selection", () => {
    expect(routeAgentKind(request("review this repository and run tests"))).toBe("coding");
    expect(routeAgentKind(request("can u fix them?"))).toBe("coding");
    expect(routeAgentKind(request("open localhost and inspect the page"))).toBe("browser");
    expect(routeAgentKind(request("answer this product question"))).toBe("general");
  });

  it("routes explicit review commands to coding mode", () => {
    expect(
      routeAgentKind(
        request("check implementation", {
          command: {
            name: "review",
            raw: "/review check implementation",
            input: "check implementation",
            goal: "check implementation",
            reviewTarget: "check implementation",
          },
        }),
      ),
    ).toBe("coding");
  });
});
