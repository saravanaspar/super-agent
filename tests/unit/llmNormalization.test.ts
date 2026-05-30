import { describe, expect, it } from "vitest";
import { normalizeToolCall } from "@providers/shared/toolNormalization";
import { StubProvider } from "@providers/adapters/stub/stubProvider";

describe("provider normalization", () => {
  it("normalizes tool arguments", () => {
    const call = normalizeToolCall({ name: "workspace.status", arguments: "{}" });
    expect(call.name).toBe("workspace.status");
    expect(call.input).toEqual({});
  });

  it("streams deterministic stub tokens", async () => {
    const provider = new StubProvider();
    const model = provider.listModels()[0];
    if (!model) throw new Error("No stub model");
    const events = [];
    for await (const event of provider.stream({ model, messages: [{ role: "user", content: "hello" }], tools: [] })) {
      events.push(event.type);
    }
    expect(events).toContain("token");
    expect(events).toContain("done");
  });
});
