// scripts/ensure-electron.mjs
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const electronMirror = "https://npmmirror.com/mirrors/electron/";

const getElectronPackageDir = () => {
  try {
    return dirname(require.resolve("electron"));
  } catch {
    return null;
  }
};

const getElectronBinaryPath = (electronPackageDir) => {
  if (process.platform === "win32") {
    return join(electronPackageDir, "dist", "electron.exe");
  }

  if (process.platform === "darwin") {
    return join(
      electronPackageDir,
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron"
    );
  }

  return join(electronPackageDir, "dist", "electron");
};

const createInstallEnvironment = () => {
  const env = {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? electronMirror,
    npm_config_electron_mirror:
      process.env.npm_config_electron_mirror ?? electronMirror,
    npm_config_ignore_scripts: "false"
  };

  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete env.npm_config_electron_skip_binary_download;

  return env;
};

const runElectronInstaller = (electronPackageDir) => {
  const installerPath = join(electronPackageDir, "install.js");

  if (!existsSync(installerPath)) {
    console.error("Electron installer was not found in node_modules/electron.");
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [installerPath], {
    stdio: "inherit",
    env: createInstallEnvironment()
  });

  if (result.status !== 0) {
    console.error("Electron binary installation failed.");
    process.exit(result.status ?? 1);
  }
};

const electronPackageDir = getElectronPackageDir();

if (!electronPackageDir) {
  console.error("Electron package is missing. Run npm install first.");
  process.exit(1);
}

const electronBinaryPath = getElectronBinaryPath(electronPackageDir);

if (existsSync(electronBinaryPath)) {
  process.exit(0);
}

console.log("Electron binary is missing. Installing Electron runtime...");
runElectronInstaller(electronPackageDir);

if (!existsSync(electronBinaryPath)) {
  console.error("Electron binary is still missing after installation.");
  process.exit(1);
}

console.log("Electron runtime is installed.");