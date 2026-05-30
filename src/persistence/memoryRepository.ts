import type { LocalDatabase } from "./localDatabase";

export interface MemoryRecord {
  id: string;
  scope: string;
  content: string;
  createdAt: string;
}

const nowIso = (): string => new Date().toISOString();

export class MemoryRepository {
  constructor(private readonly database: LocalDatabase) {}

  add(scope: string, content: string): MemoryRecord {
    const record = { id: crypto.randomUUID(), scope, content, createdAt: nowIso() };
    this.database.execute(
      "INSERT INTO memory (id, scope, content, created_at) VALUES (?, ?, ?, ?)",
      [record.id, record.scope, record.content, record.createdAt]
    );
    return record;
  }

  listRecent(limit: number): MemoryRecord[] {
    return this.database.select(
      "SELECT * FROM memory ORDER BY created_at DESC LIMIT ?",
      [limit],
      (row) => ({
        id: String(row.id ?? ""),
        scope: String(row.scope ?? ""),
        content: String(row.content ?? ""),
        createdAt: String(row.created_at ?? "")
      })
    );
  }
}
