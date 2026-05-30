import { describe, expect, it } from "vitest";
import { ContextBuilder } from "@memory/contextBuilder";
import { buildSystemPrompt, loadPrompts } from "@prompts/promptLoader";
import type { ChatMessage } from "@shared/types";

const message = (content: string, index: number): ChatMessage => ({
  id: String(index),
  sessionId: "s",
  role: "user",
  content,
  status: "complete",
  createdAt: new Date(index).toISOString(),
  metadata: {}
});

describe("context builder and prompts", () => {
  it("selects recent chat context", () => {
    const messages = Array.from({ length: 20 }, (_, index) => message(`m${index}`, index));
    const context = new ContextBuilder().build(messages, [], 5);
    expect(context.recentMessages).toHaveLength(5);
    expect(context.summary).toContain("m19");
  });

  it("loads dedicated prompts", () => {
    expect(loadPrompts("browser").agent).toContain("browser workspace");
    expect(buildSystemPrompt("coding", "Skill: Local")).toContain("Skill: Local");
  });

  it("includes tool selection instructions exactly once", () => {
    const prompt = buildSystemPrompt("coding", "");
    expect(prompt.match(/Tool selection rules:/g) ?? []).toHaveLength(1);
  });
});
