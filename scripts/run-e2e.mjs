// scripts/run-e2e.mjs
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

const run = (command, args, env = {}) =>
  spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env }
  });

const commandExists = (command) =>
  spawnSync("bash", ["-lc", `command -v ${command} >/dev/null 2>&1`]).status ===
  0;

const isLinux = process.platform === "linux";
const hasXvfb = isLinux && commandExists("xvfb-run");

const electronBinary =
  process.platform === "win32"
    ? join(process.cwd(), "node_modules", "electron", "dist", "electron.exe")
    : process.platform === "darwin"
      ? join(
          process.cwd(),
          "node_modules",
          "electron",
          "dist",
          "Electron.app",
          "Contents",
          "MacOS",
          "Electron"
        )
      : join(process.cwd(), "node_modules", "electron", "dist", "electron");

const hasElectronBinary =
  existsSync(electronBinary) ||
  existsSync(join(process.cwd(), "node_modules", "electron", "path.txt"));

const runRendererFallback = () => {
  console.log("Running deterministic renderer E2E fallback.");

  return run(npxCommand, [
    "vitest",
    "run",
    "--config",
    "vitest.config.ts",
    "tests/ui/rendererFallback.test.tsx"
  ]);
};

const build = run(npmCommand, ["run", "build"]);

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!hasElectronBinary) {
  console.error(
    "Electron binary is not installed. Run npm run prepare:electron or set SUPER_AGENT_E2E_RENDERER_FALLBACK=1 for the renderer-only fallback."
  );

  if (process.env.SUPER_AGENT_E2E_RENDERER_FALLBACK === "1") {
    const fallback = runRendererFallback();
    process.exit(fallback.status ?? 1);
  }

  process.exit(1);
}

const e2eEnvironment = {
  SUPER_AGENT_TEST_PROVIDER: "stub",
  ELECTRON_ENABLE_LOGGING: "1",
  ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
};

const command = hasXvfb ? "xvfb-run" : npxCommand;

const args = hasXvfb
  ? [
      "-a",
      "npx",
      "playwright",
      "test",
      "--config=playwright.config.ts",
      "tests/e2e/app.spec.ts"
    ]
  : [
      "playwright",
      "test",
      "--config=playwright.config.ts",
      "tests/e2e/app.spec.ts"
    ];

const e2e = run(command, args, e2eEnvironment);

if (e2e.status === 0) {
  process.exit(0);
}

console.error(
  "Electron E2E did not complete. Set SUPER_AGENT_E2E_RENDERER_FALLBACK=1 to run the renderer-only fallback intentionally."
);

if (process.env.SUPER_AGENT_E2E_RENDERER_FALLBACK === "1") {
  const fallback = runRendererFallback();
  process.exit(fallback.status ?? 1);
}

process.exit(e2e.status ?? 1);