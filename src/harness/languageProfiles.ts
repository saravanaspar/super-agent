import {
  containsIgnoredDirectory,
  ignoredDirectoryNames,
  shouldIgnoreDirectoryName
} from "@shared/ignorePolicy";

export {
  containsIgnoredDirectory,
  ignoredDirectoryNames,
  shouldIgnoreDirectoryName
};

export type ProjectLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "c"
  | "cpp"
  | "csharp"
  | "java"
  | "kotlin"
  | "swift"
  | "ruby"
  | "php"
  | "dart"
  | "scala"
  | "elixir"
  | "erlang"
  | "clojure"
  | "haskell"
  | "ocaml"
  | "lua"
  | "zig"
  | "nim"
  | "shell"
  | "sql"
  | "terraform"
  | "web"
  | "unknown";

export type ProjectFileKind = "source" | "test" | "config" | "docs" | "lock" | "generated" | "asset" | "other";

export interface ClassifiedProjectFile {
  path: string;
  name: string;
  extension: string;
  kind: ProjectFileKind;
  languages: ProjectLanguage[];
  reviewable: boolean;
  reason: string;
}

export interface VerificationCommand {
  id: string;
  label: string;
  command: string;
  language: ProjectLanguage | "multi";
  required: boolean;
  reason: string;
}

export interface VerificationPlan {
  languages: ProjectLanguage[];
  packageManagers: string[];
  commands: VerificationCommand[];
  skipped: Array<{ id: string; reason: string }>;
  notes: string[];
}

const reviewableExtensions = new Set([
  ".astro",
  ".bash",
  ".c",
  ".cc",
  ".cfg",
  ".clj",
  ".cljs",
  ".cmake",
  ".conf",
  ".cpp",
  ".cs",
  ".csproj",
  ".css",
  ".cxx",
  ".dart",
  ".dockerfile",
  ".env.example",
  ".erl",
  ".ex",
  ".exs",
  ".fs",
  ".go",
  ".gradle",
  ".graphql",
  ".gql",
  ".h",
  ".hcl",
  ".hh",
  ".hpp",
  ".hrl",
  ".hs",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".mjs",
  ".ml",
  ".mli",
  ".nim",
  ".php",
  ".prisma",
  ".properties",
  ".proto",
  ".ps1",
  ".py",
  ".pyi",
  ".rb",
  ".rs",
  ".sbt",
  ".scala",
  ".scss",
  ".sh",
  ".sln",
  ".sql",
  ".svelte",
  ".swift",
  ".tf",
  ".tfvars",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zig",
  ".zsh"
]);

const exactReviewableNames = new Set([
  ".env.example",
  ".eslintrc",
  ".prettierrc",
  "AGENTS.md",
  "BUILD",
  "CMakeLists.txt",
  "CONTRIBUTING.md",
  "Dockerfile",
  "LICENSE",
  "Makefile",
  "README.md",
  "SECURITY.md",
  "WORKSPACE",
  "build.gradle",
  "compose.yaml",
  "docker-compose.yaml",
  "docker-compose.yml",
  "go.mod",
  "gradlew",
  "meson.build",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
  "settings.gradle",
  "setup.cfg",
  "setup.py",
  "tsconfig.json"
]);

const ignoredFileNames = new Set([
  "Cargo.lock",
  "Gemfile.lock",
  "Package.resolved",
  "Pipfile.lock",
  "bun.lockb",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock"
]);

const generatedFilePatterns = [
  /(^|\/)generated\//i,
  /(^|\/)coverage\//i,
  /\.min\.(js|css)$/i,
  /\.generated\./i,
  /\.pb\.(go|cc|h|java|py|rb)$/i
];

const binaryOrAssetExtensions = new Set([
  ".avif",
  ".bmp",
  ".eot",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".map",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".snap",
  ".svg",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip"
]);

const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "");

export const pathSegments = (path: string): string[] => normalizePath(path).split("/").filter(Boolean);

export const basenameOf = (path: string): string => pathSegments(path).at(-1) ?? normalizePath(path);

export const extensionOf = (path: string): string => {
  const name = basenameOf(path);
  if (name === ".env.example") return ".env.example";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
};

