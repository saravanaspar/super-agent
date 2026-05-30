import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import type { JsonRecord } from "@shared/json";
import type { AgentBehaviorSettings } from "@shared/types";
import type { WorkspaceSnapshot, WorkspaceStatus } from "@shared/types";
import type { WorkspaceLogRepository } from "@persistence/workspaceLogRepository";
import { validateBrowserWorkspaceUrl } from "../security/networkPolicy";

const browserCandidates = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/microsoft-edge"
];

const findSystemBrowser = (): string | undefined =>
  browserCandidates.find((candidate) => existsSync(candidate));

const isNonNetworkBrowserUrl = (rawUrl: string): boolean => {
  try {
    const parsed = new URL(rawUrl);
    return ["about:", "data:", "blob:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};

export class BrowserWorkspaceController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private status: WorkspaceStatus = "idle";
  private currentUrl = "about:blank";
  private lastSnapshot: WorkspaceSnapshot | null = null;

  constructor(
    private readonly logs: WorkspaceLogRepository,
    private agentSettings: AgentBehaviorSettings = {
      allowOutsideWorkspaceAccess: false,
      allowPrivateNetworkAccess: false,
      useShellSandbox: false
    }
  ) {}

  setAgentSettings(settings: AgentBehaviorSettings): void {
    this.agentSettings = settings;
  }

  async navigate(url: string): Promise<WorkspaceSnapshot> {
    return this.run("browser.navigate", { url }, async () => {
      const targetUrl = await validateBrowserWorkspaceUrl(
        url,
        this.agentSettings
      );
      const page = await this.ensurePage();
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      this.currentUrl = page.url();
      await validateBrowserWorkspaceUrl(this.currentUrl, this.agentSettings);
      return this.captureSnapshot(true);
    });
  }

  async click(selector: string): Promise<WorkspaceSnapshot> {
    return this.run("browser.click", { selector }, async () => {
      const page = await this.ensurePage();
      await page.click(selector, { timeout: 3000 });
      this.currentUrl = page.url();
      await this.validateCurrentPageUrl();
      return this.captureSnapshot(true);
    });
  }

  async type(selector: string, text: string): Promise<WorkspaceSnapshot> {
    return this.run("browser.type", { selector, size: text.length }, async () => {
      const page = await this.ensurePage();
      await page.fill(selector, text, { timeout: 3000 });
      this.currentUrl = page.url();
      await this.validateCurrentPageUrl();
      return this.captureSnapshot(true);
    });
  }

  async snapshot(includeScreenshot: boolean): Promise<WorkspaceSnapshot> {
    return this.run("browser.snapshot", { includeScreenshot }, async () =>
      this.captureSnapshot(includeScreenshot)
    );
  }

  getStatus(): { status: WorkspaceStatus; url: string } {
    return { status: this.status, url: this.currentUrl };
  }

  getSnapshot(): WorkspaceSnapshot | null {
    return this.lastSnapshot;
  }

  async close(): Promise<void> {
    const closePromise =
      this.browser?.close().catch(() => undefined) ?? Promise.resolve();

    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => setTimeout(resolve, 1000))
    ]);

    this.browser = null;
    this.page = null;
    this.status = "idle";
    this.currentUrl = "about:blank";
    this.lastSnapshot = null;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;

    const executablePath = findSystemBrowser();
    const launchOptions = executablePath
      ? { headless: true, executablePath }
      : { headless: true };

    this.browser = await chromium.launch(launchOptions);
    this.page = await this.browser.newPage({
      viewport: { width: 1440, height: 960 }
    });

    await this.page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (isNonNetworkBrowserUrl(requestUrl)) {
        await route.continue();
        return;
      }

      try {
        await validateBrowserWorkspaceUrl(requestUrl, this.agentSettings);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });

    await this.page.goto("about:blank");
    return this.page;
  }

  private async validateCurrentPageUrl(): Promise<void> {
    if (this.currentUrl === "about:blank") return;
    await validateBrowserWorkspaceUrl(this.currentUrl, this.agentSettings);
  }

  private async captureSnapshot(
    includeScreenshot: boolean
  ): Promise<WorkspaceSnapshot> {
    const page = await this.ensurePage();

    const [title, text] = await Promise.all([
      page.title().catch(() => ""),
      page.locator("body").innerText({ timeout: 3000 }).catch(() => "")
    ]);

    const screenshotBase64 = includeScreenshot
      ? (await page.screenshot({ type: "png", fullPage: false })).toString(
          "base64"
        )
      : undefined;

    this.currentUrl = page.url();
    await this.validateCurrentPageUrl();

    const snapshot: WorkspaceSnapshot = {
      url: this.currentUrl,
      title,
      text: text.slice(0, 6000),
      ...(screenshotBase64 ? { screenshotBase64 } : {})
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  private async run<T>(
    action: string,
    detail: JsonRecord,
    operation: () => Promise<T>
  ): Promise<T> {
    this.status = "running";
    this.logs.add(action, "running", detail);

    try {
      const result = await operation();
      this.status = "idle";
      this.logs.add(action, "ok", detail);
      return result;
    } catch (error) {
      this.status = "failed";
      const message =
        error instanceof Error
          ? error.message
          : "Unknown browser workspace error";

      this.logs.add(action, "failed", { ...detail, error: message });
      throw new Error(message, { cause: error });
    }
  }
}
