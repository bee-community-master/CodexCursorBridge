import { describe, expect, it } from "vitest";
import { assertRelativeRepoPath, evaluateChangedPaths } from "../src/paths.js";

describe("path policy", () => {
  it("rejects absolute paths and traversal", () => {
    expect(() => assertRelativeRepoPath("/tmp/a")).toThrow();
    expect(() => assertRelativeRepoPath("../secret")).toThrow();
  });

  it("reports forbidden and out-of-scope files", () => {
    const result = evaluateChangedPaths(
      ["src/a.ts", "infra/main.tf", "README.md"],
      ["src/**", "tests/**"],
      ["infra/**"],
    );
    expect(result.allowed).toEqual(["src/a.ts"]);
    expect(result.forbidden).toEqual(["infra/main.tf"]);
    expect(result.outOfScope).toEqual(["README.md"]);
  });
});
