import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import initSqlJs, { type Database } from "sql.js";

export type SqlValue = string | number | Uint8Array | null;
export type SqlRow = Record<string, SqlValue>;

export class LocalDatabase {
  private database: Database | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private lastPersistedAt = 0;

  constructor(private readonly databasePath: string) {}

  async initialize(): Promise<void> {
    mkdirSync(dirname(this.databasePath), { recursive: true });
    const SQL = await initSqlJs();
    const bytes = existsSync(this.databasePath) ? readFileSync(this.databasePath) : undefined;
    this.database = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.migrate();
    this.persist();
  }

  execute(sql: string, params: SqlValue[] = []): void {
    this.ensureDatabase().run(sql, params);
    this.schedulePersist();
  }

  select<T>(sql: string, params: SqlValue[], map: (row: SqlRow) => T): T[] {
    const result = this.ensureDatabase().exec(sql, params)[0];
    if (!result) return [];
    return result.values.map((values) => {
      const row: SqlRow = {};
      result.columns.forEach((column, index) => {
        row[column] = values[index] ?? null;
      });
      return map(row);
    });
  }

  close(): void {
    if (!this.database) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
    this.database.close();
    this.database = null;
  }

  private migrate(): void {
    this.ensureDatabase().run(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        auto_routing INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        trust_level TEXT NOT NULL DEFAULT 'local',
        quarantine_reason TEXT,
        scan_findings_json TEXT NOT NULL DEFAULT '[]',
        dependency_metadata_json TEXT NOT NULL DEFAULT '{}',
        files_json TEXT NOT NULL DEFAULT '[]',
        version TEXT,
        installed_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        package_size INTEGER NOT NULL DEFAULT 0,
        package_hash TEXT NOT NULL DEFAULT '',
        root_path TEXT,
        source_path TEXT,
        source_rank INTEGER NOT NULL DEFAULT 100,
        plugin_id TEXT,
        shadowed_by TEXT,
        shadow_reason TEXT,
        writable INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        lifecycle_state TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_proposals (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        operation TEXT NOT NULL,
        proposed_files_json TEXT NOT NULL,
        base_package_hash TEXT,
        target_package_hash TEXT NOT NULL,
        diff_json TEXT NOT NULL,
        scan_findings_json TEXT NOT NULL,
        review_json TEXT NOT NULL,
        quarantine_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS skill_rollback_snapshots (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        package_hash TEXT NOT NULL,
        files_json TEXT NOT NULL
      );
    `);

    this.ensureSkillFilesColumn();
    this.ensureSkillAutoRoutingColumn();
    this.ensureSkillMetadataColumns();
    this.ensureSkillTrustColumns();
    this.ensureSkillUsageColumns();
    this.ensureSkillRootColumns();
    this.ensureSkillScriptRunHistoryTable();
    this.ensureSkillAuditLogTable();
    this.ensureSkillWorkflowTables();
    this.ensureSkillLifecycleColumns();
    this.ensureSkillDistributionColumns();
    this.ensureSkillEvalRunHistoryTable();
  }

  private ensureSkillFilesColumn(): void {
    const result = this.ensureDatabase().exec("PRAGMA table_info(skills)")[0];
    const columns = new Set(result?.values.map((row) => String(row[1])) ?? []);

    if (!columns.has("files_json")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'");
    }
  }


  private ensureSkillAutoRoutingColumn(): void {
    const result = this.ensureDatabase().exec("PRAGMA table_info(skills)")[0];
    const columns = new Set(result?.values.map((row) => String(row[1])) ?? []);

    if (!columns.has("auto_routing")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN auto_routing INTEGER NOT NULL DEFAULT 1");
      this.ensureDatabase().run("UPDATE skills SET auto_routing = enabled WHERE source <> 'built-in'");
      this.ensureDatabase().run("UPDATE skills SET auto_routing = 1 WHERE source = 'built-in'");
    }
  }

  private ensureSkillMetadataColumns(): void {
    const result = this.ensureDatabase().exec("PRAGMA table_info(skills)")[0];
    const columns = new Set(result?.values.map((row) => String(row[1])) ?? []);

    if (!columns.has("version")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN version TEXT");
    }

    if (!columns.has("installed_at")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN installed_at TEXT NOT NULL DEFAULT ''");
    }

    if (!columns.has("updated_at")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    }

    if (!columns.has("package_size")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN package_size INTEGER NOT NULL DEFAULT 0");
    }

    const now = new Date().toISOString();
    this.ensureDatabase().run("UPDATE skills SET installed_at = ? WHERE installed_at = ''", [now]);
    this.ensureDatabase().run("UPDATE skills SET updated_at = ? WHERE updated_at = ''", [now]);
  }

  private ensureSkillTrustColumns(): void {
    const result = this.ensureDatabase().exec("PRAGMA table_info(skills)")[0];
    const columns = new Set(result?.values.map((row) => String(row[1])) ?? []);

    if (!columns.has("trust_level")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'local'");
      this.ensureDatabase().run("UPDATE skills SET trust_level = 'built-in' WHERE source = 'built-in'");
    }

    if (!columns.has("quarantine_reason")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN quarantine_reason TEXT");
    }

    if (!columns.has("scan_findings_json")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN scan_findings_json TEXT NOT NULL DEFAULT '[]'");
    }

    if (!columns.has("dependency_metadata_json")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN dependency_metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  private ensureSkillUsageColumns(): void {
    const result = this.ensureDatabase().exec("PRAGMA table_info(skills)")[0];
    const columns = new Set(result?.values.map((row) => String(row[1])) ?? []);

    if (!columns.has("package_hash")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN package_hash TEXT NOT NULL DEFAULT ''");
    }

    if (!columns.has("last_used_at")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN last_used_at TEXT");
    }

    if (!columns.has("use_count")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0");
    }
  }


  private ensureSkillRootColumns(): void {
    const result = this.ensureDatabase().exec("PRAGMA table_info(skills)")[0];
    const columns = new Set(result?.values.map((row) => String(row[1])) ?? []);

    const addText = (name: string): void => {
      if (!columns.has(name)) this.ensureDatabase().run(`ALTER TABLE skills ADD COLUMN ${name} TEXT`);
    };
    const addInt = (name: string, fallback: number): void => {
      if (!columns.has(name)) this.ensureDatabase().run(`ALTER TABLE skills ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${fallback}`);
    };

    addText("root_path");
    addText("source_path");
    addInt("source_rank", 100);
    addText("plugin_id");
    addText("shadowed_by");
    addText("shadow_reason");
    addInt("writable", 1);
  }

  private ensureSkillScriptRunHistoryTable(): void {
    this.ensureDatabase().run(`
      CREATE TABLE IF NOT EXISTS skill_script_runs (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        script_path TEXT NOT NULL,
        args_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        timed_out INTEGER NOT NULL,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        stdout_truncated INTEGER NOT NULL,
        stderr_truncated INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        package_hash TEXT NOT NULL,
        script_hash TEXT NOT NULL DEFAULT '',
        env_keys_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_script_runs_skill_id_created ON skill_script_runs (skill_id, started_at);
    `);

    const result = this.ensureDatabase().exec("PRAGMA table_info(skill_script_runs)")[0];
    const columns = new Set(result?.values.map((row) => String(row[1])) ?? []);
    if (!columns.has("script_hash")) {
      this.ensureDatabase().run("ALTER TABLE skill_script_runs ADD COLUMN script_hash TEXT NOT NULL DEFAULT ''");
    }
  }


  private ensureSkillAuditLogTable(): void {
    this.ensureDatabase().run(`
      CREATE TABLE IF NOT EXISTS skill_audit_log (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        action TEXT NOT NULL,
        skill_id TEXT,
        skill_name TEXT,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        package_hash TEXT,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_audit_log_skill_created ON skill_audit_log (skill_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_audit_log_action_created ON skill_audit_log (action, created_at);
    `);
  }


  private ensureSkillWorkflowTables(): void {
    this.ensureDatabase().run(`
      CREATE TABLE IF NOT EXISTS skill_proposals (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        operation TEXT NOT NULL,
        proposed_files_json TEXT NOT NULL,
        base_package_hash TEXT,
        target_package_hash TEXT NOT NULL,
        diff_json TEXT NOT NULL,
        scan_findings_json TEXT NOT NULL,
        review_json TEXT NOT NULL,
        quarantine_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skill_proposals_skill_status ON skill_proposals (skill_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS skill_rollback_snapshots (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        package_hash TEXT NOT NULL,
        files_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_rollback_snapshots_skill_created ON skill_rollback_snapshots (skill_id, created_at);
    `);
  }


  private ensureSkillLifecycleColumns(): void {
    const result = this.ensureDatabase().exec("PRAGMA table_info(skills)")[0];
    const columns = new Set(result?.values.map((row) => String(row[1])) ?? []);

    if (!columns.has("lifecycle_state")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'");
    }
    if (!columns.has("pinned")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.has("archived_at")) {
      this.ensureDatabase().run("ALTER TABLE skills ADD COLUMN archived_at TEXT");
    }
  }


  private ensureSkillDistributionColumns(): void {
    const result = this.ensureDatabase().exec("PRAGMA table_info(skills)")[0];
    const columns = new Set(result?.values.map((row) => String(row[1])) ?? []);
    const addText = (name: string): void => {
      if (!columns.has(name)) this.ensureDatabase().run(`ALTER TABLE skills ADD COLUMN ${name} TEXT`);
    };
    addText("origin_url");
    addText("source_archive_url");
    addText("source_subpath");
    addText("registry_url");
    addText("publisher");
    addText("expected_package_hash");
    addText("signature");
    addText("public_key");
    addText("verified_at");
    addText("verification_status");
  }

  private ensureSkillEvalRunHistoryTable(): void {
    this.ensureDatabase().run(`
      CREATE TABLE IF NOT EXISTS skill_eval_runs (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        package_hash TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        status TEXT NOT NULL,
        score INTEGER NOT NULL,
        total INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        warnings INTEGER NOT NULL,
        baseline_run_id TEXT,
        baseline_score INTEGER,
        delta_score INTEGER,
        results_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_eval_runs_skill_created ON skill_eval_runs (skill_id, started_at);
    `);
  }

  private persist(): void {
    if (!this.database) return;
    this.dirty = false;
    this.lastPersistedAt = Date.now();

    const dir = dirname(this.databasePath);
    const base = basename(this.databasePath);
    const tmp = join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);

    try {
      writeFileSync(tmp, Buffer.from(this.database.export()));
      renameSync(tmp, this.databasePath);
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best effort cleanup
      }
      throw error;
    }
  }

  private schedulePersist(): void {
    this.dirty = true;
    const elapsed = Date.now() - this.lastPersistedAt;

    if (elapsed >= 250) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.persist();
      return;
    }

    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty) this.persist();
    }, 250 - elapsed);
    this.persistTimer.unref?.();
  }

  private ensureDatabase(): Database {
    if (!this.database) throw new Error("Database has not been initialized");
    return this.database;
  }
}
