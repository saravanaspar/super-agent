// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "@ui/components/Sidebar";
import { ChatInput } from "@ui/components/ChatInput";
import { MessageList } from "@ui/components/MessageList";
import { WorkspacePanel } from "@ui/components/WorkspacePanel";
import { ApprovalDialog } from "@ui/components/ApprovalDialog";
import type { ChatMessage, ModelOption } from "@shared/types";

const model: ModelOption = {
  provider: "stub",
  model: "deterministic-stub",
  label: "Stub",
  supportsThinking: true,
};

const noop = () => undefined;

describe("ui components", () => {
  it("sidebar renders chat history and Library button", () => {
    render(
      <Sidebar
        collapsed={false}
        sessions={[
          {
            id: "s",
            title: "Saved chat",
            createdAt: "",
            updatedAt: "",
            pinnedAt: null,
          },
        ]}
        activeSessionId="s"
        searchOpen={false}
        searchQuery=""
        onToggleCollapse={noop}
        onNewChat={noop}
        onOpenLibrary={noop}
        onOpenSettings={noop}
        onToggleSearch={noop}
        onSearchChange={noop}
        onSelectSession={noop}
        onRenameSession={noop}
        onDeleteSession={noop}
        onTogglePinSession={noop}
      />,
    );

    expect(screen.getByText("Saved chat")).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("chat actions menu exposes rename, pin, and delete", async () => {
    const renameSession = vi.fn();
    const deleteSession = vi.fn();
    const togglePinSession = vi.fn();

    render(
      <Sidebar
        collapsed={false}
        sessions={[
          {
            id: "s",
            title: "Saved chat",
            createdAt: "",
            updatedAt: "",
            pinnedAt: null,
          },
        ]}
        activeSessionId="s"
        searchOpen={false}
        searchQuery=""
        onToggleCollapse={noop}
        onNewChat={noop}
        onOpenLibrary={noop}
        onOpenSettings={noop}
        onToggleSearch={noop}
        onSearchChange={noop}
        onSelectSession={noop}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        onTogglePinSession={togglePinSession}
      />,
    );

    await userEvent.click(screen.getByLabelText("Open actions for Saved chat"));

    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Pin chat")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Pin chat"));

    expect(togglePinSession).toHaveBeenCalledWith("s", true);
  });

  it("chat input renders selectors and correct send state", () => {
    const { rerender } = render(
      <ChatInput
        value=""
        models={[model]}
        selectedModel={model}
        permissionMode="allow_safe_tools"
        attachments={[]}
        streaming={false}
        workspaceLabel="No project selected"
        skills={[]}
        selectedSkillIds={[]}
        onValueChange={noop}
        onModelChange={noop}
        onPermissionChange={noop}
        onAttach={noop}
        onRemoveAttachment={noop}
        onSelectWorkspace={noop}
        onSelectedSkillIdsChange={noop}
        onSubmit={noop}
        onStop={noop}
      />,
    );

    expect(screen.getByLabelText("Model selector")).toBeInTheDocument();
    expect(screen.getByLabelText("Permission mode")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByText("No project selected")).toBeInTheDocument();
    expect(screen.getByText("Attach")).toBeInTheDocument();
    expect(screen.getAllByText("Project")).toHaveLength(1);
    expect(screen.getByText("Send")).toBeDisabled();

    rerender(
      <ChatInput
        value="hello"
        models={[model]}
        selectedModel={model}
        permissionMode="allow_safe_tools"
        attachments={[]}
        streaming={false}
        workspaceLabel="No project selected"
        skills={[]}
        selectedSkillIds={[]}
        onValueChange={noop}
        onModelChange={noop}
        onPermissionChange={noop}
        onAttach={noop}
        onRemoveAttachment={noop}
        onSelectWorkspace={noop}
        onSelectedSkillIdsChange={noop}
        onSubmit={noop}
        onStop={noop}
      />,
    );

    expect(screen.getByText("Send")).not.toBeDisabled();
  });

  it("shows the selected project in the composer input project control", () => {
    render(
      <ChatInput
        value=""
        models={[model]}
        selectedModel={model}
        permissionMode="allow_safe_tools"
        attachments={[]}
        streaming={false}
        workspaceLabel="BugWar"
        skills={[]}
        selectedSkillIds={[]}
        onValueChange={noop}
        onModelChange={noop}
        onPermissionChange={noop}
        onAttach={noop}
        onRemoveAttachment={noop}
        onSelectWorkspace={noop}
        onSelectedSkillIdsChange={noop}
        onSubmit={noop}
        onStop={noop}
      />,
    );

    expect(
      screen.getByLabelText("Selected project BugWar. Change project"),
    ).toBeInTheDocument();
    expect(screen.getByText("BugWar")).toBeInTheDocument();
    expect(screen.getAllByText("Project")).toHaveLength(1);
  });

  it("tool call and error states render visibly", async () => {
    const user = userEvent.setup();

    const messages: ChatMessage[] = [
      {
        id: "u",
        sessionId: "s",
        role: "user",
        content: "list files",
        status: "complete",
        createdAt: "",
        metadata: {},
      },
      {
        id: "t",
        sessionId: "s",
        role: "tool",
        content: "Calling ls",
        status: "complete",
        createdAt: "",
        metadata: {
          call: {
            id: "call-1",
            name: "ls",
            risk: "safe",
            input: { path: "." },
          },
        },
      },
      {
        id: "r",
        sessionId: "s",
        role: "tool",
        content: "Directory listed.",
        status: "complete",
        createdAt: "",
        metadata: {
          result: {
            toolCallId: "call-1",
            toolName: "ls",
            ok: true,
            risk: "safe",
            blocked: false,
            message: "Directory listed.",
            data: {
              entries: [
                { name: "artifacts", type: "dir" },
                { name: "package.json", type: "file" },
                { name: "src", type: "dir" },
              ],
            },
          },
        },
      },
      {
        id: "e",
        sessionId: "s",
        role: "error",
        content: "Provider failed",
        status: "failed",
        createdAt: "",
        metadata: {},
      },
      {
        id: "p",
        sessionId: "s",
        role: "pattern",
        content: "Are the steps to the solution known in advance?",
        status: "complete",
        createdAt: "",
        metadata: {},
      },
    ];

    render(
      <MessageList
        messages={messages}
        streaming={false}
        canRegenerate={false}
        onRegenerate={noop}
      />,
    );

    expect(screen.getByText("Ran 1 command")).toBeInTheDocument();

    await user.click(screen.getByText("Ran 1 command"));

    expect(screen.getByText("Ran ls .")).toBeInTheDocument();
    expect(screen.getByText("ls .")).toBeInTheDocument();
    expect(screen.getByText("Directory listed.")).toBeInTheDocument();
    expect(screen.getByText("Provider failed")).toBeInTheDocument();
    expect(
      screen.queryByText("Are the steps to the solution known in advance?"),
    ).not.toBeInTheDocument();
  });

  it("does not show a fake thinking section before any model reasoning arrives", () => {
    const messages: ChatMessage[] = [
      {
        id: "u-waiting",
        sessionId: "s",
        role: "user",
        content: "review",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      },
      {
        id: "a-waiting",
        sessionId: "s",
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: "2026-01-01T00:00:01.000Z",
        metadata: {},
      },
    ];

    render(
      <MessageList
        messages={messages}
        streaming={true}
        canRegenerate={false}
        onRegenerate={noop}
      />,
    );

    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for model output/i)).toBeInTheDocument();
  });

  it("renders raw thinking content when a model provides it", async () => {
    const user = userEvent.setup();
    const messages: ChatMessage[] = [
      {
        id: "u-thinking",
        sessionId: "s",
        role: "user",
        content: "review",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      },
      {
        id: "t-thinking",
        sessionId: "s",
        role: "thinking",
        content: "raw model reasoning should be visible",
        status: "complete",
        createdAt: "2026-01-01T00:00:01.000Z",
        metadata: { visibility: "user" },
      },
      {
        id: "a-thinking",
        sessionId: "s",
        role: "assistant",
        content: "Final answer",
        status: "complete",
        createdAt: "2026-01-01T00:00:02.000Z",
        metadata: {},
      },
    ];

    render(
      <MessageList
        messages={messages}
        streaming={false}
        canRegenerate={false}
        onRegenerate={noop}
      />,
    );

    expect(screen.getByText("Final answer")).toBeInTheDocument();
    const thinkingButton = screen.getByRole("button", { name: /thinking/i });
    expect(thinkingButton).toBeInTheDocument();
    expect(
      screen.queryByText("raw model reasoning should be visible"),
    ).not.toBeInTheDocument();

    await user.click(thinkingButton);

    expect(
      screen.getByText("raw model reasoning should be visible"),
    ).toBeInTheDocument();
  });

  it("keeps tool details open while a run is active until final response", async () => {
    const user = userEvent.setup();
    const baseMessages: ChatMessage[] = [
      {
        id: "u-tools",
        sessionId: "s",
        role: "user",
        content: "review",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      },
      {
        id: "tool-call-1",
        sessionId: "s",
        role: "tool",
        content: "Calling ls",
        status: "complete",
        createdAt: "2026-01-01T00:00:01.000Z",
        metadata: {
          call: {
            id: "call-1",
            name: "ls",
            risk: "safe",
            input: { path: "." },
          },
        },
      },
      {
        id: "tool-result-1",
        sessionId: "s",
        role: "tool",
        content: "Directory listed.",
        status: "complete",
        createdAt: "2026-01-01T00:00:02.000Z",
        metadata: {
          result: {
            toolCallId: "call-1",
            toolName: "ls",
            ok: true,
            risk: "safe",
            blocked: false,
            message: "Directory listed.",
            data: { entries: [] },
          },
        },
      },
    ];

    const { rerender } = render(
      <MessageList
        messages={baseMessages}
        streaming={true}
        canRegenerate={false}
        onRegenerate={noop}
      />,
    );

    await user.click(screen.getByText("Running 1 command"));
    expect(screen.getByText("Directory listed.")).toBeInTheDocument();

    const nextMessages: ChatMessage[] = [
      ...baseMessages,
      {
        id: "tool-call-2",
        sessionId: "s",
        role: "tool",
        content: "Calling read_file",
        status: "complete",
        createdAt: "2026-01-01T00:00:03.000Z",
        metadata: {
          call: {
            id: "call-2",
            name: "read_file",
            risk: "safe",
            input: { path: "package.json" },
          },
        },
      },
      {
        id: "tool-result-2",
        sessionId: "s",
        role: "tool",
        content: "File read completed.",
        status: "complete",
        createdAt: "2026-01-01T00:00:04.000Z",
        metadata: {
          result: {
            toolCallId: "call-2",
            toolName: "read_file",
            ok: true,
            risk: "safe",
            blocked: false,
            message: "File read completed.",
            data: { path: "package.json" },
          },
        },
      },
    ];

    rerender(
      <MessageList
        messages={nextMessages}
        streaming={true}
        canRegenerate={false}
        onRegenerate={noop}
      />,
    );

    expect(screen.getByText("Running 2 commands")).toBeInTheDocument();
    expect(screen.getByText("Directory listed.")).toBeInTheDocument();
    expect(screen.getByText("File read completed.")).toBeInTheDocument();

    rerender(
      <MessageList
        messages={[
          ...nextMessages,
          {
            id: "assistant-final",
            sessionId: "s",
            role: "assistant",
            content: "Final answer",
            status: "complete",
            createdAt: "2026-01-01T00:00:05.000Z",
            metadata: {},
          },
        ]}
        streaming={false}
        canRegenerate={false}
        onRegenerate={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Directory listed.")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Final answer")).toBeInTheDocument();
  });

  it("renders markdown tables as real tables, including collapsed model tables", () => {
    const messages: ChatMessage[] = [
      {
        id: "u-table",
        sessionId: "s",
        role: "user",
        content: "review",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      },
      {
        id: "a-table",
        sessionId: "s",
        role: "assistant",
        content:
          "Findings by severity\n\n| Severity | Issue | Location | Impact | |----------|-------|----------|--------| | High | Placeholder test script | package.json | Breaks CI | | Medium | Caret ranges | package.json | Version drift |",
        status: "complete",
        createdAt: "2026-01-01T00:00:01.000Z",
        metadata: {},
      },
    ];

    render(
      <MessageList
        messages={messages}
        streaming={false}
        canRegenerate={false}
        onRegenerate={noop}
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Severity" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "Placeholder test script" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\| Severity \| Issue/)).not.toBeInTheDocument();
  });

  it("shows a clear fallback for an empty completed assistant message", () => {
    const messages: ChatMessage[] = [
      {
        id: "u-empty",
        sessionId: "s",
        role: "user",
        content: "review",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      },
      {
        id: "a-empty",
        sessionId: "s",
        role: "assistant",
        content: "",
        status: "complete",
        createdAt: "2026-01-01T00:00:01.000Z",
        metadata: {},
      },
    ];

    render(
      <MessageList
        messages={messages}
        streaming={false}
        canRegenerate={false}
        onRegenerate={noop}
      />,
    );

    expect(
      screen.getByText(/No final response was provided/i),
    ).toBeInTheDocument();
  });

  it("workspace panel can close", async () => {
    const onClose = vi.fn();

    render(
      <WorkspacePanel
        open={true}
        status="idle"
        url="about:blank"
        snapshot={null}
        logs={[]}
        permissionMode="allow_safe_tools"
        onClose={onClose}
        onRun={() =>
          Promise.resolve({
            toolCallId: "1",
            toolName: "workspace.status",
            ok: true,
            risk: "safe",
            blocked: false,
            message: "ok",
            data: null,
          })
        }
        onRefreshLogs={() => Promise.resolve()}
      />,
    );

    await userEvent.click(screen.getByLabelText("Close workspace"));

    expect(onClose).toHaveBeenCalled();
  });
});
describe("approval dialog", () => {
  it("offers session approval scopes", async () => {
    const onRespond = vi.fn();
    render(
      <ApprovalDialog
        call={{ id: "call", name: "bash", risk: "high", input: { command: "npm test" } }}
        reason="Approval required"
        onRespond={onRespond}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));

    expect(onRespond).toHaveBeenCalledWith(true, "once");

    await userEvent.click(
      screen.getByRole("button", { name: "Allow always in this session" })
    );
    expect(onRespond).toHaveBeenCalledWith(true, "session_tool");

    await userEvent.click(
      screen.getByRole("button", { name: "Allow exact command in this session" })
    );
    expect(onRespond).toHaveBeenCalledWith(true, "session_exact_command");
  });
});
