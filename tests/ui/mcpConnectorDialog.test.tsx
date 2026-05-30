// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { McpConnectorDialog } from "@ui/components/library/McpConnectorDialog";

const renderDialog = (onSubmit = vi.fn()) => render(
  <McpConnectorDialog
    dialogRef={createRef<HTMLElement>()}
    error=""
    open={true}
    result={null}
    saving={false}
    onClose={vi.fn()}
    onSubmit={onSubmit}
  />
);

describe("McpConnectorDialog", () => {
  it("requires name and URL before testing the connector", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderDialog(onSubmit);

    expect(screen.getByText("Test and add")).toBeDisabled();
    await user.type(screen.getByLabelText("Name"), "Figma");
    await user.type(screen.getByLabelText("Remote MCP server URL"), "https://mcp.example.test/mcp");
    await user.click(screen.getByText("Test and add"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      name: "Figma",
      url: "https://mcp.example.test/mcp",
      bearerToken: "",
      autoStart: true,
    }));
  });

  it("shows returned tools after validation succeeds", () => {
    render(
      <McpConnectorDialog
        dialogRef={createRef<HTMLElement>()}
        error=""
        open={true}
        result={{
          serverId: "figma",
          configPath: "/tmp/config.yaml",
          toolCount: 1,
          tools: [{ name: "get_context", description: "Read design context" }],
          message: "Connected figma and found 1 tool."
        }}
        saving={false}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.getByText("validated")).toBeInTheDocument();
    expect(screen.getByText("get_context")).toBeInTheDocument();
    expect(screen.queryByText("Test and add")).not.toBeInTheDocument();
  });
});
