import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "@persistence/localDatabase";
import { SettingsRepository, type SecretCodec } from "@settings/settingsRepository";
import { defaultAppSettings } from "@shared/defaultSettings";

const workspaces: string[] = [];
const databases: LocalDatabase[] = [];

const codec: SecretCodec = {
  encrypt(value) {
    return Buffer.from(`sealed:${value}`, "utf8").toString("base64");
  },
  decrypt(value) {
    return Buffer.from(value, "base64").toString("utf8").replace(/^sealed:/, "");
  },
};

const createDatabase = async (): Promise<LocalDatabase> => {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-settings-test-"));
  workspaces.push(dir);
  const database = new LocalDatabase(join(dir, "settings.sqlite"));
  await database.initialize();
  databases.push(database);
  return database;
};

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.length = 0;

  for (const workspace of workspaces) {
    rmSync(workspace, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("settings repository secrets", () => {
  it("stores provider API keys through the configured secret codec", async () => {
    const database = await createDatabase();
    const repository = new SettingsRepository(database, codec);

    repository.save({
      ...defaultAppSettings,
      groqApiKey: "gsk-test-secret",
      nvidiaApiKey: "nvapi-test-secret",
    });

    const rows = database.select(
      "SELECT key, value FROM settings WHERE key IN (?, ?)",
      ["groqApiKey", "nvidiaApiKey"],
      (row) => ({ key: String(row.key), value: String(row.value) }),
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.value.startsWith("enc:v1:"))).toBe(true);
    expect(rows.some((row) => row.value.includes("test-secret"))).toBe(false);
    expect(repository.get()).toMatchObject({
      groqApiKey: "gsk-test-secret",
      nvidiaApiKey: "nvapi-test-secret",
    });
  });

  it("rejects non-empty provider API keys when encrypted storage is unavailable", async () => {
    const database = await createDatabase();
    const repository = new SettingsRepository(database);

    expect(() =>
      repository.save({
        ...defaultAppSettings,
        groqApiKey: "gsk-test-secret",
      }),
    ).toThrow(/safeStorage encryption/);
  });

  it("does not load legacy plaintext provider API keys without encrypted storage", async () => {
    const database = await createDatabase();
    database.execute("INSERT INTO settings (key, value) VALUES (?, ?)", [
      "groqApiKey",
      "gsk-legacy-secret",
    ]);

    const repository = new SettingsRepository(database);

    expect(repository.get().groqApiKey).toBe("");
  });
});
