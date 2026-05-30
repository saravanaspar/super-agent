import { describe, expect, it } from "vitest";
import { classifyProjectFile, inferVerificationPlan, isReviewableProjectFile } from "../../src/harness/languageProfiles";

const paths = [
  "package.json",
  "pnpm-lock.yaml",
  "src/app.ts",
  "public/index.html",
  "tests/app.test.ts",
  "pyproject.toml",
  "app/main.py",
  "Cargo.toml",
  "src/lib.rs",
  "go.mod",
  "cmd/server/main.go",
  "CMakeLists.txt",
  "src/main.cpp",
  "Project.sln",
  "src/App.cs",
  "pom.xml",
  "src/main/java/App.java",
  "build.gradle",
  "src/main/kotlin/App.kt",
  "Package.swift",
  "Sources/App/main.swift",
  "composer.json",
  "src/App.php",
  "Gemfile",
  "lib/app.rb",
  "pubspec.yaml",
  "lib/main.dart",
  "terraform/main.tf",
  "node_modules/pkg/index.ts",
  "target/debug/app"
];

describe("language profile classification", () => {
  it("reviews broad language source/config files while skipping generated junk", () => {
    expect(isReviewableProjectFile("src/main.cpp")).toBe(true);
    expect(isReviewableProjectFile("src/App.cs")).toBe(true);
    expect(isReviewableProjectFile("app/main.py")).toBe(true);
    expect(isReviewableProjectFile("src/lib.rs")).toBe(true);
    expect(isReviewableProjectFile("terraform/main.tf")).toBe(true);
    expect(isReviewableProjectFile("node_modules/pkg/index.ts")).toBe(false);
    expect(isReviewableProjectFile("target/debug/app")).toBe(false);
  });

  it("classifies tests separately from source", () => {
    expect(classifyProjectFile("tests/app.test.ts").kind).toBe("test");
  });
});

describe("verification planning", () => {
  it("infers commands across common project stacks without inventing missing npm scripts", () => {
    const plan = inferVerificationPlan({
      files: paths,
      scripts: {
        test: "echo \"Error: no test specified\" && exit 1",
        start: "node server.js"
      }
    });

    const commands = plan.commands.map(item => item.command);
    expect(commands).not.toContain("npm run typecheck");
    expect(commands).not.toContain("npm test");
    expect(commands).toContain("python -m compileall .");
    expect(commands).toContain("cargo check");
    expect(commands).toContain("go test ./...");
    expect(commands).toContain("cmake -S . -B build && cmake --build build");
    expect(commands).toContain("dotnet build");
    expect(commands).toContain("mvn test");
    expect(commands).toContain("gradle test");
    expect(commands).toContain("swift test");
    expect(commands).toContain("composer test || vendor/bin/phpunit");
    expect(commands).toContain("bundle exec rake test || bundle exec rspec");
    expect(commands).toContain("dart test || flutter test");
  });
});
