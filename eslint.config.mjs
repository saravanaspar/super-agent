// eslint.config.mjs
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  AbortController: "readonly",
  Buffer: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setTimeout: "readonly",
  URL: "readonly"
};

const typedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: ["**/*.{ts,tsx}"]
}));

export default tseslint.config(
  {
    ignores: [
      "out/**",
      "dist/**",
      "release/**",
      "node_modules/**",
      "coverage/**",
      "super-agent-data/**"
    ]
  },
  {
    ...js.configs.recommended,
    files: ["**/*.{js,mjs,cjs}"]
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    }
  },
  ...typedConfigs,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  }
);
