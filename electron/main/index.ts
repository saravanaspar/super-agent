import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppRuntime } from "@settings/appRuntime";
import { registerIpcHandlers } from "./ipc";

let runtime: AppRuntime | null = null;

const configureLinuxWindowing = (): void => {
  if (process.platform !== "linux") return;

  const platformHint = process.env.SUPER_AGENT_OZONE_PLATFORM ?? "x11";

  if (platformHint === "auto") return;

  app.commandLine.appendSwitch("ozone-platform-hint", platformHint);
};

configureLinuxWindowing();

const bundledRendererUrl = (): string =>
  pathToFileURL(join(__dirname, "../renderer/index.html")).href;

const isLocalDevRendererUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
};

const devRendererUrl = (): string | null => {
  const value = process.env.ELECTRON_RENDERER_URL;
  if (!value || app.isPackaged) return null;
  return isLocalDevRendererUrl(value) ? value : null;
};

const rendererUrl = (): string => devRendererUrl() ?? bundledRendererUrl();

const isAllowedRendererUrl = (targetUrl: string, allowedUrl: string): boolean => {
  try {
    const target = new URL(targetUrl);
    const allowed = new URL(allowedUrl);

    if (allowed.protocol === "file:") {
      return target.href === allowed.href;
    }

    return target.origin === allowed.origin;
  } catch {
    return false;
  }
};

const lockWindowNavigation = (window: BrowserWindow, allowedUrl: string): void => {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (isAllowedRendererUrl(targetUrl, allowedUrl)) return;
    event.preventDefault();
  });
};

const createWindow = async (): Promise<void> => {
  const allowedUrl = rendererUrl();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: "Super Agent",
    backgroundColor: "#f7f7f4",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  lockWindowNavigation(window, allowedUrl);

  if (devRendererUrl()) {
    await window.loadURL(allowedUrl);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
};

app.whenReady()
  .then(async () => {
    runtime = await AppRuntime.create();
    registerIpcHandlers(runtime);
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  })
  .catch((error: unknown) => {
    dialog.showErrorBox(
      "Super Agent failed to start",
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void runtime?.close();
});