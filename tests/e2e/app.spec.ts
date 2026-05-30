import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootDir = process.cwd();

const electronEntry = join(rootDir, "out", "main", "index.js");
const screenshotsDir = join(rootDir, "test-results");

const electronExecutable =
  process.platform === "win32"
    ? join(rootDir, "node_modules", "electron", "dist", "electron.exe")
    : process.platform === "darwin"
      ? join(
          rootDir,
          "node_modules",
          "electron",
          "dist",
          "Electron.app",
          "Contents",
          "MacOS",
          "Electron"
        )
      : join(rootDir, "node_modules", "electron", "dist", "electron");

test("launches app, streams chat, opens library, and controls workspace", async () => {
  test.skip(!existsSync(electronEntry), "Electron build output is missing.");
  test.skip(!existsSync(electronExecutable), "Electron binary is missing.");

  const testDataDir = mkdtempSync(join(tmpdir(), "super-agent-e2e-"));
  const databasePath = join(testDataDir, "super-agent.sqlite");
  const workspaceDir = join(testDataDir, "workspace");

  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [electronEntry, "--no-sandbox"],
    env: {
      ...process.env,
      SUPER_AGENT_TEST_PROVIDER: "stub",
      SUPER_AGENT_DB_PATH: databasePath,
      SUPER_AGENT_WORKSPACE_DIR: workspaceDir,
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
    },
    timeout: 15000
  });

  const stderrLines: string[] = [];

  app.process()?.stderr?.on("data", (chunk: Buffer) => {
    stderrLines.push(chunk.toString("utf8"));
  });

  try {
    const page = await app.firstWindow({ timeout: 15000 });

    page.on("pageerror", (error) => {
      throw error;
    });

    await expect(page.getByText("Ready when you are.")).toBeVisible();
    mkdirSync(screenshotsDir, { recursive: true });
    await page.screenshot({
      path: join(screenshotsDir, "super-agent-01-empty-chat.png"),
      fullPage: true
    });

    await page
      .getByLabel("Model selector")
      .selectOption("stub:deterministic-stub");

    await page.getByPlaceholder("Message Super Agent").fill("hello from e2e");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText(/Stub response: hello from e2e/)).toBeVisible();
    await page.screenshot({
      path: join(screenshotsDir, "super-agent-02-chat-response.png"),
      fullPage: true
    });

    await page.getByLabel("Show workspace").click();
    await page.getByText("Manual controls").click();
    await page.getByLabel("URL").fill("about:blank");
    await page.getByRole("button", { name: "Navigate" }).click();

    await expect(page.getByText("Action log")).toBeVisible();
    await page.screenshot({
      path: join(screenshotsDir, "super-agent-03-workspace-open.png"),
      fullPage: true
    });

    await page.getByText("Action log").click();
    await expect(page.getByText("browser.navigate").first()).toBeVisible();

    await page.getByRole("button", { name: "Library" }).click();
    await expect(page.getByText("Skills").first()).toBeVisible();
    await page.screenshot({
      path: join(screenshotsDir, "super-agent-04-library.png"),
      fullPage: true
    });
  } catch (error) {
    const stderr = stderrLines.join("").trim();

    if (stderr) {
      console.error(stderr);
    }

    throw error;
  } finally {
    await app.close().catch(() => undefined);
  }
});