const isTestPath = (path: string): boolean =>
  /(^|\/)(test|tests|spec|specs|__tests__)\//i.test(path) ||
  /\.(test|spec)\.[a-z0-9]+$/i.test(path) ||
  /_test\.(go|py)$/i.test(path);

const languageForExtension = (extension: string, name: string): ProjectLanguage[] => {
  if ([".ts", ".tsx"].includes(extension)) return ["typescript"];
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return ["javascript"];
  if ([".html", ".css", ".scss", ".vue", ".svelte", ".astro"].includes(extension)) return ["web"];
  if ([".py", ".pyi"].includes(extension)) return ["python"];
  if (extension === ".rs") return ["rust"];
  if (extension === ".go") return ["go"];
  if ([".c", ".h"].includes(extension)) return ["c"];
  if ([".cc", ".cpp", ".cxx", ".hpp", ".hh"].includes(extension)) return ["cpp"];
  if ([".cs", ".csproj", ".sln", ".fs", ".vb"].includes(extension)) return ["csharp"];
  if (extension === ".java") return ["java"];
  if ([".kt", ".kts"].includes(extension)) return ["kotlin"];
  if (extension === ".swift") return ["swift"];
  if (extension === ".rb") return ["ruby"];
  if (extension === ".php") return ["php"];
  if (extension === ".dart") return ["dart"];
  if ([".scala", ".sbt"].includes(extension)) return ["scala"];
  if ([".ex", ".exs"].includes(extension)) return ["elixir"];
  if ([".erl", ".hrl"].includes(extension)) return ["erlang"];
  if ([".clj", ".cljs"].includes(extension)) return ["clojure"];
  if (extension === ".hs") return ["haskell"];
  if ([".ml", ".mli"].includes(extension)) return ["ocaml"];
  if (extension === ".lua") return ["lua"];
  if (extension === ".zig") return ["zig"];
  if (extension === ".nim") return ["nim"];
  if ([".sh", ".bash", ".zsh", ".ps1"].includes(extension) || name === "Makefile") return ["shell"];
  if (extension === ".sql") return ["sql"];
  if ([".tf", ".tfvars", ".hcl"].includes(extension)) return ["terraform"];
  if (name === "CMakeLists.txt" || name === "meson.build") return ["cpp"];
  if (name === "package.json") return ["javascript"];
  if (name === "pyproject.toml" || name === "requirements.txt" || name === "setup.py") return ["python"];
  if (name === "Cargo.toml") return ["rust"];
  if (name === "go.mod") return ["go"];
  if (name === "pom.xml" || name === "build.gradle" || name === "settings.gradle") return ["java"];
  return [];
};

export const classifyProjectFile = (path: string): ClassifiedProjectFile => {
  const normalized = normalizePath(path);
  const name = basenameOf(normalized);
  const extension = extensionOf(normalized);
  const languages = languageForExtension(extension, name);

  if (containsIgnoredDirectory(normalized)) {
    return { path: normalized, name, extension, languages, kind: "generated", reviewable: false, reason: "ignored directory" };
  }

  if (ignoredFileNames.has(name)) {
    return { path: normalized, name, extension, languages, kind: "lock", reviewable: false, reason: "lockfile" };
  }

  if (generatedFilePatterns.some(pattern => pattern.test(normalized))) {
    return { path: normalized, name, extension, languages, kind: "generated", reviewable: false, reason: "generated output" };
  }

  if (binaryOrAssetExtensions.has(extension)) {
    return { path: normalized, name, extension, languages, kind: "asset", reviewable: false, reason: "binary or static asset" };
  }

  const exact = exactReviewableNames.has(name);
  const reviewable = exact || reviewableExtensions.has(extension);
  const kind: ProjectFileKind = isTestPath(normalized)
    ? "test"
    : /^docs?\//i.test(normalized) || /(^|\/)(README|SECURITY|CONTRIBUTING|CHANGELOG)\.md$/i.test(normalized)
      ? "docs"
      : exact && languages.length === 0
        ? "config"
        : reviewable && languages.length === 0
          ? "config"
          : reviewable
            ? "source"
            : "other";

  return {
    path: normalized,
    name,
    extension,
    languages,
    kind,
    reviewable,
    reason: reviewable ? kind : "not a source/config/doc file"
  };
};

