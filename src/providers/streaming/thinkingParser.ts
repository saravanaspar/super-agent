import type { JsonRecord } from "@shared/json";

export interface ThinkExtraction {
  thinking: string;
  content: string;
}

export interface ThinkTagParserState {
  insideThink: boolean;
  pending: string;
}

const OPENING_THINK_TAG = "<think>";
const CLOSING_THINK_TAG = "</think>";

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const indexOfTag = (input: string, tag: string): number =>
  input.toLowerCase().indexOf(tag);

const partialTagSuffixLength = (input: string, tag: string): number => {
  const lower = input.toLowerCase();

  for (
    let length = Math.min(lower.length, tag.length - 1);
    length > 0;
    length -= 1
  ) {
    if (tag.startsWith(lower.slice(-length))) {
      return length;
    }
  }

  return 0;
};

export const createThinkTagParserState = (): ThinkTagParserState => ({
  insideThink: false,
  pending: ""
});

export const extractTaggedThinking = (
  input: string,
  state: ThinkTagParserState
): ThinkExtraction => {
  if (input) {
    state.pending += input;
  }

  let thinking = "";
  let content = "";

  while (state.pending.length > 0) {
    if (state.insideThink) {
      const closeIndex = indexOfTag(state.pending, CLOSING_THINK_TAG);

      if (closeIndex >= 0) {
        thinking += state.pending.slice(0, closeIndex);
        state.pending = state.pending.slice(closeIndex + CLOSING_THINK_TAG.length);
        state.insideThink = false;
        continue;
      }

      const heldLength = partialTagSuffixLength(state.pending, CLOSING_THINK_TAG);
      const flushLength = state.pending.length - heldLength;

      if (flushLength === 0) break;

      thinking += state.pending.slice(0, flushLength);
      state.pending = state.pending.slice(flushLength);
      break;
    }

    const openIndex = indexOfTag(state.pending, OPENING_THINK_TAG);

    if (openIndex >= 0) {
      content += state.pending.slice(0, openIndex);
      state.pending = state.pending.slice(openIndex + OPENING_THINK_TAG.length);
      state.insideThink = true;
      continue;
    }

    const heldLength = partialTagSuffixLength(state.pending, OPENING_THINK_TAG);
    const flushLength = state.pending.length - heldLength;

    if (flushLength === 0) break;

    content += state.pending.slice(0, flushLength);
    state.pending = state.pending.slice(flushLength);
    break;
  }

  return { thinking, content };
};

export const flushTaggedThinking = (
  state: ThinkTagParserState
): ThinkExtraction => {
  if (!state.pending) return { thinking: "", content: "" };

  const pending = state.pending;
  state.pending = "";

  if (state.insideThink) {
    return { thinking: pending, content: "" };
  }

  return { thinking: "", content: pending };
};

export const readThinkingText = (...records: JsonRecord[]): string => {
  for (const record of records) {
    const value =
      readString(record.thinking) ||
      readString(record.reasoning) ||
      readString(record.reasoning_content) ||
      readString(record.reasoningContent);

    if (value) return value;
  }

  return "";
};
