import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  addRepository,
  loadMachineConfig,
  runtimePaths,
  saveMachineConfig,
} from "../src/config.js";

describe("machine-local configuration", () => {
  it("persists with owner-only permissions and no secret field", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-config-"));
    await chmod(dir, 0o755);
    const file = path.join(dir, "config.json");
    await saveMachineConfig(file, { cursorModelId: "grok-4.5", repositories: {} });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadMachineConfig(file)).toEqual({ cursorModelId: "grok-4.5", repositories: {} });
  });

  it("adds repository aliases without overwriting an existing alias", () => {
    const initial = { cursorModelId: "grok-4.5", repositories: {} };
    const next = addRepository(initial, "demo", { root: "/repo", origin: "owner/repo", defaultBranch: "main" });
    expect(next.repositories.demo?.origin).toBe("owner/repo");
    expect(() => addRepository(next, "demo", { root: "/other", origin: "owner/other", defaultBranch: "main" })).toThrow();
    expect(() => addRepository(initial, "relative", {
      root: "../repo",
      origin: "owner/repo",
      defaultBranch: "main",
    })).toThrow(/absolute/i);
    expect(() => addRepository(initial, "controlled", {
      root: "/repo\tinjected",
      origin: "owner/repo",
      defaultBranch: "main",
    })).toThrow(/control/i);
  });

  it("allows changing the selected model while preserving repositories", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-config-update-"));
    const file = path.join(dir, "config.json");
    const configured = addRepository(
      { cursorModelId: "grok-old", repositories: {} },
      "demo",
      { root: "/repo", origin: "owner/repo", defaultBranch: "main" },
    );
    await saveMachineConfig(file, { ...configured, cursorModelId: "grok-new" });
    expect((await loadMachineConfig(file)).repositories.demo?.root).toBe("/repo");
  });

  it("keeps generated worktrees under the Bridge machine-local home", () => {
    const paths = runtimePaths("/bridge");

    expect(paths.worktreesDir).toBe(path.join(paths.home, "worktrees"));
  });

  it("normalizes an overridden Bridge home before deriving runtime artifacts", () => {
    vi.stubEnv("CURSOR_BRIDGE_HOME", "relative-bridge-home");
    try {
      const paths = runtimePaths("/bridge");
      expect(path.isAbsolute(paths.home)).toBe(true);
      expect(paths.databaseFile).toBe(path.join(paths.home, "jobs.sqlite"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects control characters in runtime roots", () => {
    vi.stubEnv("CURSOR_BRIDGE_HOME", "/tmp/bridge\tinjected");
    try {
      expect(() => runtimePaths("/bridge")).toThrow(/control/i);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(() => runtimePaths("/bridge\u001binjected")).toThrow(/control/i);
  });
});
