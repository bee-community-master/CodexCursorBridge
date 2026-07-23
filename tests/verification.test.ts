import { describe, expect, it } from "vitest";
import { assessChanges } from "../src/verification.js";

describe("independent change verification", () => {
  it("accepts an in-scope bounded change", () => {
    const result = assessChanges({
      files: ["src/a.ts", "tests/a.test.ts"], deletedFiles: [], diffLines: 30,
      allowedPatterns: ["src/**", "tests/**"], forbiddenPatterns: ["infra/**"],
      maxChangedFiles: 3, maxDiffLines: 50, allowTestDeletion: false,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects forbidden paths, excess diff, and deleted tests", () => {
    const result = assessChanges({
      files: ["src/a.ts", "infra/main.tf", "tests/a.test.ts"], deletedFiles: ["tests/a.test.ts"], diffLines: 80,
      allowedPatterns: ["src/**", "tests/**"], forbiddenPatterns: ["infra/**"],
      maxChangedFiles: 2, maxDiffLines: 50, allowTestDeletion: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/forbidden/i);
    expect(result.reasons.join(" ")).toMatch(/deleted test/i);
  });

  it.each([
    "src/__tests__/service.ts",
    "test/integration/service.ts",
    "spec/service_spec.rb",
    "ios/AppTests/Service.swift",
    "android/src/main/kotlin/ServiceTest.kt",
    "dotnet/Product.Tests/Service.cs",
    "java/src/main/java/TestService.java",
    "service.test.ts",
    "ServiceTest.kt",
    "TestService.java",
  ])("recognizes test-directory deletion for %s", (deletedTest) => {
    const result = assessChanges({
      files: [deletedTest],
      deletedFiles: [deletedTest],
      diffLines: 10,
      allowedPatterns: ["src/**", "test/**", "spec/**"],
      forbiddenPatterns: [],
      maxChangedFiles: 3,
      maxDiffLines: 50,
      allowTestDeletion: false,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/deleted test/i);
  });
});
