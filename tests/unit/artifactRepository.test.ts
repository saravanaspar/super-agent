import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactRepository } from "@persistence/artifactRepository";
import { LocalDatabase } from "@persistence/localDatabase";

const roots: string[] = [];
const databases: LocalDatabase[] = [];

const createDatabase = async (): Promise<LocalDatabase> => {
  const root = mkdtempSync(join(tmpdir(), "super-agent-artifact-test-"));
  roots.push(root);
  const database = new LocalDatabase(join(root, "artifacts.sqlite"));
  await database.initialize();
  databases.push(database);
  return database;
};

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.length = 0;

  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

describe("artifact repository workspace routing", () => {
  it("writes new artifacts into the current workspace after a workspace switch", async () => {
    const database = await createDatabase();
    const root = roots[0];
    if (!root) throw new Error("Test root was not created");

    const firstWorkspace = join(root, "first-workspace");
    const secondWorkspace = join(root, "second-workspace");
    const repository = new ArtifactRepository(database, firstWorkspace);

    const first = repository.createArtifact({
      title: "first",
      kind: "text",
      content: "one",
      contentType: "text/markdown",
    });

    repository.setWorkspaceDirectory(secondWorkspace);

    const second = repository.createArtifact({
      title: "second",
      kind: "text",
      content: "two",
      contentType: "text/markdown",
    });

    expect(first.path.startsWith(join(firstWorkspace, "artifacts"))).toBe(true);
    expect(second.path.startsWith(join(secondWorkspace, "artifacts"))).toBe(true);
  });
});
