import type {
  AttachmentMetadata,
  ChatMessage,
  ChatSession,
  MessageRole,
  MessageStatus
} from "@shared/types";
import type { JsonRecord } from "@shared/json";
import { parseJsonRecord } from "@shared/json";
import type { LocalDatabase, SqlValue } from "./localDatabase";
import { mapMessage } from "./rowMappers";

export interface ChatMessageInput {
  id?: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  createdAt?: string;
  metadata?: JsonRecord;
  attachments?: AttachmentMetadata[];
}

export const createTitleFromPrompt = (prompt: string): string => {
  const normalized = prompt.trim().replace(/\s+/g, " ");

  if (normalized.length === 0) {
    return "New conversation";
  }

  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
};

const normalizeTitle = (title: string): string => {
  const normalized = title.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, 80) : "New conversation";
};

const normalizeWorkspaceDirectory = (
  workspaceDirectory: string | null | undefined
): string | null => {
  if (!workspaceDirectory) return null;

  const normalized = workspaceDirectory.trim();
  return normalized.length > 0 ? normalized : null;
};

const attachmentRecords = (
  attachments: AttachmentMetadata[]
): JsonRecord[] =>
  attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    textPreview: attachment.textPreview ?? ""
  }));

const metadataToJson = (metadata: JsonRecord): string => {
  const serialized = JSON.stringify(metadata);
  const normalized = parseJsonRecord(serialized);
  return JSON.stringify(normalized);
};

const normalizeMessage = (
  input: ChatMessage | ChatMessageInput
): ChatMessage => {
  const attachments =
    "attachments" in input && input.attachments ? input.attachments : undefined;

  const metadata: JsonRecord = { ...(input.metadata ?? {}) };

  if (attachments && attachments.length > 0) {
    metadata.attachments = attachmentRecords(attachments);
  }

  const message: ChatMessage = {
    id: input.id ?? crypto.randomUUID(),
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    status: input.status ?? "complete",
    createdAt: input.createdAt ?? new Date().toISOString(),
    metadata
  };

  if (attachments && attachments.length > 0) {
    message.attachments = attachments;
  }

  return message;
};

const rowString = (
  row: Record<string, unknown>,
  key: string,
  fallback: string
): string => {
  const value = row[key];
  return typeof value === "string" ? value : fallback;
};

