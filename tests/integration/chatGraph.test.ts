import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseRequest, collectEvents, createHarness, type TestHarness } from "../fixtures/harness";

describe("chat and graph integration", () => {
  let harness: TestHarness;

  beforeEach(async () => { harness = await createHarness(); });
  afterEach(async () => { await harness.close(); });

  it("chat submission creates a session and persists messages", async () => {
    const { events, emit } = collectEvents();
    const sessionId = await harness.chatService.submit(baseRequest(harness.model, "hello"), emit);
    expect(harness.chats.countSessions()).toBe(1);
    expect(harness.chats.listMessages(sessionId).filter((message) => message.role === "user")).toHaveLength(1);
    expect(events.some((event) => event.type === "assistant_delta")).toBe(true);
    expect(events.some((event) => event.type === "pattern_decision")).toBe(true);
  });

  it("agent graph streams tool events through permission gate", async () => {
    const { events, emit } = collectEvents();
    await harness.chatService.submit(baseRequest(harness.model, "[tool:workspace.status]"), emit);
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
  });

  it("buffers assistant deltas when response streaming is disabled", async () => {
    const { events, emit } = collectEvents();
    await harness.chatService.submit(
      {
        ...baseRequest(harness.model, "hello world"),
        responseStreamingEnabled: false
      },
      emit
    );

    const assistantDeltas = events.filter((event) => event.type === "assistant_delta");
    expect(assistantDeltas).toHaveLength(1);
    expect(assistantDeltas[0]).toMatchObject({ delta: "Stub response: hello world " });
  });


  it("does not emit final assistant text before tool work completes", async () => {
    const { events, emit } = collectEvents();

    await harness.chatService.submit(
      baseRequest(harness.model, "[tool:workspace.status]"),
      emit
    );

    const firstAssistantDelta = events.findIndex(
      (event) => event.type === "assistant_delta"
    );
    const firstToolResult = events.findIndex(
      (event) => event.type === "tool_result"
    );

    expect(firstToolResult).toBeGreaterThanOrEqual(0);
    expect(firstAssistantDelta).toBeGreaterThan(firstToolResult);
  });

  it("browser tool returns a structured result", async () => {
    const result = await harness.registry.execute(
      { id: "b", name: "browser.snapshot", risk: "safe", input: { includeScreenshot: false } },
      {
        workspaceDir: harness.dir,
        browserWorkspace: harness.browser,
        artifacts: harness.artifacts,
        workspaceLogs: harness.workspaceLogs,
        agentSettings: {
          allowOutsideWorkspaceAccess: false,
          allowPrivateNetworkAccess: false,
          useShellSandbox: false
        }
      }
    );
    expect(result.ok).toBe(true);
    expect(typeof result.data === "object" && result.data !== null && "url" in result.data).toBe(true);
  });

  it("artifact creation persists a real artifact record", async () => {
    const { emit } = collectEvents();
    await harness.chatService.submit(baseRequest(harness.model, "[artifact]"), emit);
    expect(harness.artifacts.listArtifacts()).toHaveLength(1);
  });
});
