// playwright.config.ts
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const browserCandidates = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/microsoft-edge"
];

const executablePath = browserCandidates.find((candidate) =>
  existsSync(candidate)
);

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 30000,
  retries: 0,
  reporter: "list",
  use: {
    trace: "off",
    launchOptions: executablePath
      ? { executablePath, args: ["--no-sandbox"] }
      : { args: ["--no-sandbox"] }
  },
  workers: 1
});