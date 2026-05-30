// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@ui/App";
import { defaultAppSettings } from "@shared/defaultSettings";
import type { SuperAgentApi } from "@shared/ipc";
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  LibraryData,
  ModelOption,
  ProviderName,
  WorkspaceActionLog,
} from "@shared/types";

const model: ModelOption = {
  provider: "stub",
  model: "deterministic-stub",
  label: "Deterministic test provider",
  supportsThinking: true,
};

const settings: AppSettings = {
  ...defaultAppSettings,
  defaultProvider: "stub",
  defaultModel: "deterministic-stub",
};

const createLibrary = (): LibraryData => ({
  plugins: {
    key: "plugins",
    title: "Plugins",
    status: "partial",
    description: "Local plugin metadata.",
    items: [],
  },
  skills: {
    key: "skills",
    title: "Skills",
    status: "complete",
    description: "Installed skills.",
    items: [
      {
        id: "browser-research",
        name: "Browser research",
        description: "Use browser workspace.",
        instructions: "Navigate and snapshot.",
        enabled: true,
        autoRouting: true,
        source: "built-in",
        trustLevel: "built-in",
        quarantineReason: null,
        scanFindings: [],
        dependencyMetadata: { requiredBins: [], requiredEnv: [], requiredFiles: [], packages: [], platforms: [], permissions: { allowNetwork: false, allowedEnv: [], writeRoots: [".", ".super-agent/skill-runs"], maxRuntimeMs: null } },
        files: [],
        version: null,
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        packageSize: 0,
      },
    ],
  },
  mcp: {
    key: "mcp",
    title: "MCP",
    status: "partial",
    description: "MCP registry surface.",
    items: [],
  },
  artifacts: {
    key: "artifacts",
    title: "Artifacts",
    status: "complete",
    description: "Persisted artifacts.",
    items: [],
  },
  tools: {
    key: "tools",
    title: "Tools",
    status: "complete",
    description: "Registered tools.",
    items: [
      {
        name: "browser.navigate",
        description: "Navigate browser.",
        category: "general",
        risk: "high",
        parameters: {},
      },
    ],
  },
  prompts: {
    key: "prompts",
    title: "Prompts",
    status: "complete",
    description: "Loaded prompts.",
    items: [{ id: "base", name: "Base prompt", status: "complete" }],
  },
  models: {
    key: "models",
    title: "Models",
    status: "complete",
    description: "Configured models.",
    items: [model],
  },
});

const createMessage = (
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"] = "complete",
  metadata: ChatMessage["metadata"] = {},
): ChatMessage => ({
  id: crypto.randomUUID(),
  sessionId,
  role,
  content,
  status,
  createdAt: new Date().toISOString(),
  metadata,
});

interface MockApiOptions {
  sessions?: ChatSession[];
  unavailableWorkspaceDirectories?: string[];
}

