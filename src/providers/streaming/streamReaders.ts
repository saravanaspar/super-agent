import type { JsonRecord } from "@shared/json";
import { asJsonRecord } from "@shared/json";

const splitLines = (packet: string): string[] =>
  packet.split("\n").map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line
  );

const readSsePacketData = (packet: string): string[] => {
  const result: string[] = [];

  for (const line of splitLines(packet)) {
    if (!line.startsWith("data:")) continue;

    const data = line.slice("data:".length).trim();
    if (data) result.push(data);
  }

  return result;
};

export async function* readSseData(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.split("\r\n").join("\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const packet = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const data of readSsePacketData(packet)) {
          yield data;
        }

        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    buffer = buffer.split("\r\n").join("\n");

    if (buffer.trim()) {
      for (const data of readSsePacketData(buffer)) {
        yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* parseSseJson(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<JsonRecord> {
  for await (const data of readSseData(stream)) {
    if (data === "[DONE]") continue;
    yield asJsonRecord(JSON.parse(data));
  }
}

export async function* parseNdjson(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<JsonRecord> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        yield asJsonRecord(JSON.parse(trimmed));
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      yield asJsonRecord(JSON.parse(buffer));
    }
  } finally {
    reader.releaseLock();
  }
}
