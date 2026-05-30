// scripts/dev.mjs
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const electronMirror = "https://npmmirror.com/mirrors/electron/";
const ensureElectronScript = fileURLToPath(
  new URL("./ensure-electron.mjs", import.meta.url)
);

const environment = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? electronMirror,
  npm_config_electron_mirror:
    process.env.npm_config_electron_mirror ?? electronMirror,
  npm_config_ignore_scripts: "false"
};

delete environment.ELECTRON_SKIP_BINARY_DOWNLOAD;
delete environment.npm_config_electron_skip_binary_download;

const ensureElectron = spawnSync(process.execPath, [ensureElectronScript], {
  stdio: "inherit",
  env: environment
});

if (ensureElectron.status !== 0) {
  process.exit(ensureElectron.status ?? 1);
}

const showElectronNoise = process.env.SUPER_AGENT_SHOW_ELECTRON_NOISE === "1";

const knownElectronLinuxNoise = [
  /ERROR:ui\/gfx\/x\/atom_cache\.cc:\d+\] Add application\/vnd\.portal\.(filetransfer|files) to kAtomsToCache/,
  /ERROR:content\/browser\/browser_main_loop\.cc:\d+\] GLib-GObject: .*has no handler with id '\d+'/,
  /ERROR:content\/browser\/browser_main_loop\.cc:\d+\] GLib-GObject: .*has no handler with id "\d+"/
];

const shouldSuppressStderrLine = (line) => {
  if (showElectronNoise || process.platform !== "linux") {
    return false;
  }

  return knownElectronLinuxNoise.some((pattern) => pattern.test(line));
};

const pipeFilteredStderr = (stream) => {
  let pending = "";

  stream.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";

    for (const line of lines) {
      if (!shouldSuppressStderrLine(line)) {
        process.stderr.write(`${line}\n`);
      }
    }
  });

  stream.on("end", () => {
    if (pending && !shouldSuppressStderrLine(pending)) {
      process.stderr.write(pending);
    }
    pending = "";
  });
};

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(executable, ["electron-vite", "dev"], {
  stdio: ["inherit", "inherit", "pipe"],
  env: environment
});

if (child.stderr) {
  pipeFilteredStderr(child.stderr);
}

const shutdown = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
