// vitest.config.ts
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const aliases = {
  "@agent": resolve("src/agent"),
  "@artifacts": resolve("src/artifacts"),
  "@interface": resolve("src/interface"),
  "@memory": resolve("src/memory"),
  "@mcp": resolve("src/mcp"),
  "@permissions": resolve("src/permissions"),
  "@persistence": resolve("src/persistence"),
  "@plugins": resolve("src/plugins"),
  "@providers": resolve("src/providers"),
  "@prompts": resolve("src/prompts"),
  "@settings": resolve("src/settings"),
  "@security": resolve("src/security"),
  "@shared": resolve("src/shared"),
  "@skills-system": resolve("src/skills-system"),
  "@tool-registry": resolve("src/tool-registry"),
  "@tools": resolve("src/tools"),
  "@workspace": resolve("src/workspace"),
  "@ui": resolve("src/ui/src")
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: aliases },
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    globals: true,
    testTimeout: 20000,
    pool: "threads"
  }
});
