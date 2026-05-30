import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "@shared/types";
import { PermissionService } from "@permissions/permissionService";

const workspaceDir = "/tmp/super-agent-workspace";

const statusCall: ToolCallRecord = {
  id: "status",
  name: "workspace.status",
  risk: "safe",
  input: {}
};

const safeShellCall: ToolCallRecord = {
  id: "shell-safe",
  name: "bash",
  risk: "high",
  input: { command: "npm test", cwd: "." }
};

const packageInstallCall: ToolCallRecord = {
  id: "shell-install",
  name: "bash",
  risk: "high",
  input: { command: "npm install", cwd: "." }
};

const sudoShellCall: ToolCallRecord = {
  id: "sudo",
  name: "bash",
  risk: "high",
  input: { command: "sudo npm install", cwd: "." }
};

const destructiveShellCall: ToolCallRecord = {
  id: "destroy",
  name: "bash",
  risk: "high",
  input: { command: "rm -rf /" }
};

const protectedPathWriteCall: ToolCallRecord = {
  id: "write",
  name: "write_file",
  risk: "high",
  input: { path: "/root/owned", content: "bad" }
};

const workspaceWriteCall: ToolCallRecord = {
  id: "workspace-write",
  name: "write_file",
  risk: "high",
  input: { path: "src/example.ts", content: "ok" }
};

const outsideWriteCall: ToolCallRecord = {
  id: "outside-write",
  name: "write_file",
  risk: "high",
  input: { path: "/tmp/outside.txt", content: "ok" }
};

const safeBrowserNavigateCall: ToolCallRecord = {
  id: "browser-navigate-about",
  name: "browser.navigate",
  risk: "high",
  input: { url: "about:blank" }
};

const externalBrowserNavigateCall: ToolCallRecord = {
  id: "browser-navigate-external",
  name: "browser.navigate",
  risk: "high",
  input: { url: "https://example.com" }
};


const mcpStatusCall: ToolCallRecord = {
  id: "mcp-status",
  name: "mcp.status",
  risk: "safe",
  input: {}
};

const mcpCallToolCall: ToolCallRecord = {
  id: "mcp-call",
  name: "mcp.call_tool",
  risk: "high",
  input: { serverId: "github", toolName: "list_issues", arguments: {} }
};

