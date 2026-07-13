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
});
