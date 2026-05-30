import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactKind, ArtifactRecord } from "@shared/types";
import type { LocalDatabase } from "./localDatabase";
import { mapArtifact } from "./rowMappers";

const nowIso = (): string => new Date().toISOString();
const sanitizeName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);

export class ArtifactRepository {
  private artifactDir: string;

  constructor(private readonly database: LocalDatabase, workspaceDir: string) {
    this.artifactDir = this.artifactDirectory(workspaceDir);
    mkdirSync(this.artifactDir, { recursive: true });
  }

  setWorkspaceDirectory(workspaceDir: string): void {
    this.artifactDir = this.artifactDirectory(workspaceDir);
    mkdirSync(this.artifactDir, { recursive: true });
  }

  private artifactDirectory(workspaceDir: string): string {
    return join(workspaceDir, "artifacts");
  }

  createArtifact(input: {
    title: string;
    kind: ArtifactKind;
    content: string;
    contentType: string;
    sessionId?: string | null;
  }): ArtifactRecord {
    const id = crypto.randomUUID();
    const extension = input.kind === "code" ? "txt" : "md";
    const filename = `${id}-${sanitizeName(input.title)}.${extension}`;
    const path = join(this.artifactDir, filename);
    writeFileSync(path, input.content, "utf8");
    const record: ArtifactRecord = {
      id,
      title: input.title,
      kind: input.kind,
      path,
      contentType: input.contentType,
      createdAt: nowIso(),
      sessionId: input.sessionId ?? null
    };
    this.database.execute(
      `INSERT INTO artifacts (id, title, kind, path, content_type, created_at, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.title, record.kind, record.path, record.contentType, record.createdAt, record.sessionId]
    );
    return record;
  }

  listArtifacts(): ArtifactRecord[] {
    return this.database.select("SELECT * FROM artifacts ORDER BY created_at DESC", [], mapArtifact);
  }
}
