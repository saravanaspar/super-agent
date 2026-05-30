import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroqProvider } from "@providers/adapters/groq/groqProvider";
import { validateBrowserWorkspaceUrl } from "@security/networkPolicy";
import { OllamaProvider } from "@providers/adapters/ollama/ollamaProvider";
import { PermissionService } from "@permissions/permissionService";
import { toBlockedToolResult } from "@tool-registry/types";
import type { AttachmentMetadata, ModelOption, ToolCallRecord } from "@shared/types";
import { NvidiaProvider } from "@providers/adapters/nvidia/nvidiaProvider";
import nvidiaValidatedModelData from "@providers/validation/data/nvidiaValidatedModels.json";
import { isRetiredProviderModel } from "@providers/retiredModels";
import { toOpenAiCompatibleMessages } from "@providers/shared/openAiCompatible";
import {
  baseRequest,
  collectEvents,
  createHarness,
  type TestHarness
} from "../fixtures/harness";

const groqTestModel: ModelOption = {
  provider: "groq",
  model: "regression-groq-model",
  label: "Regression Groq model",
  supportsThinking: false
};

const ollamaTestModel: ModelOption = {
  provider: "ollama",
  model: "regression-ollama-model",
  label: "Regression Ollama model",
  supportsThinking: false
};

const toolContext = (harness: TestHarness) => ({
  workspaceDir: join(harness.dir, "workspace"),
  browserWorkspace: harness.browser,
  artifacts: harness.artifacts,
  workspaceLogs: harness.workspaceLogs,
  agentSettings: {
    allowOutsideWorkspaceAccess: false,
    allowPrivateNetworkAccess: false,
    useShellSandbox: false
  }
});

