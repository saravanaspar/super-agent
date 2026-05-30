import type { LlmProvider, ProviderRequest, ProviderStreamEvent } from "@providers/interfaces/provider";
import { normalizeToolCall } from "@providers/shared/toolNormalization";
import { stubModels } from "@providers/modelCatalog";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class StubProvider implements LlmProvider {
  readonly name = "stub" as const;

  listModels() {
    return stubModels;
  }

  async *stream(
    request: ProviderRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    const last = [...request.messages].reverse()[0];
    const lastUser = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt = lastUser?.content ?? "";

    yield { type: "thinking", delta: "Planning deterministic test response." };

    if (last?.role === "tool") {
      yield { type: "token", delta: `Stub response: observed ${last.name ?? "tool"}. ` };
      yield { type: "done" };
      return;
    }

    if (prompt.includes("[tool:workspace.status]")) {
      yield {
        type: "tool_call",
        call: normalizeToolCall({ name: "workspace.status", risk: "safe" })
      };
      yield { type: "done" };
      return;
    }

    if (prompt.includes("[artifact]")) {
      yield {
        type: "tool_call",
        call: normalizeToolCall({
          name: "artifact.create",
          risk: "safe",
          arguments: {
            title: "Stub artifact",
            kind: "text",
            content: "Created by stub provider."
          }
        })
      };
      yield { type: "done" };
      return;
    }

    const text = `Stub response: ${prompt || "ready"}`;
    for (const chunk of text.split(" ")) {
      if (signal?.aborted) return;
      yield { type: "token", delta: `${chunk} ` };
      await sleep(1);
    }
    yield { type: "done" };
  }
}
