import type { ModelOption, ProviderName } from "@shared/types";
import type { LocalDatabase } from "./localDatabase";
import { isRetiredModelOption } from "@providers/retiredModels";

const positiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
};

export class ProviderModelRepository {
  constructor(private readonly database: LocalDatabase) {
    this.database.execute(`
      CREATE TABLE IF NOT EXISTS provider_models (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        label TEXT NOT NULL,
        supports_thinking INTEGER NOT NULL,
        context_window INTEGER,
        max_output_tokens INTEGER,
        updated_at TEXT NOT NULL,
        validated INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(provider, model)
      )
    `);

    this.ensureSchema();
  }

  list(): ModelOption[] {
    return this.database.select(
      `
        SELECT
          provider,
          model,
          label,
          supports_thinking,
          context_window,
          max_output_tokens
        FROM provider_models
        WHERE validated = 1
        ORDER BY provider, label
      `,
      [],
      (row) => {
        const contextWindow = positiveInteger(Number(row.context_window));
        const maxOutputTokens = positiveInteger(Number(row.max_output_tokens));

        return {
          provider: String(row.provider) as ProviderName,
          model: String(row.model),
          label: String(row.label),
          supportsThinking: Number(row.supports_thinking) === 1,
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {})
        };
      }
    );
  }

  replaceProvider(provider: ProviderName, models: ModelOption[]): void {
    this.database.execute("DELETE FROM provider_models WHERE provider = ?", [
      provider
    ]);

    const updatedAt = new Date().toISOString();

    for (const model of models) {
      if (isRetiredModelOption(model)) continue;

      this.database.execute(
        `
          INSERT OR REPLACE INTO provider_models
          (
            provider,
            model,
            label,
            supports_thinking,
            context_window,
            max_output_tokens,
            updated_at,
            validated
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `,
        [
          model.provider,
          model.model,
          model.label,
          model.supportsThinking ? 1 : 0,
          model.contextWindow ?? null,
          model.maxOutputTokens ?? null,
          updatedAt
        ]
      );
    }
  }

  private ensureSchema(): void {
    const columns = this.database.select(
      "PRAGMA table_info(provider_models)",
      [],
      (row) => String(row.name)
    );

    if (!columns.includes("validated")) {
      this.database.execute(
        "ALTER TABLE provider_models ADD COLUMN validated INTEGER NOT NULL DEFAULT 0"
      );
      this.database.execute(
        "UPDATE provider_models SET validated = 1 WHERE provider != 'nvidia'"
      );
    }

    if (!columns.includes("context_window")) {
      this.database.execute(
        "ALTER TABLE provider_models ADD COLUMN context_window INTEGER"
      );
    }

    if (!columns.includes("max_output_tokens")) {
      this.database.execute(
        "ALTER TABLE provider_models ADD COLUMN max_output_tokens INTEGER"
      );
    }
  }
}