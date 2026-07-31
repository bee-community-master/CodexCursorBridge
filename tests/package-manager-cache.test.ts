import { chmod, cp, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
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
  hostCorepackHome,
  packageManagerDirectory,
  readPackageManager,
  stagePackageManager,
} from "../src/adapters/package-manager-cache.js";
import { provisionPackageManagerManifest } from "../src/adapters/package-manager-provenance.js";
import { createVerificationSandbox } from "../src/sandbox.js";

describe("independent package-manager staging", () => {
  it.each([
    ["self-update"],
    ["with", "11.12.0", "--version"],
    ["exec", "pnpm", "--version"],
    ["--dir", ".", "exec", "pnpm", "--version"],
    ["--pm-on-fail=ignore"],
    ["--filter", "workspace", "dlx", "pnpm", "--version"],
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
    expect(() => assertPackageManagerEnvironment({ NPM_CONFIG_PM_ON_FAIL: "download" }))
      .toThrow(/COREPACK|package-manager/i);
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
      await expect(stagePackageManager(worktree, scratch, path.join(scratch, "manifest.json")))
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
    const localBin = path.join(worktree, "node_modules", ".bin");
    const localMarker = path.join(worktree, "hostile-child-ran");
    await mkdir(localBin, { recursive: true });
    await writeFile(
      path.join(localBin, "pnpm"),
      `#!/bin/sh\nprintf ran > ${localMarker}\nprintf 99.99.99-hostile-child\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@11.10.0",
        scripts: { probe: "pnpm --version" },
      }),
      "utf8",
    );

    const provenanceFile = path.join(cacheRoot, "manifest.json");
    await provisionPackageManagerManifest(provenanceFile, "11.10.0");
    expect((await stat(provenanceFile)).mode & 0o777).toBe(0o600);
    const staged = await stagePackageManager(worktree, cacheRoot, provenanceFile);
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

    const nestedInvocation = createVerificationSandbox({
      worktree,
      scratchDir: scratch,
      command: process.execPath,
      args: [staged.executable, "run", "probe"],
      corepackHome: staged.corepackHome,
      readOnlyRoots: [staged.corepackHome, hostilePath],
      pathPrefix: [path.dirname(staged.executable), path.dirname(process.execPath)],
      blockedProcessPaths: [path.join(localBin, "pnpm")],
      baseEnv: { PATH: `${hostilePath}:/opt/homebrew/bin:/usr/bin:/bin` },
    });
    await expect(runFile(nestedInvocation.command, nestedInvocation.args, {
      cwd: worktree,
      env: nestedInvocation.env,
      timeoutMs: 15_000,
    })).rejects.toBeDefined();
    await expect(stat(localMarker)).rejects.toMatchObject({ code: "ENOENT" });
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
    const provenanceFile = path.join(cacheRoot, "manifest.json");
    await provisionPackageManagerManifest(provenanceFile, "11.10.0");
    const staged = await stagePackageManager(worktree, cacheRoot, provenanceFile);
    await chmod(staged.executable, 0o644);
    await writeFile(staged.executable, "tampered\n", "utf8");
    await expect(assertStagedPackageManager(staged)).rejects.toThrow(/digest changed|integrity|shim changed/i);
  });

  it("rejects a host cache tamper after explicit provisioning", async () => {
    const sourceHome = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-trusted-host-"));
    const stagingRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-trusted-stage-"));
    const manifest = path.join(stagingRoot, "manifest.json");
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-trusted-worktree-"));
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );
    const sourceDirectory = packageManagerDirectory(
      hostCorepackHome(),
      { name: "pnpm", version: "11.10.0", reference: "pnpm@11.10.0" },
    );
    const isolatedSource = packageManagerDirectory(
      sourceHome,
      { name: "pnpm", version: "11.10.0", reference: "pnpm@11.10.0" },
    );
    await mkdir(path.dirname(isolatedSource), { recursive: true });
    await cp(sourceDirectory, isolatedSource, { recursive: true });
    const previous = process.env.COREPACK_HOME;
    process.env.COREPACK_HOME = sourceHome;
    try {
      await provisionPackageManagerManifest(manifest, "11.10.0");
      await chmod(path.join(isolatedSource, "bin", "pnpm.mjs"), 0o644);
      await writeFile(path.join(isolatedSource, "bin", "pnpm.mjs"), "pre-stage tamper\n", "utf8");
      await expect(stagePackageManager(worktree, stagingRoot, manifest))
        .rejects.toThrow(/provisioned artifact digest/i);
    } finally {
      if (previous === undefined) delete process.env.COREPACK_HOME;
      else process.env.COREPACK_HOME = previous;
    }
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
    const provenanceFile = path.join(cacheRoot, "manifest.json");
    await provisionPackageManagerManifest(provenanceFile, "11.10.0");
    const staged = await stagePackageManager(worktree, cacheRoot, provenanceFile);
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
