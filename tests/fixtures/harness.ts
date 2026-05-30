import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentGraphRunner } from "@agent/agentGraph";
import { ChatService } from "@agent/chatService";
import { ArtifactRepository } from "@persistence/artifactRepository";
import { ChatRepository } from "@persistence/chatRepository";
import { LocalDatabase } from "@persistence/localDatabase";
import { MemoryRepository } from "@persistence/memoryRepository";
import { SkillRepository } from "@persistence/skillRepository";
import { WorkspaceLogRepository } from "@persistence/workspaceLogRepository";
import { ContextBuilder } from "@memory/contextBuilder";
import { LlmService } from "@providers/providerService";
import { StubProvider } from "@providers/adapters/stub/stubProvider";
import { ApprovalBroker } from "@permissions/approvalBroker";
import { PermissionService } from "@permissions/permissionService";
import { SkillRegistry } from "@skills-system/skillRegistry";
import { ToolRegistry } from "@tool-registry/toolRegistry";
import { registerAvailableTools } from "@tool-registry/registerTools";
import { BrowserWorkspaceController } from "@workspace/browserWorkspaceController";
import type { ChatSubmitRequest, ModelOption, StreamEvent, WorkspaceSnapshot, WorkspaceStatus } from "@shared/types";

class TestBrowserWorkspaceController extends BrowserWorkspaceController {
  private testStatus: WorkspaceStatus = "idle";
  private testUrl = "about:blank";

  override async navigate(url: string): Promise<WorkspaceSnapshot> {
    this.workspaceLogs.add("browser.navigate", "running", { url });
    this.testUrl = url;
    this.testStatus = "idle";
    this.workspaceLogs.add("browser.navigate", "ok", { url });
    return this.snapshot(false);
  }

  override async click(selector: string): Promise<WorkspaceSnapshot> {
    this.workspaceLogs.add("browser.click", "running", { selector });
    if (selector === "#missing") {
      this.testStatus = "failed";
      this.workspaceLogs.add("browser.click", "failed", { selector, error: "Selector was not found." });
      throw new Error("Selector was not found.");
    }
    this.testStatus = "idle";
    this.workspaceLogs.add("browser.click", "ok", { selector });
    return this.snapshot(false);
  }

  override async type(selector: string, text: string): Promise<WorkspaceSnapshot> {
    this.workspaceLogs.add("browser.type", "running", { selector, size: text.length });
    this.testStatus = "idle";
    this.workspaceLogs.add("browser.type", "ok", { selector, size: text.length });
    return this.snapshot(false);
  }

  override snapshot(includeScreenshot: boolean): Promise<WorkspaceSnapshot> {
    this.workspaceLogs.add("browser.snapshot", "running", { includeScreenshot });
    this.testStatus = "idle";
    this.workspaceLogs.add("browser.snapshot", "ok", { includeScreenshot });
    return Promise.resolve({ url: this.testUrl, title: "Test page", text: "Deterministic browser snapshot" });
  }

  override getStatus(): { status: WorkspaceStatus; url: string } {
    return { status: this.testStatus, url: this.testUrl };
  }

  override close(): Promise<void> {
    this.testStatus = "idle";
    return Promise.resolve();
  }

  private get workspaceLogs(): WorkspaceLogRepository {
    return this.logsForTests;
  }

  constructor(private readonly logsForTests: WorkspaceLogRepository) {
    super(logsForTests);
  }
}

export interface TestHarness {
  dir: string;
  model: ModelOption;
  database: LocalDatabase;
  chats: ChatRepository;
  chatService: ChatService;
  registry: ToolRegistry;
  permissions: PermissionService;
  browser: BrowserWorkspaceController;
  workspaceLogs: WorkspaceLogRepository;
  artifacts: ArtifactRepository;
  close: () => Promise<void>;
}

export const createHarness = async (): Promise<TestHarness> => {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-test-"));
  const database = new LocalDatabase(join(dir, "test.sqlite"));
  await database.initialize();
  const chats = new ChatRepository(database);
  const workspaceLogs = new WorkspaceLogRepository(database);
  const artifacts = new ArtifactRepository(database, join(dir, "workspace"));
  const browser = new TestBrowserWorkspaceController(workspaceLogs);
  const registry = new ToolRegistry();
  registerAvailableTools(registry);
  const skills = new SkillRegistry(new SkillRepository(database));
  skills.initializeBuiltIns();
  const llm = new LlmService();
  const provider = new StubProvider();
  llm.register(provider);
  const permissions = new PermissionService();
  const graph = new AgentGraphRunner(
    llm,
    registry,
    permissions,
    new ApprovalBroker(5),
    new ContextBuilder(),
    new MemoryRepository(database),
    {
      workspaceDir: join(dir, "workspace"),
      browserWorkspace: browser,
      artifacts,
      workspaceLogs,
      agentSettings: {
        allowOutsideWorkspaceAccess: false,
        allowPrivateNetworkAccess: false,
        useShellSandbox: false
      }
    }
  );
  const chatService = new ChatService(chats, skills, graph);
  const model = provider.listModels()[0];
  if (!model) throw new Error("Stub provider returned no models");
  return {
    dir,
    model,
    database,
    chats,
    chatService,
    registry,
    permissions,
    browser,
    workspaceLogs,
    artifacts,
    close: async () => {
      await browser.close();
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
};

export const baseRequest = (model: ModelOption, prompt: string): ChatSubmitRequest => ({
  sessionId: null,
  prompt,
  model,
  permissionMode: "allow_safe_tools",
  agentKind: "general",
  attachments: []
});

export const collectEvents = (): { events: StreamEvent[]; emit: (event: StreamEvent) => void } => {
  const events: StreamEvent[] = [];
  return { events, emit: (event) => events.push(event) };
};