export const isReviewableProjectFile = (path: string): boolean => classifyProjectFile(path).reviewable;

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

const hasFile = (files: readonly string[], name: string): boolean => files.some(file => basenameOf(file) === name);
const hasExt = (files: readonly string[], extensions: readonly string[]): boolean => files.some(file => extensions.includes(extensionOf(file)));
const hasScript = (scripts: Record<string, string>, name: string): boolean => typeof scripts[name] === "string" && scripts[name].trim().length > 0;

const inferPackageManager = (files: readonly string[], packageJsonPackageManager?: string): string[] => {
  const managers: string[] = [];
  if (packageJsonPackageManager?.startsWith("pnpm@") || hasFile(files, "pnpm-lock.yaml") || hasFile(files, "pnpm-workspace.yaml")) managers.push("pnpm");
  if (packageJsonPackageManager?.startsWith("yarn@") || hasFile(files, "yarn.lock")) managers.push("yarn");
  if (packageJsonPackageManager?.startsWith("bun@") || hasFile(files, "bun.lockb")) managers.push("bun");
  if (packageJsonPackageManager?.startsWith("npm@") || hasFile(files, "package-lock.json")) managers.push("npm");
  if (hasFile(files, "pyproject.toml")) managers.push("python");
  if (hasFile(files, "Cargo.toml")) managers.push("cargo");
  if (hasFile(files, "go.mod")) managers.push("go");
  if (hasFile(files, "pom.xml")) managers.push("maven");
  if (hasFile(files, "build.gradle") || hasFile(files, "settings.gradle")) managers.push("gradle");
  if (hasFile(files, "composer.json")) managers.push("composer");
  if (hasFile(files, "Gemfile")) managers.push("bundler");
  return unique(managers);
};

const command = (
  id: string,
  label: string,
  commandValue: string,
  language: VerificationCommand["language"],
  reason: string,
  required = false
): VerificationCommand => ({ id, label, command: commandValue, language, reason, required });

