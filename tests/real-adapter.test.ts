import { rm } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type { MachineConfig, RepositoryConfig, RuntimePaths } from "../src/config.js";
import type { JobStore } from "../src/state.js";
import type { ApprovedTask } from "../src/task.js";

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  runFile: vi.fn(),
  collectChanges: vi.fn(),
  computeCandidateTree: vi.fn(),
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
const store = {
  get: vi.fn(() => undefined),
  getEffect: vi.fn(() => undefined),
  update: vi.fn(),
} as unknown as JobStore;

beforeEach(async () => {
  mocks.git.mockReset();
  mocks.runFile.mockReset();
  mocks.computeCandidateTree.mockReset();
  await rm(paths.worktreesDir, { recursive: true, force: true });
});

function task(pullRequest: ApprovedTask["pull_request"]): ApprovedTask {
  return {
    id: "TASK-DEMO", repository: "demo", title: "Demo change", spec_version: 2, status: "approved",
    spec_hash: `sha256:${"a".repeat(64)}`, policy_version: 2,
    target: {
      origin: "owner/repo",
      base_ref: "main",
      base_sha: "b".repeat(40),
      context_digest: `sha256:${"c".repeat(64)}`,
    },
    approval: { approved_at: "2026-07-23T00:00:00.000Z", approved_by: "local-user" },
    goal: "demo", context_files: [], allowed_paths: ["src/**"], forbidden_paths: [],
    non_goals: [], acceptance_criteria: ["done"], implementation_constraints: [], required_new_tests: [],
    verification: {
      commands: [{ command: "pnpm", args: ["test"], timeout_seconds: 30 }],
      profile_hash: `sha256:${"d".repeat(64)}`,
    },
    limits: {
      max_changed_files: 3,
      max_diff_lines: 100,
      allow_test_deletion: false,
      max_repair_attempts: 1,
    },
    stop_conditions: [],
    pull_request: pullRequest,
  };
}

describe("real GitHub adapter", () => {
  it("creates a collision-resistant new draft branch", async () => {
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing");
      return args[0] === "rev-parse" ? "b".repeat(40) : "";
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const approved = task({ mode: "new_draft" });
    const prepared = await adapter.prepare({ id: "12345678-abcd" }, approved, repository);
    expect(prepared.pushBranch).toBe("codex/cursor/task-demo-demo-change-v2-12345678");
    expect(mocks.git).toHaveBeenCalledWith(
      "/repo",
      "worktree",
      "add",
      "-b",
      prepared.localBranch,
      prepared.worktree,
      approved.target.base_sha,
    );
  });

  it("uses the verified same-repository head branch for an existing PR", async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        headRefName: "feature/existing",
        headRefOid: "b".repeat(40),
        headRepository: { nameWithOwner: "owner/repo" },
        url: "https://github.com/owner/repo/pull/7",
        isDraft: true,
      }),
      stderr: "",
    });
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing");
      return args[0] === "rev-parse" ? "b".repeat(40) : "";
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const approved = task({ mode: "existing_pr", number: 7 });
    const prepared = await adapter.prepare({ id: "12345678-abcd" }, approved, repository);
    expect(prepared.pushBranch).toBe("feature/existing");
    expect(mocks.git).toHaveBeenCalledWith(
      "/repo",
      "worktree",
      "add",
      "-b",
      prepared.localBranch,
      prepared.worktree,
      approved.target.base_sha,
    );
  });

  it("refuses to attest a candidate after the implementer changes HEAD", async () => {
    mocks.git.mockResolvedValue("different-head");
    mocks.computeCandidateTree.mockResolvedValue({
      treeHash: "t".repeat(40),
      patchHash: `sha256:${"p".repeat(64)}`,
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    await expect(adapter.computeCandidateTree({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    })).rejects.toThrow(/HEAD/);
    expect(mocks.computeCandidateTree).toHaveBeenCalled();
  });
});
