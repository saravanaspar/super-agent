import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type TestHarness } from "../fixtures/harness";
import { createTitleFromPrompt } from "@persistence/chatRepository";

describe("session creation", () => {
  let harness: TestHarness;

  beforeEach(async () => { harness = await createHarness(); });
  afterEach(async () => { await harness.close(); });

  it("does not persist a session for an empty draft", () => {
    expect(harness.chats.countSessions()).toBe(0);
  });

  it("creates deterministic titles from first prompts", () => {
    expect(createTitleFromPrompt("  build a browser agent  ")).toBe("build a browser agent");
    expect(createTitleFromPrompt("")).toBe("New conversation");
  });
});
