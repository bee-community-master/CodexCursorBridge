import { describe, expect, it } from "vitest";
import { assertRelativeRepoPath, evaluateChangedPaths, resolveInside } from "../src/paths.js";

describe("path policy", () => {
  it("rejects absolute paths and traversal", () => {
    expect(() => assertRelativeRepoPath("/tmp/a")).toThrow();
    expect(() => assertRelativeRepoPath("../secret")).toThrow();
    expect(() => assertRelativeRepoPath("src\\a.ts")).toThrow();
    expect(() => assertRelativeRepoPath("src/\na.ts")).toThrow();
    expect(() => assertRelativeRepoPath("src/\ta.ts")).toThrow();
    expect(() => assertRelativeRepoPath("src/\u001ba.ts")).toThrow();
    expect(() => assertRelativeRepoPath("src/\u007fa.ts")).toThrow();
    expect(() => assertRelativeRepoPath("")).toThrow();
    expect(assertRelativeRepoPath("./src/a.ts")).toBe("src/a.ts");
    expect(resolveInside("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
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

  it("treats scope entries as positive patterns instead of minimatch negation rules", () => {
    const result = evaluateChangedPaths(
      ["README.md", "src/private/key.ts"],
      ["!src/private/**"],
      [],
    );

    expect(result.allowed).toEqual([]);
    expect(result.outOfScope).toEqual(["README.md", "src/private/key.ts"]);
  });
});