export const inferVerificationPlan = (input: {
  files: readonly string[];
  scripts?: Record<string, string>;
  packageJsonPackageManager?: string;
}): VerificationPlan => {
  const files = input.files.map(normalizePath);
  const scripts = input.scripts ?? {};
  const languages = unique(files.flatMap(file => classifyProjectFile(file).languages)).filter(language => language !== "unknown");
  const packageManagers = inferPackageManager(files, input.packageJsonPackageManager);
  const commands: VerificationCommand[] = [];
  const skipped: VerificationPlan["skipped"] = [];
  const notes: string[] = [];
  const jsManager = packageManagers.find(manager => ["pnpm", "yarn", "bun", "npm"].includes(manager)) ?? "npm";
  const runScript = jsManager === "yarn" ? "yarn" : jsManager === "bun" ? "bun run" : `${jsManager} run`;
  const directTest = jsManager === "yarn" ? "yarn test" : jsManager === "bun" ? "bun test" : `${jsManager} test`;

  if (hasFile(files, "package.json")) {
    if (hasScript(scripts, "typecheck")) commands.push(command("js-typecheck", "TypeScript typecheck", `${runScript} typecheck`, "typescript", "package.json defines a typecheck script", true));
    else if (hasFile(files, "tsconfig.json") && hasExt(files, [".ts", ".tsx"])) commands.push(command("tsc", "TypeScript compiler", "npx tsc --noEmit", "typescript", "TypeScript files and tsconfig.json detected"));
    else skipped.push({ id: "js-typecheck", reason: "No typecheck script or tsconfig was detected." });

    if (hasScript(scripts, "lint")) commands.push(command("js-lint", "JavaScript/TypeScript lint", `${runScript} lint`, "javascript", "package.json defines a lint script"));
    else skipped.push({ id: "js-lint", reason: "No lint script was defined." });

    if (hasScript(scripts, "test") && !/no test specified/i.test(scripts.test ?? "")) commands.push(command("js-test", "JavaScript/TypeScript tests", directTest, "javascript", "package.json defines a real test script", true));
    else skipped.push({ id: "js-test", reason: "No real test script was defined." });

    if (hasScript(scripts, "test:e2e")) commands.push(command("js-e2e", "UI/end-to-end tests", `${runScript} test:e2e`, "web", "package.json defines a test:e2e script"));
    else if (hasScript(scripts, "e2e")) commands.push(command("js-e2e", "UI/end-to-end tests", `${runScript} e2e`, "web", "package.json defines an e2e script"));
    else if (files.some(file => basenameOf(file).startsWith("playwright.config"))) commands.push(command("playwright", "Playwright UI/end-to-end tests", "npx playwright test", "web", "Playwright config detected"));

    if (hasScript(scripts, "build")) commands.push(command("js-build", "JavaScript/TypeScript build", `${runScript} build`, "javascript", "package.json defines a build script"));
  }

  if (hasExt(files, [".py", ".pyi"]) || hasFile(files, "pyproject.toml") || hasFile(files, "requirements.txt")) {
    commands.push(command("python-compile", "Python syntax check", "python -m compileall .", "python", "Python files detected", true));
    if (files.some(file => /(^|\/)(tests?|test_)|_test\.py$/i.test(file)) || hasFile(files, "pytest.ini")) {
      commands.push(command("python-test", "Python tests", "python -m pytest", "python", "Python test files/config detected", true));
    }
    if (hasFile(files, "ruff.toml") || files.some(file => basenameOf(file) === "pyproject.toml")) {
      commands.push(command("python-ruff", "Python lint", "ruff check .", "python", "Python config detected"));
    }
  }

  if (hasFile(files, "Cargo.toml") || hasExt(files, [".rs"])) {
    commands.push(command("rust-check", "Rust check", "cargo check", "rust", "Rust project detected", true));
    commands.push(command("rust-test", "Rust tests", "cargo test", "rust", "Rust project detected", true));
  }

  if (hasFile(files, "go.mod") || hasExt(files, [".go"])) {
    commands.push(command("go-test", "Go tests", "go test ./...", "go", "Go project detected", true));
    commands.push(command("go-vet", "Go vet", "go vet ./...", "go", "Go project detected"));
  }

  if (hasFile(files, "CMakeLists.txt")) commands.push(command("cmake-build", "CMake configure/build", "cmake -S . -B build && cmake --build build", "cpp", "CMake project detected"));
  else if (hasFile(files, "Makefile")) commands.push(command("make-check", "Make check/test", "make test || make check", "multi", "Makefile detected"));

  if (hasExt(files, [".cs", ".csproj", ".sln"])) {
    commands.push(command("dotnet-build", "dotnet build", "dotnet build", "csharp", "C# project detected", true));
    commands.push(command("dotnet-test", "dotnet test", "dotnet test", "csharp", "C# project detected"));
  }

  if (hasFile(files, "pom.xml")) commands.push(command("maven-test", "Maven tests", "mvn test", "java", "Maven project detected", true));
  if (hasFile(files, "gradlew")) commands.push(command("gradle-test", "Gradle tests", "./gradlew test", "java", "Gradle wrapper detected", true));
  else if (hasFile(files, "build.gradle") || hasFile(files, "settings.gradle")) commands.push(command("gradle-test", "Gradle tests", "gradle test", "java", "Gradle project detected"));

  if (hasExt(files, [".swift"]) || hasFile(files, "Package.swift")) commands.push(command("swift-test", "Swift tests", "swift test", "swift", "Swift package detected", true));
  if (hasFile(files, "pubspec.yaml")) commands.push(command("dart-test", "Dart/Flutter tests", "dart test || flutter test", "dart", "Dart/Flutter project detected"));
  if (hasFile(files, "composer.json")) commands.push(command("composer-test", "PHP tests", "composer test || vendor/bin/phpunit", "php", "Composer project detected"));
  if (hasFile(files, "Gemfile")) commands.push(command("ruby-test", "Ruby tests", "bundle exec rake test || bundle exec rspec", "ruby", "Ruby project detected"));

  if (commands.length === 0) {
    notes.push("No deterministic verification command was inferred. Review must rely on complete source coverage and explicit limitations.");
  }

  return {
    languages: languages.length > 0 ? languages : ["unknown"],
    packageManagers,
    commands,
    skipped,
    notes
  };
};