const createMockApi = (options: MockApiOptions = {}): SuperAgentApi => {
  const sessions: ChatSession[] = options.sessions ?? [];
  const unavailableWorkspaceDirectories = new Set(
    options.unavailableWorkspaceDirectories ?? [],
  );
  const messages: ChatMessage[] = [];
  const logs: WorkspaceActionLog[] = [];
  const library = createLibrary();
  let currentWorkspaceDirectory = "/tmp/super-agent-renderer-test";

  return {
    getBootstrapState: () =>
      Promise.resolve({
        sessions,
        models: [model],
        library,
        workspaceStatus: "idle",
        workspaceUrl: "about:blank",
        workspaceDirectory: currentWorkspaceDirectory,
        workspaceLogs: logs,
        workspaceSnapshot: null,
        settings,
        testProviderEnabled: false,
      }),

    listMessages: () => Promise.resolve(messages),

    searchSessions: () => Promise.resolve(sessions),

    renameSession: (sessionId, title) => {
      const session = sessions.find((item) => item.id === sessionId);

      if (!session) {
        throw new Error("Session not found.");
      }

      session.title = title;
      session.updatedAt = new Date().toISOString();

      return Promise.resolve(session);
    },

    deleteSession: (sessionId) => {
      const index = sessions.findIndex((item) => item.id === sessionId);

      if (index >= 0) {
        sessions.splice(index, 1);
      }

      return Promise.resolve({ deleted: true });
    },

    setSessionPinned: (sessionId, pinned) => {
      const session = sessions.find((item) => item.id === sessionId);

      if (!session) {
        throw new Error("Session not found.");
      }

      session.pinnedAt = pinned ? new Date().toISOString() : null;

      return Promise.resolve(session);
    },

    setSessionWorkspaceDirectory: (sessionId, workspaceDirectory) => {
      const session = sessions.find((item) => item.id === sessionId);

      if (!session) {
        throw new Error("Session not found.");
      }

      session.workspaceDirectory = workspaceDirectory;
      session.updatedAt = new Date().toISOString();

      return Promise.resolve(session);
    },

    submitChat: (request, handlers) => {
      const timestamp = new Date().toISOString();
      const session: ChatSession = {
        id: crypto.randomUUID(),
        title: request.prompt,
        createdAt: timestamp,
        updatedAt: timestamp,
        pinnedAt: null,
        workspaceDirectory: currentWorkspaceDirectory,
      };

      const user = createMessage(session.id, "user", request.prompt);
      const thinking = createMessage(session.id, "thinking", "", "streaming");
      const toolCall = createMessage(
        session.id,
        "tool",
        "Calling browser.navigate",
        "complete",
        {
          label: "Tool",
          call: {
            id: "browser-call-1",
            name: "browser.navigate",
            risk: "safe",
            input: { url: "about:blank" },
          },
        },
      );
      const toolResult = createMessage(
        session.id,
        "tool",
        "Workspace command completed.",
        "complete",
        {
          label: "Tool",
          result: {
            toolCallId: "browser-call-1",
            toolName: "browser.navigate",
            ok: true,
            risk: "safe",
            blocked: false,
            message: "Workspace command completed.",
            data: { url: "about:blank" },
          },
        },
      );
      const assistant = createMessage(session.id, "assistant", "", "streaming");

      sessions.unshift(session);
      messages.push(user, thinking, toolCall, toolResult, assistant);

      queueMicrotask(() => {
        handlers.onEvent({ type: "session_created", session });
        handlers.onEvent({ type: "message_created", message: user });
        handlers.onEvent({ type: "message_created", message: thinking });
        handlers.onEvent({
          type: "thinking_delta",
          messageId: thinking.id,
          delta: "Checking the request and preparing a safe workspace action.",
        });
        handlers.onEvent({ type: "message_created", message: toolCall });
        handlers.onEvent({ type: "message_created", message: toolResult });
        handlers.onEvent({ type: "message_created", message: assistant });
        handlers.onEvent({
          type: "assistant_delta",
          messageId: assistant.id,
          delta: `Stub response: ${request.prompt} `,
        });
        handlers.onEvent({
          type: "done",
          sessionId: session.id,
          assistantMessageId: assistant.id,
        });
      });

      return () => undefined;
    },

    regenerate: () => () => undefined,

    getLibrary: () => Promise.resolve(library),

    addMcpConnector: (request) => Promise.resolve({
      serverId: request.name.toLowerCase().replace(/\s+/g, "-"),
      configPath: "/tmp/config.yaml",
      toolCount: 1,
      tools: [{ name: "mock_tool", description: "Mock MCP tool" }],
      message: "Connected mock MCP connector."
    }),

    updateSkill: (skill) =>
      Promise.resolve({
        ...skill,
        autoRouting: skill.autoRouting ?? skill.enabled,
        source: "local" as const,
        trustLevel: "local" as const,
        quarantineReason: null,
        scanFindings: [],
        dependencyMetadata: { requiredBins: [], requiredEnv: [], requiredFiles: [], packages: [], platforms: [], permissions: { allowNetwork: false, allowedEnv: [], writeRoots: [".", ".super-agent/skill-runs"], maxRuntimeMs: null } },
        files: skill.files ?? [],
        version: skill.version ?? null,
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        packageSize: 0
      }),

    validateSkillImport: (skill) =>
      Promise.resolve({
        filename: skill.filename,
        packageSize: 0,
        valid: true,
        skill: {
          id: skill.filename.replace(/\.(skill|zip|md)$/i, "") || "uploaded-skill",
          name: skill.filename.replace(/\.(skill|zip|md)$/i, "") || "uploaded-skill",
          description: "Uploaded skill",
          version: null,
          fileCount: 1,
          packageSize: 0,
          trustLevel: "local" as const,
          scanFindings: []
        },
        existingSkillId: null,
        errors: [],
        warnings: [],
        files: [],
        dependencyMetadata: { requiredBins: [], requiredEnv: [], requiredFiles: [], packages: [], platforms: [], permissions: { allowNetwork: false, allowedEnv: [], writeRoots: [".", ".super-agent/skill-runs"], maxRuntimeMs: null } }
      }),

    importSkill: (skill) =>
      Promise.resolve({
        id: skill.filename.replace(/\.(skill|zip|md)$/i, "") || "uploaded-skill",
        name: skill.filename.replace(/\.(skill|zip|md)$/i, "") || "uploaded-skill",
        description: "Uploaded skill",
        instructions: "Uploaded skill instructions",
        enabled: true,
        autoRouting: false,
        source: "local" as const,
        trustLevel: "local" as const,
        quarantineReason: null,
        scanFindings: [],
        dependencyMetadata: { requiredBins: [], requiredEnv: [], requiredFiles: [], packages: [], platforms: [], permissions: { allowNetwork: false, allowedEnv: [], writeRoots: [".", ".super-agent/skill-runs"], maxRuntimeMs: null } },
        files: [],
        version: null,
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        packageSize: 0
      }),

    exportSkill: (skillId) => Promise.resolve({
      filename: `${skillId}.skill`,
      dataBase64: "",
      mimeType: "application/zip",
      manifest: {
        schemaVersion: 1,
        skillId,
        name: skillId,
        description: "Exported skill",
        version: null,
        source: "local",
        trustLevel: "local",
        packageHash: "hash",
        packageSize: 0,
        exportedAt: "2026-01-01T00:00:00.000Z",
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        fileCount: 1,
        dependencies: { requiredBins: [], requiredEnv: [], requiredFiles: [], packages: [], platforms: [], permissions: { allowNetwork: false, allowedEnv: [], writeRoots: [".", ".super-agent/skill-runs"], maxRuntimeMs: null } },
        scanFindings: []
      }
    }),

    deleteSkill: () => Promise.resolve(),

    createSkillProposal: (request) => Promise.resolve({
      id: "proposal-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      skillId: request.skillId ?? "proposal-skill",
      skillName: request.skillId ?? "proposal-skill",
      title: request.title,
      reason: request.reason,
      source: request.source ?? "tool",
      status: "pending",
      operation: request.operation ?? "update",
      proposedFiles: request.files,
      basePackageHash: null,
      targetPackageHash: "hash",
      diff: [],
      scanFindings: [],
      review: { passed: true, score: 100, summary: "passed", findings: [] },
      quarantineReason: null
    }),

    createSkillPatchProposal: (request) => Promise.resolve({
      id: "proposal-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      skillId: request.skillId,
      skillName: request.skillId,
      title: request.title,
      reason: request.reason,
      source: request.source ?? "tool",
      status: "pending",
      operation: "update",
      proposedFiles: [],
      basePackageHash: null,
      targetPackageHash: "hash",
      diff: [],
      scanFindings: [],
      review: { passed: true, score: 100, summary: "passed", findings: [] },
      quarantineReason: null
    }),

    listSkillProposals: () => Promise.resolve([]),
    applySkillProposal: () => Promise.reject(new Error("not implemented in mock")),
    rejectSkillProposal: (proposalId) => Promise.resolve({
      id: proposalId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      skillId: "mock",
      skillName: "mock",
      title: "mock",
      reason: "mock",
      source: "tool",
      status: "rejected",
      operation: "update",
      proposedFiles: [],
      basePackageHash: null,
      targetPackageHash: "hash",
      diff: [],
      scanFindings: [],
      review: { passed: true, score: 100, summary: "passed", findings: [] },
      quarantineReason: null
    }),
    listSkillSnapshots: () => Promise.resolve([]),
    restoreSkillSnapshot: () => Promise.reject(new Error("not implemented in mock")),

    runSkillEvals: (request) => Promise.resolve({
      id: "eval-1",
      skillId: request.skillId,
      skillName: request.skillId,
      packageHash: "hash",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      status: "warning",
      score: 65,
      total: 1,
      passed: 0,
      failed: 0,
      warnings: 1,
      baselineRunId: null,
      baselineScore: null,
      deltaScore: null,
      results: []
    }),

    listSkillEvalRuns: () => Promise.resolve([]),

    updateSkillLifecycle: () => Promise.reject(new Error("not implemented in mock")),

    installSkillFromGitHub: (request) => Promise.resolve({
      id: "github-skill",
      name: "github-skill",
      description: "GitHub skill",
      instructions: "GitHub skill instructions",
      enabled: true,
      autoRouting: true,
      source: "local" as const,
      trustLevel: "local" as const,
      quarantineReason: null,
      scanFindings: [],
      dependencyMetadata: { requiredBins: [], requiredEnv: [], requiredFiles: [], packages: [], platforms: [], permissions: { allowNetwork: false, allowedEnv: [], writeRoots: [".", ".super-agent/skill-runs"], maxRuntimeMs: null } },
      files: [],
      version: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      packageSize: 0,
      originUrl: request.url,
      verificationStatus: "unverified" as const
    }),

    searchSkillRegistry: () => Promise.resolve([]),

    installSkillFromRegistry: () => Promise.reject(new Error("not implemented in mock")),

    verifySkill: (skillId) => Promise.resolve({
      skillId,
      status: "verified" as const,
      packageHash: "hash",
      expectedHash: "hash",
      signatureValid: null,
      publisher: null,
      originUrl: null,
      findings: [],
      verifiedAt: "2026-01-01T00:00:00.000Z"
    }),

    verifyAllSkills: () => Promise.resolve([]),

    updateAllSkills: () => Promise.resolve({ checked: [], proposalsCreated: [] }),

    adaptSkillImport: () => Promise.resolve({ layout: "hermes" as const, packages: [], conflicts: [] }),

    getSkillCredentials: (skillId) => Promise.resolve({
      skillId,
      skillName: "Mock skill",
      storagePath: "test",
      encryptionAvailable: true,
      requiredEnv: [],
      requiredFiles: [],
      instructions: [],
    }),

    saveSkillCredentials: (request) => Promise.resolve({
      skillId: request.skillId,
      skillName: "Mock skill",
      storagePath: "test",
      encryptionAvailable: true,
      requiredEnv: [],
      requiredFiles: [],
      instructions: [],
    }),

    exportSkillAuditLog: () => Promise.resolve({
      schemaVersion: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      scope: { limit: 500 },
      events: [],
      firstHash: null,
      lastHash: null,
      exportHash: "hash",
    }),

    verifySkillAuditExport: (payload) => Promise.resolve({
      ok: true,
      eventCount: payload.events.length,
      firstHash: payload.firstHash,
      lastHash: payload.lastHash,
      exportHash: payload.exportHash,
      errors: [],
    }),

    getSettings: () => Promise.resolve(settings),

    saveSettings: (next) => Promise.resolve(next),

    validateProvider: (provider: ProviderName) =>
      Promise.resolve({
        provider,
        ok: true,
        message: `${provider} validated.`,
        models: [model],
      }),

    getProviderHealth: (provider: ProviderName) =>
      Promise.resolve({
        provider,
        status: "online",
        endpoint: "local",
        message: `${provider} is online.`,
        details: {},
      }),

    onProviderModelsUpdated: () => () => undefined,
  onLibraryUpdated: () => () => undefined,

    selectWorkspaceDirectory: () => {
      currentWorkspaceDirectory = "/tmp/super-agent-test-project";
      return Promise.resolve(currentWorkspaceDirectory);
    },

    setWorkspaceDirectory: (workspaceDirectory) => {
      if (unavailableWorkspaceDirectories.has(workspaceDirectory)) {
        return Promise.reject(
          new Error(
            `Workspace directory no longer exists: ${workspaceDirectory}`,
          ),
        );
      }

      currentWorkspaceDirectory = workspaceDirectory;
      return Promise.resolve(currentWorkspaceDirectory);
    },

    runWorkspaceCommand: (request) => {
      logs.unshift({
        id: crypto.randomUUID(),
        action: `browser.${request.command}`,
        status: "ok",
        detail: { command: request.command },
        createdAt: new Date().toISOString(),
      });

      return Promise.resolve({
        toolCallId: crypto.randomUUID(),
        toolName: `browser.${request.command}`,
        ok: true,
        blocked: false,
        risk: "safe",
        message: "Workspace command completed.",
        data: { url: "about:blank" },
      });
    },

    getWorkspaceLogs: () => Promise.resolve(logs),

    getWorkspaceStatus: () =>
      Promise.resolve({
        status: "idle",
        url: "about:blank",
        workspaceDirectory: currentWorkspaceDirectory,
      }),

    getWorkspaceSnapshot: () => Promise.resolve(null),

    approveToolCall: () => Promise.resolve({ approved: true }),
  };
};