const rowNullableString = (
  row: Record<string, unknown>,
  key: string
): string | null => {
  const value = row[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
};

const mapSessionRow = (row: Record<string, unknown>): ChatSession => ({
  id: rowString(row, "id", ""),
  title: rowString(row, "title", "New conversation"),
  createdAt: rowString(row, "created_at", new Date().toISOString()),
  updatedAt: rowString(row, "updated_at", new Date().toISOString()),
  pinnedAt: rowNullableString(row, "pinned_at"),
  workspaceDirectory: rowNullableString(row, "workspace_directory")
});

export class ChatRepository {
  constructor(private readonly database: LocalDatabase) {
    this.database.execute(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pinned_at TEXT,
        workspace_directory TEXT
      )
    `);

    this.database.execute(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      )
    `);

    this.database.execute(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
      ON chat_messages(session_id, created_at)
    `);

    this.ensurePinnedColumn();
    this.ensureWorkspaceDirectoryColumn();
    this.ensureMetadataJsonColumn();
  }

  createSession(
    title: string,
    workspaceDirectory: string | null = null
  ): ChatSession {
    const timestamp = new Date().toISOString();

    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: normalizeTitle(title),
      createdAt: timestamp,
      updatedAt: timestamp,
      pinnedAt: null,
      workspaceDirectory: normalizeWorkspaceDirectory(workspaceDirectory)
    };

    this.database.execute(
      `
        INSERT INTO chat_sessions
        (id, title, created_at, updated_at, pinned_at, workspace_directory)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        session.id,
        session.title,
        session.createdAt,
        session.updatedAt,
        session.pinnedAt ?? null,
        session.workspaceDirectory ?? null
      ]
    );

    return session;
  }

  getSession(sessionId: string): ChatSession | null {
    const rows = this.selectSessions(
      `
        SELECT
          id,
          title,
          created_at,
          updated_at,
          pinned_at,
          workspace_directory
        FROM chat_sessions
        WHERE id = ?
        LIMIT 1
      `,
      [sessionId]
    );

    return rows[0] ?? null;
  }

  listSessions(query = ""): ChatSession[] {
    const searchQuery = query.trim();

    if (searchQuery.length > 0) {
      return this.selectSessions(
        `
          SELECT
            id,
            title,
            created_at,
            updated_at,
            pinned_at,
            workspace_directory
          FROM chat_sessions
          WHERE (
              title LIKE ?
              OR workspace_directory LIKE ?
            )
            AND EXISTS (
              SELECT 1
              FROM chat_messages
              WHERE chat_messages.session_id = chat_sessions.id
                AND chat_messages.role = 'user'
            )
          ORDER BY
            pinned_at IS NULL ASC,
            pinned_at DESC,
            updated_at DESC
        `,
        [`%${searchQuery}%`, `%${searchQuery}%`]
      );
    }

    return this.selectSessions(
      `
        SELECT
          id,
          title,
          created_at,
          updated_at,
          pinned_at,
          workspace_directory
        FROM chat_sessions
        WHERE EXISTS (
          SELECT 1
          FROM chat_messages
          WHERE chat_messages.session_id = chat_sessions.id
            AND chat_messages.role = 'user'
        )
        ORDER BY
          pinned_at IS NULL ASC,
          pinned_at DESC,
          updated_at DESC
      `,
      []
    );
  }

  addMessage(input: ChatMessage | ChatMessageInput): ChatMessage {
    const message = normalizeMessage(input);

    this.database.execute(
      `
        INSERT INTO chat_messages
        (id, session_id, role, content, status, created_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.status,
        message.createdAt,
        metadataToJson(message.metadata)
      ]
    );

    this.touchSession(message.sessionId);
    return message;
  }

  appendMessageContent(messageId: string, delta: string): void {
    const message = this.getMessage(messageId);

    if (!message) {
      return;
    }

    this.updateMessageContent(
      messageId,
      `${message.content}${delta}`,
      message.status
    );
  }

  updateMessageContent(
    messageId: string,
    content: string,
    status: MessageStatus
  ): void {
    this.database.execute(
      `
        UPDATE chat_messages
        SET content = ?, status = ?
        WHERE id = ?
      `,
      [content, status, messageId]
    );
  }

  updateMessageStatus(messageId: string, status: MessageStatus): void {
    this.database.execute(
      `
        UPDATE chat_messages
        SET status = ?
        WHERE id = ?
      `,
      [status, messageId]
    );
  }

  listMessages(sessionId: string): ChatMessage[] {
    return this.database.select(
      `
        SELECT id, session_id, role, content, status, created_at, metadata_json
        FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at ASC
      `,
      [sessionId],
      mapMessage
    );
  }

  deleteAssistantMessagesAfterLastUser(sessionId: string): boolean {
    this.database.execute(
      `
        DELETE FROM chat_messages
        WHERE session_id = ?
          AND role != 'user'
          AND created_at > COALESCE(
            (
              SELECT MAX(created_at)
              FROM chat_messages
              WHERE session_id = ?
                AND role = 'user'
            ),
            ''
          )
      `,
      [sessionId, sessionId]
    );

    this.touchSession(sessionId);
    return true;
  }

  renameSession(sessionId: string, title: string): ChatSession {
    this.database.execute(
      `
        UPDATE chat_sessions
        SET title = ?, updated_at = ?
        WHERE id = ?
      `,
      [normalizeTitle(title), new Date().toISOString(), sessionId]
    );

    const session = this.getSession(sessionId);

    if (!session) {
      throw new Error("Chat session was not found.");
    }

    return session;
  }

  setPinned(sessionId: string, pinned: boolean): ChatSession {
    this.database.execute(
      `
        UPDATE chat_sessions
        SET pinned_at = ?
        WHERE id = ?
      `,
      [pinned ? new Date().toISOString() : null, sessionId]
    );

    const session = this.getSession(sessionId);

    if (!session) {
      throw new Error("Chat session was not found.");
    }

    return session;
  }

  setWorkspaceDirectory(
    sessionId: string,
    workspaceDirectory: string | null
  ): ChatSession {
    this.database.execute(
      `
        UPDATE chat_sessions
        SET workspace_directory = ?, updated_at = ?
        WHERE id = ?
      `,
      [
        normalizeWorkspaceDirectory(workspaceDirectory),
        new Date().toISOString(),
        sessionId
      ]
    );

    const session = this.getSession(sessionId);

    if (!session) {
      throw new Error("Chat session was not found.");
    }

    return session;
  }

  deleteSession(sessionId: string): boolean {
    this.database.execute(
      "DELETE FROM chat_messages WHERE session_id = ?",
      [sessionId]
    );

    this.database.execute(
      "DELETE FROM chat_sessions WHERE id = ?",
      [sessionId]
    );

    return true;
  }

  countSessions(): number {
    const rows = this.database.select(
      "SELECT COUNT(*) AS count FROM chat_sessions",
      [],
      (row) => Number(row.count ?? 0)
    );

    return rows[0] ?? 0;
  }

  private selectSessions(sql: string, params: SqlValue[]): ChatSession[] {
    return this.database.select(sql, params, mapSessionRow);
  }

  private getMessage(messageId: string): ChatMessage | null {
    const rows = this.database.select(
      `
        SELECT id, session_id, role, content, status, created_at, metadata_json
        FROM chat_messages
        WHERE id = ?
        LIMIT 1
      `,
      [messageId],
      mapMessage
    );

    return rows[0] ?? null;
  }

  private touchSession(sessionId: string): void {
    this.database.execute(
      `
        UPDATE chat_sessions
        SET updated_at = ?
        WHERE id = ?
      `,
      [new Date().toISOString(), sessionId]
    );
  }

  private ensurePinnedColumn(): void {
    const columns = this.tableColumns("chat_sessions");

    if (!columns.includes("pinned_at")) {
      this.database.execute(
        "ALTER TABLE chat_sessions ADD COLUMN pinned_at TEXT"
      );
    }
  }

  private ensureWorkspaceDirectoryColumn(): void {
    const columns = this.tableColumns("chat_sessions");

    if (!columns.includes("workspace_directory")) {
      this.database.execute(
        "ALTER TABLE chat_sessions ADD COLUMN workspace_directory TEXT"
      );
    }
  }

  private ensureMetadataJsonColumn(): void {
    const columns = this.tableColumns("chat_messages");

    if (!columns.includes("metadata_json")) {
      this.database.execute(
        "ALTER TABLE chat_messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'"
      );
    }

    if (columns.includes("metadata")) {
      this.database.execute(
        `
          UPDATE chat_messages
          SET metadata_json = metadata
          WHERE metadata_json = '{}'
            AND metadata IS NOT NULL
            AND metadata != ''
        `
      );
    }
  }

  private tableColumns(tableName: string): string[] {
    return this.database.select(
      `PRAGMA table_info(${tableName})`,
      [],
      (row) => String(row.name ?? "")
    );
  }
}