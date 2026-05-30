import { ignoredDirectoryNames } from "@shared/ignorePolicy";

export interface CommandPattern {
  re: RegExp;
  label: string;
}

export const SHELL_HEAVY_COMMAND_PATTERNS: CommandPattern[] = [
  { re: /\b(UnrealEditor|UE4Editor|UE5Editor|RunUAT|BuildCookRun)\b/i, label: "Unreal engine workload" },
  { re: /\b(docker|podman)\s+(build|compose\s+build|compose\s+up)\b/i, label: "container build/runtime workload" },
  { re: /\b(npm|yarn|pnpm)\s+(run\s+)?(build|compile|bundle)\b/i, label: "JavaScript build workload" },
  { re: /\b(cargo|go|mvn|gradle|cmake|make|ninja)\b[\s\S]*\b(build|test|install|--build|-j\s*\d*)\b/i, label: "compiler/build workload" },
  { re: /\b(python|python3)\b[\s\S]*(train|finetune|fine-tune|torch|tensorflow|jax|llama|transformers)/i, label: "ML/training workload" },
  { re: /\b(node)\b[\s\S]*(--max-old-space-size|webpack|vite|rollup|next\s+build)/i, label: "large Node.js workload" },
  { re: /\b(blender|ffmpeg)\b[\s\S]*(-render|render|-i|\.mp4|\.mov|\.mkv)/i, label: "render/media workload" }
];

export const SKIP_DIRS = new Set(ignoredDirectoryNames);

export const HARD_BLOCK_PATH_PREFIXES = [
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/root",
  "/var/log",
  "/var/run",
  "/run",
  "/lost+found",
  "/etc/sudoers.d",
  "/etc/ssh",
  "/etc/ssl/private"
];

export const HARD_BLOCK_EXACT_PATHS = new Set([
  "/etc/shadow",
  "/etc/passwd",
  "/etc/group",
  "/etc/gshadow",
  "/etc/hosts",
  "/etc/sudoers"
]);

export const DETACHED_COMMAND_PATTERNS = [
  /(^|[;&|]\s*)(nohup|setsid|daemonize|screen|tmux)\b/,
  /(^|[\s;&|])disown([\s;&|]|$)/,
  /(^|[^\\])&\s*($|[;])/
];

export const PACKAGE_INSTALL_PATTERN =
  /\b(sudo\s+)?(apt|apt-get|dnf|yum|pacman|zypper|apk|brew|npm|yarn|pnpm|pip|pip3|uv|gem|cargo)\b[\s\S]*\b(install|add|i|sync)\b/i;

export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
export const DEFAULT_HUGE_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_WRITE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_SEARCH_BYTES = 20 * 1024 * 1024;
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
export const DEFAULT_SHELL_MAX_OUTPUT_BYTES = 65_536;