describe("renderer E2E fallback", () => {
  beforeEach(() => {
    window.superAgent = createMockApi();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("streams chat, opens library, and controls workspace", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText("Ready when you are.")).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText("Model selector"),
      "stub:deterministic-stub",
    );

    await user.click(
      screen.getAllByRole("button", { name: /Project/i }).at(-1)!,
    );
    expect(
      await screen.findAllByTitle("super-agent-test-project"),
    ).toHaveLength(1);

    await user.type(
      screen.getByPlaceholderText("Message Super Agent"),
      "hello from e2e",
    );

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Ran 1 command")).toBeInTheDocument();

    await user.click(screen.getByText("Ran 1 command"));

    expect(
      await screen.findByText("Ran browser.navigate url=about:blank"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Stub response: hello from e2e/),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText("Show workspace"));
    await user.click(screen.getByText("Manual controls"));
    await user.clear(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "about:blank");
    await user.click(screen.getByRole("button", { name: "Navigate" }));

    await waitFor(() =>
      expect(screen.getAllByText("browser.navigate").length).toBeGreaterThan(0),
    );

    await user.click(screen.getByRole("button", { name: "Library" }));

    await waitFor(() =>
      expect(screen.getAllByText("Skills").length).toBeGreaterThan(0),
    );
  });

  it("keeps chat input usable when a saved session workspace was deleted", async () => {
    const user = userEvent.setup();
    const timestamp = new Date().toISOString();
    const staleWorkspace = "/run/media/spar/Data/Projects/BugWar";
    const session: ChatSession = {
      id: "stale-workspace-session",
      title: "Stale workspace chat",
      createdAt: timestamp,
      updatedAt: timestamp,
      pinnedAt: null,
      workspaceDirectory: staleWorkspace,
    };

    window.superAgent = createMockApi({
      sessions: [session],
      unavailableWorkspaceDirectories: [staleWorkspace],
    });

    render(<App />);

    const sessionButtons = await screen.findAllByRole("button", {
      name: /Stale workspace chat/,
    });
    const sessionButton = sessionButtons[0];

    expect(sessionButton).toBeDefined();
    await user.click(sessionButton as HTMLElement);

    const input = screen.getByPlaceholderText("Message Super Agent");
    await user.type(input, "input still works");

    expect(input).toHaveValue("input still works");
    await waitFor(() => expect(session.workspaceDirectory).toBeNull());
    expect(await screen.findByText("session.workspace.restore")).toBeInTheDocument();
  });
});
