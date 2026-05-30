import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { JsonRecord } from "@shared/json";
import type { PluginSkillRootInput } from "@skills-system/skillRoots";

interface PluginManifest {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  description?: unknown;
  skills?: unknown;
  skillRoots?: unknown;
}

const pluginManifestPath = (workspaceDir: string): string =>
  join(workspaceDir, ".super-agent", "plugins");

const readJson = (path: string): PluginManifest | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const stringArray = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
};

export class PluginRegistry {
  constructor(private workspaceDir?: string | undefined) {}

  setWorkspaceDirectory(workspaceDir: string): void {
    this.workspaceDir = workspaceDir;
  }

  skillRoots(): PluginSkillRootInput[] {
    if (!this.workspaceDir) return [];
    const pluginsDir = pluginManifestPath(this.workspaceDir);
    if (!existsSync(pluginsDir)) return [];

    const roots: PluginSkillRootInput[] = [];
    let entries;
    try {
      entries = readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestFile = join(pluginsDir, entry.name, "plugin.json");
      const manifest = readJson(manifestFile);
      if (!manifest || manifest.enabled === false) continue;
      const pluginId = typeof manifest.id === "string" && manifest.id.trim() ? manifest.id.trim() : entry.name;
      for (const skillRoot of [...stringArray(manifest.skills), ...stringArray(manifest.skillRoots)]) {
        const path = resolve(dirname(manifestFile), skillRoot);
        roots.push({ path, pluginId, enabled: true });
      }
    }

    return roots;
  }

  list(): JsonRecord[] {
    const discovered = this.skillRoots();
    return [
      {
        id: "local-plugin-registry",
        name: "Local plugin registry",
        status: discovered.length > 0 ? "active" : "partial",
        description: "Plugin manifests can contribute read-only skill roots from the active workspace.",
        skillRootCount: discovered.length,
      },
      ...discovered.map((root) => ({
        id: `plugin-skills-${root.pluginId}`,
        name: `${root.pluginId} skills`,
        status: "active",
        description: root.path,
      })),
    ];
  }
}
