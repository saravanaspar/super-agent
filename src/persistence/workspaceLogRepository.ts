import type { JsonRecord } from "@shared/json";
import { toJson } from "@shared/json";
import { redactSensitiveJson } from "@shared/redaction";
import type { WorkspaceActionLog } from "@shared/types";
import type { LocalDatabase } from "./localDatabase";
import { mapWorkspaceLog } from "./rowMappers";

export class WorkspaceLogRepository {
  constructor(private readonly database: LocalDatabase) {}

  add(action: string, status: WorkspaceActionLog["status"], detail: JsonRecord): WorkspaceActionLog {
    const record: WorkspaceActionLog = {
      id: crypto.randomUUID(),
      action,
      status,
      detail: redactSensitiveJson(detail) as JsonRecord,
      createdAt: new Date().toISOString()
    };
    this.database.execute(
      "INSERT INTO workspace_logs (id, action, status, detail_json, created_at) VALUES (?, ?, ?, ?, ?)",
      [record.id, record.action, record.status, toJson(record.detail), record.createdAt]
    );
    return record;
  }

  list(limit = 100): WorkspaceActionLog[] {
    return this.database.select(
      "SELECT * FROM workspace_logs ORDER BY created_at DESC LIMIT ?",
      [limit],
      mapWorkspaceLog
    );
  }
}
