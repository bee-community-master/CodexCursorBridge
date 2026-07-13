import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { collectChanges } from "../src/git.js";

const exec = promisify(execFile);

describe("Git change collection", () => {
  it("includes tracked edits, deletions, and untracked files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "a.ts"), "one\n", "utf8");
    await writeFile(path.join(root, "gone.test.ts"), "test\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    await writeFile(path.join(root, "a.ts"), "one\ntwo\n", "utf8");
    await exec("git", ["-C", root, "rm", "-q", "gone.test.ts"]);
    await writeFile(path.join(root, "new.ts"), "new\n", "utf8");

    const changes = await collectChanges(root, base.trim());
    expect(changes.files.sort()).toEqual(["a.ts", "gone.test.ts", "new.ts"]);
    expect(changes.deletedFiles).toEqual(["gone.test.ts"]);
    expect(changes.diffLines).toBeGreaterThanOrEqual(3);
  });
});
