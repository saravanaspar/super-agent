import { describe, expect, it } from "vitest";
import { TextToolCallParser } from "@providers/streaming/textToolCallParser";

const collect = (chunks: string[]) => {
  const parser = new TextToolCallParser();
  let text = "";
  const calls = [];

  for (const chunk of chunks) {
    const result = parser.push(chunk);
    text += result.text;
    calls.push(...result.toolCalls);
  }

  text += parser.flushText();
  return { text, calls };
};

describe("TextToolCallParser", () => {
  it("parses Gemma tool-call tags without leaking markup", () => {
    const result = collect([
      "before <|tool_call>call:ls{\"path\":\".\"}<tool_call|> after"
    ]);

    expect(result.text).toBe("before  after");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.name).toBe("ls");
    expect(result.calls[0]?.input).toEqual({ path: "." });
  });

  it("parses loose JSON object keys", () => {
    const result = collect(["<|tool_call>call:ls{path:\".\"}<tool_call|>"]);

    expect(result.text).toBe("");
    expect(result.calls[0]?.name).toBe("ls");
    expect(result.calls[0]?.input).toEqual({ path: "." });
  });

  it("parses tool calls split across streaming chunks", () => {
    const result = collect([
      "hello <|tool",
      "_call>call:grep{\"pattern\":\"TODO\"}",
      "<|tool_call|> done"
    ]);

    expect(result.text).toBe("hello  done");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.name).toBe("grep");
    expect(result.calls[0]?.input).toEqual({ pattern: "TODO" });
  });

  it("passes normal text through", () => {
    const result = collect(["normal ", "assistant text"]);

    expect(result.text).toBe("normal assistant text");
    expect(result.calls).toEqual([]);
  });
});