describe("permission gate decisions", () => {
  it("allows safe tools in auto review mode", () => {
    const decision = new PermissionService().decide(
      statusCall,
      "allow_safe_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("blocks all tools in deny mode", () => {
    const decision = new PermissionService().decide(
      statusCall,
      "deny_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
  });

  it("allows harmless shell test commands in auto review mode", () => {
    const decision = new PermissionService().decide(
      safeShellCall,
      "allow_safe_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("requires approval for dependency installs in auto review mode", () => {
    const decision = new PermissionService().decide(
      packageInstallCall,
      "allow_safe_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });

  it("requires approval for writes outside the workspace when agent setting is on", () => {
    const decision = new PermissionService().decide(
      outsideWriteCall,
      "allow_safe_tools",
      workspaceDir,
      { allowOutsideWorkspaceAccess: true, allowPrivateNetworkAccess: false, useShellSandbox: false }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });

  it("requires approval for every tool in ask every time mode", () => {
    const decision = new PermissionService().decide(
      statusCall,
      "ask_every_time",
      workspaceDir
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });

  it("allows non-destructive tools in full access mode", () => {
    const decision = new PermissionService().decide(
      statusCall,
      "full_access",
      workspaceDir
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("keeps manual approval separate from full access", () => {
    const permissions = new PermissionService();
    const safeDecision = permissions.decide(
      statusCall,
      "manual_approval",
      workspaceDir
    );
    const riskyDecision = permissions.decide(
      packageInstallCall,
      "manual_approval",
      workspaceDir
    );

    expect(safeDecision.allowed).toBe(true);
    expect(safeDecision.requiresApproval).toBe(false);
    expect(riskyDecision.allowed).toBe(false);
    expect(riskyDecision.requiresApproval).toBe(true);
  });

  it("blocks sudo in full access mode", () => {
    const decision = new PermissionService().decide(
      sudoShellCall,
      "full_access",
      workspaceDir
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.reason).toContain("sudo");
  });

  it("requires approval for dependency installs during explicit goal or review commands", () => {
    const permissions = new PermissionService();

    const goalDecision = permissions.decide(
      packageInstallCall,
      "allow_safe_tools",
      workspaceDir,
      undefined,
      "goal"
    );
    const reviewDecision = permissions.decide(
      { ...packageInstallCall, id: "shell-install-review" },
      "allow_safe_tools",
      workspaceDir,
      undefined,
      "review"
    );

    expect(goalDecision.allowed).toBe(false);
    expect(goalDecision.requiresApproval).toBe(true);
    expect(reviewDecision.allowed).toBe(false);
    expect(reviewDecision.requiresApproval).toBe(true);
  });

  it("allows dependency installs in full access mode", () => {
    const decision = new PermissionService().decide(
      packageInstallCall,
      "full_access",
      workspaceDir
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("still blocks sudo during explicit goal or review commands", () => {
    const decision = new PermissionService().decide(
      sudoShellCall,
      "allow_safe_tools",
      workspaceDir,
      undefined,
      "goal"
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.reason).toContain("sudo");
  });

  it("blocks destructive shell commands even in full access mode", () => {
    const decision = new PermissionService().decide(
      destructiveShellCall,
      "full_access",
      workspaceDir
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.reason).toContain("destructive command");
  });

  it("blocks protected paths even in full access mode", () => {
    const decision = new PermissionService().decide(
      protectedPathWriteCall,
      "full_access",
      workspaceDir
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.reason).toContain("always protected");
  });

  it("allows workspace writes in auto review mode", () => {
    const decision = new PermissionService().decide(
      workspaceWriteCall,
      "allow_safe_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("blocks writes outside the workspace when agent setting is off", () => {
    const decision = new PermissionService().decide(
      outsideWriteCall,
      "allow_safe_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
  });

  it("allows inert browser navigation in auto review mode", () => {
    const decision = new PermissionService().decide(
      safeBrowserNavigateCall,
      "allow_safe_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("requires approval for external browser navigation in auto review mode", () => {
    const decision = new PermissionService().decide(
      externalBrowserNavigateCall,
      "allow_safe_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });
  it("allows a risky shell command after a per-session tool grant", () => {
    const permissions = new PermissionService();
    const call: ToolCallRecord = {
      id: "node-script",
      name: "bash",
      risk: "high",
      input: { command: "node index.js", cwd: "." }
    };

    const beforeGrant = permissions.decide(
      call,
      "allow_safe_tools",
      workspaceDir,
      undefined,
      null,
      "session-a"
    );

    permissions.rememberSessionGrant("session-a", call, "session_tool");

    const afterGrant = permissions.decide(
      { ...call, id: "node-script-second" },
      "allow_safe_tools",
      workspaceDir,
      undefined,
      null,
      "session-a"
    );

    const otherSession = permissions.decide(
      { ...call, id: "node-script-third" },
      "allow_safe_tools",
      workspaceDir,
      undefined,
      null,
      "session-b"
    );

    expect(beforeGrant.requiresApproval).toBe(true);
    expect(afterGrant.allowed).toBe(true);
    expect(afterGrant.requiresApproval).toBe(false);
    expect(otherSession.requiresApproval).toBe(true);
  });

  it("limits exact command grants to the same session command", () => {
    const permissions = new PermissionService();
    const call: ToolCallRecord = {
      id: "node-script",
      name: "bash",
      risk: "high",
      input: { command: "node index.js", cwd: "." }
    };

    permissions.rememberSessionGrant("session-a", call, "session_exact_command");

    const sameCommand = permissions.decide(
      { ...call, id: "same-command" },
      "ask_every_time",
      workspaceDir,
      undefined,
      null,
      "session-a"
    );
    const differentCommand = permissions.decide(
      {
        ...call,
        id: "different-command",
        input: { command: "node server.js", cwd: "." }
      },
      "allow_safe_tools",
      workspaceDir,
      undefined,
      null,
      "session-a"
    );

    expect(sameCommand.allowed).toBe(true);
    expect(sameCommand.requiresApproval).toBe(false);
    expect(differentCommand.requiresApproval).toBe(true);
  });

  it("allows skill script runs in full access mode", () => {
    const call: ToolCallRecord = {
      id: "skill-run",
      name: "skill.run_script",
      risk: "high",
      input: { skillId: "demo", scriptPath: "scripts/check.js" }
    };

    const decision = new PermissionService().decide(
      call,
      "full_access",
      workspaceDir
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.reason).toContain("Full access");
  });

  it("allows skill script runs after an exact session grant", () => {
    const permissions = new PermissionService();
    const call: ToolCallRecord = {
      id: "skill-run",
      name: "skill.run_script",
      risk: "high",
      input: { skillId: "demo", scriptPath: "scripts/check.js" }
    };

    permissions.rememberSessionGrant("session-a", call, "session_exact_command");
    const decision = permissions.decide(
      { ...call, id: "skill-run-again" },
      "full_access",
      workspaceDir,
      undefined,
      null,
      "session-a"
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });


  it("allows MCP status in auto review mode", () => {
    const decision = new PermissionService().decide(
      mcpStatusCall,
      "allow_safe_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("requires approval for MCP tool calls in auto review mode", () => {
    const decision = new PermissionService().decide(
      mcpCallToolCall,
      "allow_safe_tools",
      workspaceDir
    );

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });

  it("allows MCP tool calls in full access mode", () => {
    const decision = new PermissionService().decide(
      mcpCallToolCall,
      "full_access",
      workspaceDir
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

});

