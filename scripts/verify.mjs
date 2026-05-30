// scripts/verify.mjs
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const vitestCommand = isWindows ? "vitest.cmd" : "vitest";

const jobs = [
  {
    name: "typecheck",
    command: npmCommand,
    args: ["run", "typecheck"],
    timeoutMs: 120_000
  },
  {
    name: "lint",
    command: npmCommand,
    args: ["run", "lint"],
    timeoutMs: 120_000
  },
  {
    name: "unit-ui-integration-regression",
    command: vitestCommand,
    args: [
      "run",
      "--config",
      "vitest.config.ts",
      "tests/unit",
      "tests/ui",
      "tests/integration",
      "tests/regression"
    ],
    timeoutMs: 180_000
  },
  {
    name: "e2e",
    command: npmCommand,
    args: ["run", "test:e2e"],
    timeoutMs: 180_000
  }
];

const runJob = (job) =>
  new Promise((resolve, reject) => {
    console.log(`\n[verify] ${job.name}`);
    const child = spawn(job.command, job.args, {
      stdio: "inherit",
      shell: false,
      env: process.env
    });

    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${job.name} timed out after ${job.timeoutMs}ms`));
    }, job.timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `${job.name} terminated by ${signal}`
            : `${job.name} failed with exit code ${code ?? "unknown"}`
        )
      );
    });
  });

for (const job of jobs) {
  await runJob(job);
}

console.log("\n[verify] all checks passed");
