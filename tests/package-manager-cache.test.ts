import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFile } from "../src/adapters/command-runner.js";
import {
  assertPackageManagerControlArgs,
  assertPackageManagerEnvironment,
} from "../src/adapters/independent-verifier.js";
import {
  assertStagedPackageManager,
  readPackageManager,
  stagePackageManager,
} from "../src/adapters/package-manager-cache.js";
import { createVerificationSandbox } from "../src/sandbox.js";

describe("independent package-manager staging", () => {
  it.each([
    ["self-update"],
    ["with", "11.12.0", "--version"],
    ["exec", "pnpm", "--version"],
    ["--config.manage-package-manager-versions=true"],
    ["--config", "pm-on-fail=download"],
  ])("rejects package-manager control arguments: %s", (...args: string[]) => {
    expect(() => assertPackageManagerControlArgs(args)).toThrow(/package-manager|switch/i);
  });

  it("rejects every COREPACK_* task environment override", () => {
    expect(() => assertPackageManagerEnvironment({ COREPACK_ROOT: "/tmp/attacker" }))
      .toThrow(/COREPACK_/);
    expect(() => assertPackageManagerEnvironment({ COREPACK_CUSTOM: "1" }))
      .toThrow(/COREPACK_/);
    expect(() => assertPackageManagerEnvironment({ NODE_ENV: "test" })).not.toThrow();
  });

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
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0+sha512.abc+unexpected" }),
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
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-cache-"));
    const hostilePath = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-hostile-path-"));
    const marker = path.join(hostilePath, "ran");
    await writeFile(
      path.join(hostilePath, "pnpm"),
      `#!/bin/sh\nprintf ran > ${marker}\nexit 99\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );

    const staged = await stagePackageManager(worktree, cacheRoot);
    const cacheMode = (await stat(staged.corepackHome)).mode & 0o777;
    expect(cacheMode & 0o222).toBe(0);

    const invocation = createVerificationSandbox({
      worktree,
      scratchDir: scratch,
      command: process.execPath,
      args: [staged.executable, "--version"],
      corepackHome: staged.corepackHome,
      readOnlyRoots: [staged.corepackHome, hostilePath],
      pathPrefix: [path.dirname(staged.executable), path.dirname(process.execPath)],
      baseEnv: { PATH: `${hostilePath}:/opt/homebrew/bin:/usr/bin:/bin` },
    });
    expect(invocation.args[1]).toContain("(deny network*)");
    const result = await runFile(invocation.command, invocation.args, {
      cwd: worktree,
      env: invocation.env,
      timeoutMs: 15_000,
    });

    expect(result.stdout.trim()).toBe("11.10.0");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const childInvocation = createVerificationSandbox({
      worktree,
      scratchDir: scratch,
      command: "/usr/bin/env",
      args: ["pnpm", "--version"],
      corepackHome: staged.corepackHome,
      readOnlyRoots: [staged.corepackHome, hostilePath],
      pathPrefix: [path.dirname(staged.executable), path.dirname(process.execPath)],
      baseEnv: { PATH: `${hostilePath}:/opt/homebrew/bin:/usr/bin:/bin` },
    });
    const childResult = await runFile(childInvocation.command, childInvocation.args, {
      cwd: worktree,
      env: childInvocation.env,
      timeoutMs: 15_000,
    });
    expect(childResult.stdout.trim()).toBe("11.10.0");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(staged).toMatchObject({
      name: "pnpm",
      binary: "pnpm",
      version: "11.10.0",
      entrypoint: "bin/pnpm.mjs",
      source: "verifier-owned-corepack-cache",
      network: "denied",
    });
    expect(staged.digest).toMatch(/^sha512\.[a-f0-9]+$/i);
    expect(staged.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, 30_000);

  it("rejects staged artifact tampering after preparation", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-tamper-worktree-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-tamper-cache-"));
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );
    const staged = await stagePackageManager(worktree, cacheRoot);
    await chmod(staged.executable, 0o644);
    await writeFile(staged.executable, "tampered\n", "utf8");
    await expect(assertStagedPackageManager(staged)).rejects.toThrow(/digest changed|integrity|shim changed/i);
  });

  it("keeps the staged cache outside writable scratch roots", async () => {
    if (process.platform !== "darwin") return;
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-rename-worktree-"));
    const scratch = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-rename-scratch-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-rename-cache-"));
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );
    const staged = await stagePackageManager(worktree, cacheRoot);
    const replacement = `${staged.corepackHome}.replacement`;
    const invocation = createVerificationSandbox({
      worktree,
      scratchDir: scratch,
      command: "/bin/mv",
      args: [staged.corepackHome, replacement],
      corepackHome: staged.corepackHome,
      readOnlyRoots: [staged.corepackHome],
    });
    await expect(runFile(invocation.command, invocation.args, {
      cwd: worktree,
      env: invocation.env,
      timeoutMs: 15_000,
    })).rejects.toBeDefined();
    await expect(stat(staged.corepackHome)).resolves.toBeDefined();
    await expect(stat(replacement)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
