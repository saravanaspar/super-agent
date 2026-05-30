export interface BoundedAppendResult {
  text: string;
  truncated: boolean;
}

export const appendBoundedOutput = (
  current: string,
  chunk: Buffer,
  maxBytes: number,
): BoundedAppendResult => {
  const next = `${current}${chunk.toString("utf8")}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return { text: next, truncated: false };
  }

  return {
    text: `${next.slice(0, maxBytes)}\n...[output truncated by shellMaxOutputBytes]...`,
    truncated: true,
  };
};
