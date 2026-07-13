import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type { MachineConfig, RepositoryConfig, RuntimePaths } from "../src/config.js";
import type { JobStore } from "../src/state.js";
import type { Task } from "../src/task.js";

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  runFile: vi.fn(),
  collectChanges: vi.fn(),
}));

vi.mock("../src/git.js", () => mocks);

const { RealWorkflowAdapter } = await import("../src/real-adapter.js");

const paths: RuntimePaths = {
  projectRoot: "/bridge", home: "/home", configFile: "/home/config.json", databaseFile: "/home/jobs.sqlite",
  logsDir: "/home/logs", reportsDir: "/home/reports", worktreesDir: path.join(os.tmpdir(), "cursor-adapter-tests"), tasksDir: "/bridge/tasks",
};
const config: MachineConfig = {
  cursorModelId: "grok-4.5",
  repositories: { demo: { root: "/repo", origin: "owner/repo", defaultBranch: "main" } },
};
const repository: RepositoryConfig = config.repositories.demo!;
const store = { get: vi.fn(() => undefined), update: vi.fn() } as unknown as JobStore;

function task(pullRequest: Task["pull_request"]): Task {
  return {
    id: "TASK-DEMO", repository: "demo", title: "Demo change", spec_version: 2, status: "approved",
    spec_hash: `sha256:${"a".repeat(64)}`, goal: "demo", context_files: [], allowed_paths: ["src/**"], forbidden_paths: [],
    non_goals: [], acceptance_criteria: ["done"], implementation_constraints: [], required_new_tests: [],
    verification: { commands: [{ command: "pnpm", args: ["test"], timeout_seconds: 30 }] },
    limits: { max_changed_files: 3, max_diff_lines: 100, allow_test_deletion: false }, stop_conditions: [], pull_request: pullRequest,
  };
}

describe("real GitHub adapter", () => {
  it("creates a collision-resistant new draft branch", async () => {
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => args[0] === "rev-parse" ? "base" : "");
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const prepared = await adapter.prepare({ id: "12345678-abcd" }, task({ mode: "new_draft" }), repository);
    expect(prepared.pushBranch).toBe("codex/cursor/task-demo-demo-change-v2-12345678");
    expect(mocks.git).toHaveBeenCalledWith("/repo", "worktree", "add", "-b", prepared.localBranch, prepared.worktree, "origin/main");
  });

  it("uses the verified same-repository head branch for an existing PR", async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({ state: "OPEN", headRefName: "feature/existing", headRepository: { nameWithOwner: "owner/repo" }, url: "https://github.com/owner/repo/pull/7" }),
      stderr: "",
    });
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => args[0] === "rev-parse" ? "base" : "");
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const prepared = await adapter.prepare({ id: "12345678-abcd" }, task({ mode: "existing_pr", number: 7 }), repository);
    expect(prepared.pushBranch).toBe("feature/existing");
    expect(mocks.git).toHaveBeenCalledWith("/repo", "worktree", "add", "-b", prepared.localBranch, prepared.worktree, "origin/feature/existing");
  });
});
