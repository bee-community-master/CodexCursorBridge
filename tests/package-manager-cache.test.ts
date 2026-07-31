import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFile } from "../src/adapters/command-runner.js";
import {
  readPackageManager,
  stagePackageManager,
} from "../src/adapters/package-manager-cache.js";
import { createVerificationSandbox } from "../src/sandbox.js";

describe("independent package-manager staging", () => {
  it("requires an exact pnpm packageManager declaration", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-"));
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );

    await expect(readPackageManager(worktree)).resolves.toEqual({
      name: "pnpm",
      version: "11.10.0",
      reference: "pnpm@11.10.0",
    });
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@^11.10.0" }),
      "utf8",
    );
    await expect(readPackageManager(worktree)).rejects.toThrow(/exact pnpm/i);
  });

  it("fails closed when the exact host Corepack artifact is absent", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-missing-"));
    const scratch = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-missing-scratch-"));
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );
    const previous = process.env.COREPACK_HOME;
    process.env.COREPACK_HOME = path.join(scratch, "empty-host-cache");
    try {
      await expect(stagePackageManager(worktree, scratch))
        .rejects.toThrow(/pre-provision.*Corepack cache/i);
    } finally {
      if (previous === undefined) delete process.env.COREPACK_HOME;
      else process.env.COREPACK_HOME = previous;
    }
  });

  it("executes the declared pnpm from a read-only cache with network denied", async () => {
    if (process.platform !== "darwin") return;
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-worktree-"));
    const scratch = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-scratch-"));
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );

    const staged = await stagePackageManager(worktree, scratch);
    const cacheMode = (await stat(staged.corepackHome)).mode & 0o777;
    expect(cacheMode & 0o222).toBe(0);

    const invocation = createVerificationSandbox({
      worktree,
      scratchDir: scratch,
      command: "pnpm",
      args: ["--version"],
      corepackHome: staged.corepackHome,
    });
    expect(invocation.args[1]).toContain("(deny network*)");
    const result = await runFile(invocation.command, invocation.args, {
      cwd: worktree,
      env: invocation.env,
      timeoutMs: 15_000,
    });

    expect(result.stdout.trim()).toBe("11.10.0");
    expect(staged).toMatchObject({
      name: "pnpm",
      version: "11.10.0",
      source: "verifier-owned-corepack-cache",
      network: "denied",
    });
    expect(staged.digest).toMatch(/^sha512\.[a-f0-9]+$/i);
  }, 30_000);
});