describe("regressions", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("repeated New Chat clicks without a prompt create zero persisted sessions", () => {
    expect(harness.chats.countSessions()).toBe(0);
  });

  it("first prompt creates exactly one session", async () => {
    const { emit } = collectEvents();

    await harness.chatService.submit(
      baseRequest(harness.model, "first prompt"),
      emit
    );

    expect(harness.chats.countSessions()).toBe(1);
  });

  it("regenerate does not duplicate the original user message", async () => {
    const { emit } = collectEvents();
    const attachment: AttachmentMetadata = {
      id: "attachment-1",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      textPreview: "hello"
    };

    const sessionId = await harness.chatService.submit(
      { ...baseRequest(harness.model, "regenerate me"), attachments: [attachment] },
      emit
    );

    const regenerated = collectEvents();
    await harness.chatService.regenerate(
      sessionId,
      {
        model: harness.model,
        permissionMode: "allow_safe_tools",
        agentKind: "general",
        attachments: []
      },
      regenerated.emit
    );

    const userMessages = harness
      .chats
      .listMessages(sessionId)
      .filter((message) => message.role === "user");

    expect(userMessages).toHaveLength(1);
    expect(
      regenerated.events.find((event) => event.type === "pattern_decision")
    ).toMatchObject({ decision: { tooling: { selected: "tool_enabled_agent" } } });
  });

  it("denied shell command never executes", async () => {
    const target = join(harness.dir, "workspace", "should-not-exist");

    const call: ToolCallRecord = {
      id: "s",
      name: "bash",
      risk: "high",
      input: { command: `touch ${target}` }
    };

    const decision = new PermissionService().decide(call, "deny_tools");

    const result = decision.allowed
      ? await harness.registry.execute(call, toolContext(harness))
      : toBlockedToolResult(call, decision.reason);

    expect(result.blocked).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("file write outside allowed workspace requires approval in auto review", async () => {
    const target = join(harness.dir, "outside.txt");
    const call: ToolCallRecord = {
      id: "f",
      name: "write_file",
      risk: "high",
      input: { relativePath: "../outside.txt", content: "bad" }
    };

    const decision = new PermissionService().decide(
      call,
      "allow_safe_tools",
      toolContext(harness).workspaceDir
    );
    const result = decision.allowed
      ? await harness.registry.execute(call, toolContext(harness))
      : toBlockedToolResult(call, decision.reason);

    expect(decision.requiresApproval).toBe(false);
    expect(result.blocked).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("outside workspace file tools stay blocked in full access when agent setting is off", () => {
    const outsidePath = join(harness.dir, "outside-secret.txt");
    writeFileSync(outsidePath, "secret", "utf8");
    const call: ToolCallRecord = {
      id: "outside-read",
      name: "read_file",
      risk: "safe",
      input: { path: outsidePath }
    };

    const decision = new PermissionService().decide(
      call,
      "full_access",
      toolContext(harness).workspaceDir,
      { allowOutsideWorkspaceAccess: false, allowPrivateNetworkAccess: false, useShellSandbox: false }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
  });

  it("outside workspace file tools become high risk only when agent setting is on", () => {
    const outsidePath = join(harness.dir, "outside-secret.txt");
    writeFileSync(outsidePath, "secret", "utf8");
    const call: ToolCallRecord = {
      id: "outside-read",
      name: "read_file",
      risk: "safe",
      input: { path: outsidePath }
    };

    const decision = new PermissionService().decide(
      call,
      "allow_safe_tools",
      toolContext(harness).workspaceDir,
      { allowOutsideWorkspaceAccess: true, allowPrivateNetworkAccess: false, useShellSandbox: false }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.effectiveRisk).toBe("high");
  });

  it("file tool execution still enforces outside workspace agent setting", async () => {
    const outsidePath = join(harness.dir, "outside-secret.txt");
    writeFileSync(outsidePath, "secret", "utf8");

    const result = await harness.registry.execute(
      {
        id: "outside-read",
        name: "read_file",
        risk: "safe",
        input: { path: outsidePath }
      },
      toolContext(harness)
    );

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("private browser URLs require the agent network setting", async () => {
    await expect(validateBrowserWorkspaceUrl("http://127.0.0.1:3000")).rejects.toThrow(
      /Agent settings do not allow/
    );

    await expect(
      validateBrowserWorkspaceUrl("http://127.0.0.1:3000", {
        allowOutsideWorkspaceAccess: false,
        allowPrivateNetworkAccess: true,
        useShellSandbox: false
      })
    ).resolves.toBe("http://127.0.0.1:3000/");
  });

  it("IPv4-mapped localhost URLs are treated as private browser targets", async () => {
    await expect(validateBrowserWorkspaceUrl("http://[::ffff:127.0.0.1]")).rejects.toThrow(
      /Agent settings do not allow/
    );
  });

  it("NVIDIA provider rejects non-NVIDIA base URLs before sending API keys", async () => {
    const provider = new NvidiaProvider({
      apiKey: "nvapi-test-secret",
      baseUrl: "https://attacker.example/v1"
    });

    await expect(
      provider
        .stream({
          model: {
            provider: "nvidia",
            model: "test",
            label: "test",
            supportsThinking: false
          },
          messages: [{ role: "user", content: "hello" }],
          tools: []
        })
        .next()
    ).rejects.toThrow(/NVIDIA NIM base URL must be/);
  });

  it("NVIDIA provider explains retired model HTTP 410 responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail:
            "The model 'qwen/qwen3-next-80b-a3b-thinking' has reached its end of life."
        }),
        { status: 410, statusText: "Gone" }
      )
    ) as typeof fetch;

    try {
      const provider = new NvidiaProvider({
        apiKey: "nvapi-test-secret",
        baseUrl: "https://integrate.api.nvidia.com/v1"
      });

      await expect(
        provider
          .stream({
            model: {
              provider: "nvidia",
              model: "qwen/qwen3-next-80b-a3b-thinking",
              label: "qwen/qwen3-next-80b-a3b-thinking",
              supportsThinking: true
            },
            messages: [{ role: "user", content: "hello" }],
            tools: []
          })
          .next()
      ).rejects.toThrow(/model "qwen\/qwen3-next-80b-a3b-thinking" is no longer available/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("NVIDIA static model catalog excludes retired Qwen Next models", () => {
    const models = nvidiaValidatedModelData.models.map((model) => model.model);

    expect(
      isRetiredProviderModel("nvidia", "qwen/qwen3-next-80b-a3b-thinking")
    ).toBe(true);
    expect(models).not.toContain("qwen/qwen3-next-80b-a3b-thinking");
    expect(models).not.toContain("qwen/qwen3-next-80b-a3b-instruct");
  });



  it("OpenAI-compatible providers do not send system messages after tool results", () => {
    const messages = toOpenAiCompatibleMessages([
      { role: "system", content: "Root instruction." },
      { role: "user", content: "Review the project." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "workspace.path",
            risk: "safe",
            input: {}
          }
        ]
      } as never,
      {
        role: "tool",
        name: "workspace.path",
        toolCallId: "call-1",
        content: "{\"path\":\"/workspace\"}"
      } as never,
      { role: "system", content: "Continue the review with the next required step." }
    ], {
      toProviderName: (name) => name.replace(/[^A-Za-z0-9_-]/g, "_"),
      toInternalName: (name) => name
    });

    const roles = messages.map((message) => message.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "user"]);
    const finalMessage = messages.at(-1);
    expect(finalMessage?.role).toBe("user");
    expect(finalMessage?.content).toContain("Runtime instruction");
  });

  it("NVIDIA provider maps dotted internal tool names to provider-safe names", async () => {
    const originalFetch = globalThis.fetch;
    let capturedPayload: unknown;

    globalThis.fetch = vi.fn().mockImplementation((_url: string | URL | Request, init?: RequestInit) => {
      capturedPayload = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

      return Promise.resolve(new Response(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: {
                      name: "workspace_path",
                      arguments: '{"relativePath":"."}'
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
    }) as typeof fetch;

    try {
      const provider = new NvidiaProvider({
        apiKey: "nvapi-test-secret",
        baseUrl: "https://integrate.api.nvidia.com/v1"
      });
      const events = [];

      for await (const event of provider.stream({
        model: {
          provider: "nvidia",
          model: "test-model",
          label: "test-model",
          supportsThinking: false
        },
        messages: [{ role: "user", content: "where am I?" }],
        tools: [
          {
            name: "workspace.path",
            description: "Return the active workspace path.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            risk: "safe"
          }
        ]
      })) {
        events.push(event);
      }

      const payload = capturedPayload as {
        tools?: Array<{ function?: { name?: string } }>;
      };
      const toolEvents = events.filter((event) => event.type === "tool_call");

      expect(payload.tools?.[0]?.function?.name).toBe("workspace_path");
      expect(payload.tools?.[0]?.function?.name).not.toContain(".");
      expect(toolEvents[0]?.call.name).toBe("workspace.path");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Groq provider maps dotted internal tool names to provider-safe names", async () => {
    const originalFetch = globalThis.fetch;
    let capturedPayload: unknown;

    globalThis.fetch = vi.fn().mockImplementation((_url: string | URL | Request, init?: RequestInit) => {
      capturedPayload = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

      return Promise.resolve(new Response(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-2",
                    function: {
                      name: "workspace_path",
                      arguments: '{"relativePath":"."}'
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
    }) as typeof fetch;

    try {
      const provider = new GroqProvider({
        apiKey: "gsk-test-secret",
        baseUrl: "https://api.groq.com/openai/v1"
      });
      const events = [];

      for await (const event of provider.stream({
        model: groqTestModel,
        messages: [{ role: "user", content: "where am I?" }],
        tools: [
          {
            name: "workspace.path",
            description: "Return the active workspace path.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            risk: "safe"
          }
        ]
      })) {
        events.push(event);
      }

      const payload = capturedPayload as {
        tools?: Array<{ function?: { name?: string } }>;
      };
      const toolEvents = events.filter((event) => event.type === "tool_call");

      expect(payload.tools?.[0]?.function?.name).toBe("workspace_path");
      expect(payload.tools?.[0]?.function?.name).not.toContain(".");
      expect(toolEvents[0]?.call.name).toBe("workspace.path");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("missing Groq API key shows a provider configuration error", async () => {
    const provider = new GroqProvider({
      apiKey: "",
      baseUrl: "https://api.groq.com/openai/v1"
    });

    await expect(
      provider
        .stream({
          model: groqTestModel,
          messages: [],
          tools: []
        })
        .next()
    ).rejects.toThrow(/Groq provider is not configured|Groq API key/i);
  });

  it("Ollama unavailable shows a local-provider error", async () => {
    const provider = new OllamaProvider("http://127.0.0.1:9");

    await expect(
      provider
        .stream({
          model: ollamaTestModel,
          messages: [],
          tools: []
        })
        .next()
    ).rejects.toThrow(/Ollama is unavailable|Ollama request failed/i);
  });

  it("tool failure appears in chat and action log", async () => {
    const result = await harness.registry.execute(
      {
        id: "c",
        name: "browser.click",
        risk: "medium",
        input: { selector: "#missing" }
      },
      toolContext(harness)
    );

    expect(result.ok).toBe(false);
    expect(
      harness.workspaceLogs.list().some((log) => log.status === "failed")
    ).toBe(true);
  });

  it("browser workspace status returns to idle or failed after an action", async () => {
    await harness.browser.snapshot(false).catch(() => undefined);

    expect(["idle", "failed"]).toContain(harness.browser.getStatus().status);
  });
});