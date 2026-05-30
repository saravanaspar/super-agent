// electron.vite.config.ts
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const root = __dirname;

const aliases = {
  "@agent": resolve(root, "src/agent"),
  "@artifacts": resolve(root, "src/artifacts"),
  "@interface": resolve(root, "src/interface"),
  "@mcp": resolve(root, "src/mcp"),
  "@memory": resolve(root, "src/memory"),
  "@permissions": resolve(root, "src/permissions"),
  "@persistence": resolve(root, "src/persistence"),
  "@plugins": resolve(root, "src/plugins"),
  "@providers": resolve(root, "src/providers"),
  "@prompts": resolve(root, "src/prompts"),
  "@settings": resolve(root, "src/settings"),
  "@security": resolve(root, "src/security"),
  "@shared": resolve(root, "src/shared"),
  "@skills-system": resolve(root, "src/skills-system"),
  "@tool-registry": resolve(root, "src/tool-registry"),
  "@tools": resolve(root, "src/tools"),
  "@workspace": resolve(root, "src/workspace"),
  "@ui": resolve(root, "src/ui/src")
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: aliases
    },
    build: {
      outDir: resolve(root, "out/main"),
      rollupOptions: {
        input: {
          index: resolve(root, "electron/main/index.ts")
        }
      }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: aliases
    },
    build: {
      outDir: resolve(root, "out/preload"),
      rollupOptions: {
        input: {
          index: resolve(root, "electron/preload/index.ts")
        }
      }
    }
  },

  renderer: {
    root: resolve(root, "src/ui"),
    plugins: [react()],
    resolve: {
      alias: aliases
    },
    build: {
      outDir: resolve(root, "out/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(root, "src/ui/index.html")
        }
      }
    }
  }
});