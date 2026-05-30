import type { ChatMessage } from "@shared/types";
import type { MemoryRecord } from "@persistence/memoryRepository";

export interface ContextBundle {
  recentMessages: ChatMessage[];
  longTermMemory: MemoryRecord[];
  summary: string;
}

export class ContextBuilder {
  build(messages: ChatMessage[], memories: MemoryRecord[], maxMessages = 12): ContextBundle {
    const recentMessages = messages.slice(Math.max(0, messages.length - maxMessages));
    const longTermMemory = memories.slice(0, 5);
    const memoryText = longTermMemory.map((memory) => `Memory: ${memory.content}`).join("\n");
    const messageText = recentMessages.map((message) => `${message.role}: ${message.content}`).join("\n");
    return { recentMessages, longTermMemory, summary: [memoryText, messageText].filter(Boolean).join("\n") };
  }
}
