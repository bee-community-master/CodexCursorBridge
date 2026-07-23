import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type { MachineConfig, RepositoryConfig, RuntimePaths } from "../src/config.js";
import type { Attempt, Effect, Job, JobStore } from "../src/state.js";
import type { ApprovedTask } from "../src/task.js";
import type { PublicationInput } from "../src/workflow.js";

const mocks = vi.hoisted(() => ({
  assertGitHubRemote: vi.fn(),
  assertWorktreeIdentity: vi.fn(),
  captureWorktreeIdentity: vi.fn(),
  git: vi.fn(),
  runFile: vi.fn(),
  collectChanges: vi.fn(),
  computeCandidateTree: vi.fn(),
}));
const sdkMocks = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  modelsList: vi.fn(),
}));

vi.mock("../src/git.js", () => mocks);
vi.mock("../src/keychain.js", () => ({
  readCursorApiKey: vi.fn(async () => "cursor-key"),
}));
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: sdkMocks.create,
    resume: sdkMocks.resume,
    getRun: sdkMocks.getRun,
    cancelRun: sdkMocks.cancelRun,
  },
  Cursor: { models: { list: sdkMocks.modelsList } },
  JsonlLocalAgentStore: class JsonlLocalAgentStore {},
}));

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
const now = "2026-07-23T00:00:00.000Z";
const store = {
  get: vi.fn(() => undefined),
  getAttempt: vi.fn(() => undefined),
  getEffect: vi.fn(() => undefined),
  assertActiveAttempt: vi.fn(),
  beginEffect: vi.fn(),
  completeEffect: vi.fn(),
  update: vi.fn(),
  updateAttempt: vi.fn(),
} as unknown as JobStore;

beforeEach(async () => {
  mocks.git.mockReset();
  mocks.assertGitHubRemote.mockReset().mockImplementation(async (root: string) => {
    await mocks.git(root, "remote", "get-url", "--all", "origin");
    await mocks.git(root, "remote", "get-url", "--push", "--all", "origin");
  });
  mocks.assertWorktreeIdentity.mockReset().mockResolvedValue(undefined);
  mocks.captureWorktreeIdentity.mockReset().mockResolvedValue({
    gitFileContent: "gitdir: /repo/.git/worktrees/job\n",
    gitDir: "/repo/.git/worktrees/job",
    commonGitDir: "/repo/.git",
    configDigest: `sha256:${"a".repeat(64)}`,
  });
  mocks.runFile.mockReset();
  mocks.collectChanges.mockReset();
  mocks.computeCandidateTree.mockReset();
  vi.mocked(store.get).mockReset().mockReturnValue(undefined);
  vi.mocked(store.getAttempt).mockReset().mockReturnValue(undefined);
  vi.mocked(store.getEffect).mockReset().mockReturnValue(undefined);
  vi.mocked(store.assertActiveAttempt).mockReset();
  vi.mocked(store.beginEffect).mockReset();
  vi.mocked(store.completeEffect).mockReset();
  vi.mocked(store.update).mockReset();
  vi.mocked(store.updateAttempt).mockReset();
  sdkMocks.create.mockReset().mockRejectedValue(new Error("Unexpected new Cursor agent"));
  sdkMocks.resume.mockReset().mockRejectedValue(new Error("Unexpected Cursor resume"));
  sdkMocks.getRun.mockReset();
  sdkMocks.cancelRun.mockReset();
  sdkMocks.modelsList.mockReset().mockResolvedValue([{
    id: "grok-4.5",
    displayName: "Grok 4.5",
  }]);
  await rm(paths.worktreesDir, { recursive: true, force: true });
});

function task(pullRequest: ApprovedTask["pull_request"]): ApprovedTask {
  return {
    id: "TASK-DEMO", repository: "demo", title: "Demo change", spec_version: 2, status: "approved",
    spec_hash: `sha256:${"a".repeat(64)}`, policy_version: 3,
    target: {
      origin: "owner/repo",
      base_ref: pullRequest.mode === "existing_pr" ? "feature/existing" : "main",
      destination_ref: "main",
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

function durableEffect(kind: string, idempotencyKey: string): Effect {
  return {
    id: `effect-${kind}`,
    jobId: "job",
    attemptId: "attempt",
    kind,
    idempotencyKey,
    status: "STARTED",
    createdAt: now,
    updatedAt: now,
  };
}

function publishingAttempt(): Attempt {
  return {
    id: "attempt",
    jobId: "job",
    ordinal: 1,
    status: "PUBLISHING",
    workerToken: "worker",
    leaseExpiresAt: "2026-07-23T01:00:00.000Z",
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function publicationInput(treeHash = "e".repeat(40)): PublicationInput {
  return {
    tree: {
      treeHash,
      patchHash: `sha256:${"a".repeat(64)}`,
    },
    initialChanges: { files: ["src/demo.ts"], deletedFiles: [], diffLines: 1 },
    finalChanges: { files: ["src/demo.ts"], deletedFiles: [], diffLines: 1 },
    assessment: {
      ok: true,
      reasons: [],
      allowed: ["src/demo.ts"],
      forbidden: [],
      outOfScope: [],
    },
    verification: [{ command: "pnpm test", status: "passed" as const, durationMs: 1 }],
    attempts: [publishingAttempt()],
    cursorSummary: "done",
  };
}

function rawCommit(treeHash: string, parentSha: string): string {
  return `tree ${treeHash}\nparent ${parentSha}\n\nbridge commit`;
}

describe("real GitHub adapter", () => {
  it("rejects a changed worktree Git metadata pointer before collecting changes", async () => {
    mocks.assertWorktreeIdentity.mockRejectedValue(
      new Error("Worktree Git metadata pointer changed after preparation"),
    );
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.collectChanges({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
      gitIdentity: {
        gitFileContent: "gitdir: /repo/.git/worktrees/job\n",
        gitDir: "/repo/.git/worktrees/job",
        commonGitDir: "/repo/.git",
        configDigest: `sha256:${"a".repeat(64)}`,
      },
    })).rejects.toThrow(/metadata pointer changed/i);

    expect(mocks.collectChanges).not.toHaveBeenCalled();
  });

  it("rejects a changed worktree branch before collecting changes", async () => {
    mocks.git.mockResolvedValue("unexpected-branch");
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.collectChanges({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "approved-branch",
      localBranch: "approved-branch",
      gitIdentity: {
        gitFileContent: "gitdir: /repo/.git/worktrees/job\n",
        gitDir: "/repo/.git/worktrees/job",
        commonGitDir: "/repo/.git",
        configDigest: `sha256:${"a".repeat(64)}`,
      },
    })).rejects.toThrow(/branch changed/i);

    expect(mocks.collectChanges).not.toHaveBeenCalled();
  });

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
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "-b",
      prepared.localBranch,
      prepared.worktree,
      approved.target.base_sha,
    );
  });

  it("records a newly created worktree before identity validation can fail", async () => {
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing");
      return "";
    });
    mocks.captureWorktreeIdentity.mockRejectedValue(
      new Error("Worktree Git metadata identity could not be verified"),
    );
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const approved = task({ mode: "new_draft" });

    await expect(adapter.prepare({ id: "job" }, approved, repository))
      .rejects.toThrow(/metadata identity/i);

    expect(store.update).toHaveBeenCalledWith("job", {
      worktree: path.join(paths.worktreesDir, approved.repository, "job"),
      baseSha: approved.target.base_sha,
    });
  });

  it("checks a resumed worktree Git config identity before fetching", async () => {
    const worktree = path.join(paths.worktreesDir, "demo", "job");
    await mkdir(worktree, { recursive: true });
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      gitConfigDigest: `sha256:${"1".repeat(64)}`,
    };
    vi.mocked(store.get).mockReturnValue({
      currentAttemptId: attempt.id,
    } as Job);
    vi.mocked(store.getAttempt).mockReturnValue(attempt);
    mocks.captureWorktreeIdentity.mockResolvedValue({
      gitFileContent: "gitdir: /repo/.git/worktrees/job\n",
      gitDir: "/repo/.git/worktrees/job",
      commonGitDir: "/repo/.git",
      configDigest: `sha256:${"2".repeat(64)}`,
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.prepare(
      { id: "job" },
      task({ mode: "new_draft" }),
      repository,
    )).rejects.toThrow(/Git configuration identity changed/i);

    expect(mocks.git.mock.calls.some(([, ...args]) => args[0] === "fetch"))
      .toBe(false);
  });

  it("uses the verified same-repository head branch for an existing PR", async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        baseRefName: "main",
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
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "-b",
      prepared.localBranch,
      prepared.worktree,
      approved.target.base_sha,
    );
  });

  it("rejects an existing PR whose head branch changed after approval", async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/renamed",
        headRefOid: "b".repeat(40),
        headRepository: { nameWithOwner: "owner/repo" },
        url: "https://github.com/owner/repo/pull/7",
        isDraft: true,
      }),
      stderr: "",
    });
    mocks.git.mockResolvedValue("");
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.prepare(
      { id: "12345678-abcd" },
      task({ mode: "existing_pr", number: 7 }),
      repository,
    )).rejects.toThrow(/head branch changed/i);
  });

  it("rejects an existing PR whose destination branch changed after approval", async () => {
    const approved = task({ mode: "existing_pr", number: 7 });
    Object.assign(approved.target, { destination_ref: "main" });
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        baseRefName: "release",
        headRefName: "feature/existing",
        headRefOid: approved.target.base_sha,
        headRepository: { nameWithOwner: "owner/repo" },
        url: "https://github.com/owner/repo/pull/7",
        isDraft: true,
      }),
      stderr: "",
    });
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing");
      return args[0] === "rev-parse" ? approved.target.base_sha : "";
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.prepare({ id: "job" }, approved, repository))
      .rejects.toThrow(/destination|base branch/i);
  });

  it("rejects an existing pull request that is no longer a draft", async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/existing",
        headRefOid: "b".repeat(40),
        headRepository: { nameWithOwner: "owner/repo" },
        url: "https://github.com/owner/repo/pull/7",
        isDraft: false,
      }),
      stderr: "",
    });
    mocks.git.mockResolvedValue("");
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.prepare(
      { id: "12345678-abcd" },
      task({ mode: "existing_pr", number: 7 }),
      repository,
    )).rejects.toThrow(/draft/i);
  });

  it("resumes an existing PR after its own durable push changed the approved head", async () => {
    const publishedHead = "d".repeat(40);
    const publishedTree = "e".repeat(40);
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/existing",
        headRefOid: publishedHead,
        headRepository: { nameWithOwner: "owner/repo" },
        url: "https://github.com/owner/repo/pull/7",
        isDraft: true,
      }),
      stderr: "",
    });
    vi.mocked(store.getEffect).mockImplementation((key) => {
      if (key === `push:job:feature/existing:${publishedHead}`) {
        return durableEffect("git_push", key);
      }
      if (key === `commit:job:${publishedTree}`) {
        return {
          ...durableEffect("git_commit", key),
          status: "COMPLETED",
          payload: { headSha: publishedHead, treeHash: publishedTree },
        };
      }
      return undefined;
    });
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "show-ref") return publishedHead;
      if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") return publishedTree;
      if (args[0] === "rev-parse") return publishedHead;
      if (args[0] === "cat-file") {
        return rawCommit(publishedTree, "b".repeat(40));
      }
      return "";
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const approved = task({ mode: "existing_pr", number: 7 });

    const prepared = await adapter.prepare({ id: "job" }, approved, repository);

    expect(prepared.pushBranch).toBe("feature/existing");
    expect(prepared.baseSha).toBe(approved.target.base_sha);
  });

  it("refuses to push when an existing PR head changed after approval", async () => {
    const approved = task({ mode: "existing_pr", number: 7 });
    const candidateTree = "e".repeat(40);
    const candidateHead = "d".repeat(40);
    const unexpectedRemote = "f".repeat(40);
    vi.mocked(store.get).mockReturnValue({ currentAttemptId: "attempt" } as never);
    vi.mocked(store.getAttempt).mockReturnValue(publishingAttempt());
    vi.mocked(store.beginEffect).mockImplementation((_jobId, _attemptId, kind, key) =>
      durableEffect(kind, key));
    vi.mocked(store.completeEffect).mockImplementation((_effectId, payload) => ({
      ...durableEffect("completed", "completed"),
      status: "COMPLETED",
      payload,
    }));
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "remote") return "git@github.com:owner/repo.git";
      if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") return candidateTree;
      if (args[0] === "rev-parse") return candidateHead;
      if (args[0] === "cat-file") {
        return rawCommit(candidateTree, approved.target.base_sha);
      }
      if (args[0] === "ls-remote") return `${unexpectedRemote}\trefs/heads/feature/existing`;
      return "";
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.publish({
      worktree: "/worktree",
      baseSha: approved.target.base_sha,
      pushBranch: "feature/existing",
      localBranch: "codex/cursor/task-demo-followup-job",
    }, approved, repository, {
      tree: {
        treeHash: candidateTree,
        patchHash: `sha256:${"a".repeat(64)}`,
      },
      initialChanges: { files: ["src/demo.ts"], deletedFiles: [], diffLines: 1 },
      finalChanges: { files: ["src/demo.ts"], deletedFiles: [], diffLines: 1 },
      assessment: { ok: true, reasons: [], allowed: ["src/demo.ts"], forbidden: [], outOfScope: [] },
      verification: [{ command: "pnpm test", status: "passed", durationMs: 1 }],
      attempts: [publishingAttempt()],
      cursorSummary: "done",
    }, publishingAttempt())).rejects.toThrow(/head changed|remote/i);
    expect(mocks.git.mock.calls.some(([, ...args]) => args.includes("push"))).toBe(false);
  });

  it("pushes an existing PR with an exact approved-head lease", async () => {
    const approved = task({ mode: "existing_pr", number: 7 });
    const candidateTree = "e".repeat(40);
    const candidateHead = "d".repeat(40);
    let remoteReads = 0;
    let treeReads = 0;
    vi.mocked(store.get).mockReturnValue({ currentAttemptId: "attempt" } as never);
    vi.mocked(store.getAttempt).mockReturnValue(publishingAttempt());
    vi.mocked(store.beginEffect).mockImplementation((_jobId, _attemptId, kind, key) =>
      durableEffect(kind, key));
    vi.mocked(store.completeEffect).mockImplementation((_effectId, payload) => ({
      ...durableEffect("completed", "completed"),
      status: "COMPLETED",
      payload,
    }));
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "remote") return "git@github.com:owner/repo.git";
      if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") {
        treeReads += 1;
        return treeReads === 1 ? "a".repeat(40) : candidateTree;
      }
      if (args[0] === "rev-parse") return candidateHead;
      if (args[0] === "cat-file") {
        return rawCommit(candidateTree, approved.target.base_sha);
      }
      if (args[0] === "write-tree") return candidateTree;
      if (args[0] === "ls-remote") {
        remoteReads += 1;
        const sha = remoteReads === 1 ? approved.target.base_sha : candidateHead;
        return `${sha}\trefs/heads/feature/existing`;
      }
      return "";
    });
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/existing",
        headRefOid: candidateHead,
        headRepository: { nameWithOwner: "owner/repo" },
        url: "https://github.com/owner/repo/pull/7",
        isDraft: true,
      }),
      stderr: "",
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await adapter.publish({
      worktree: "/worktree",
      baseSha: approved.target.base_sha,
      pushBranch: "feature/existing",
      localBranch: "codex/cursor/task-demo-followup-job",
    }, approved, repository, {
      tree: {
        treeHash: candidateTree,
        patchHash: `sha256:${"a".repeat(64)}`,
      },
      initialChanges: { files: ["src/demo.ts"], deletedFiles: [], diffLines: 1 },
      finalChanges: { files: ["src/demo.ts"], deletedFiles: [], diffLines: 1 },
      assessment: { ok: true, reasons: [], allowed: ["src/demo.ts"], forbidden: [], outOfScope: [] },
      verification: [{ command: "pnpm test", status: "passed", durationMs: 1 }],
      attempts: [publishingAttempt()],
      cursorSummary: "done",
    }, publishingAttempt());

    expect(mocks.git).toHaveBeenCalledWith(
      "/worktree",
      "read-tree",
      candidateTree,
    );
    expect(mocks.git).not.toHaveBeenCalledWith(
      "/worktree",
      "add",
      "-A",
    );
    expect(mocks.git).toHaveBeenCalledWith(
      "/worktree",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "push.gpgSign=false",
      "push",
      `--force-with-lease=refs/heads/feature/existing:${approved.target.base_sha}`,
      "origin",
      `${candidateHead}:refs/heads/feature/existing`,
    );
    expect(mocks.git).toHaveBeenCalledWith(
      "/worktree",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Codex Cursor Bridge",
      "-c",
      "user.email=codex-cursor-bridge@example.invalid",
      "commit",
      "--no-gpg-sign",
      "-m",
      `chore(cursor): ${approved.title}`,
    );
    expect(mocks.git).toHaveBeenCalledWith(
      "/worktree",
      "remote",
      "get-url",
      "--push",
      "--all",
      "origin",
    );
  });

  it("rejects an ambiguous commit checkpoint whose HEAD is not a direct child of the approved base", async () => {
    const approved = task({ mode: "existing_pr", number: 7 });
    const candidateTree = "e".repeat(40);
    const candidateHead = "d".repeat(40);
    const unrelatedParent = "f".repeat(40);
    const attempt = publishingAttempt();
    let remoteReads = 0;
    vi.mocked(store.get).mockReturnValue({ currentAttemptId: attempt.id } as never);
    vi.mocked(store.getAttempt).mockReturnValue(attempt);
    vi.mocked(store.beginEffect).mockImplementation((_jobId, _attemptId, kind, key) =>
      durableEffect(kind, key));
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") return candidateTree;
      if (args[0] === "rev-parse") return candidateHead;
      if (args[0] === "cat-file") {
        return `tree ${candidateTree}\nparent ${unrelatedParent}\nauthor Untrusted <untrusted@example.com> 0 +0000\ncommitter Untrusted <untrusted@example.com> 0 +0000\n\nuntrusted`;
      }
      if (args[0] === "remote") return "git@github.com:owner/repo.git";
      if (args[0] === "ls-remote") {
        remoteReads += 1;
        const sha = remoteReads === 1 ? approved.target.base_sha : candidateHead;
        return `${sha}\trefs/heads/feature/existing`;
      }
      return "";
    });
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        baseRefName: approved.target.destination_ref,
        headRefName: "feature/existing",
        headRefOid: candidateHead,
        headRepository: { nameWithOwner: "owner/repo" },
        url: "https://github.com/owner/repo/pull/7",
        isDraft: true,
      }),
      stderr: "",
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.publish({
      worktree: "/worktree",
      baseSha: approved.target.base_sha,
      pushBranch: "feature/existing",
      localBranch: "codex/cursor/task-demo-followup-job",
    }, approved, repository, publicationInput(candidateTree), attempt))
      .rejects.toThrow(/direct child|parent/i);

    expect(mocks.git.mock.calls.some(([, ...args]) => args.includes("push"))).toBe(false);
  });

  it("does not let a reclaimed worker continue publication with the replacement lease", async () => {
    const approved = task({ mode: "existing_pr", number: 7 });
    const attempt = publishingAttempt();
    vi.mocked(store.get).mockReturnValue({ currentAttemptId: attempt.id } as never);
    vi.mocked(store.getAttempt).mockReturnValue({
      ...attempt,
      workerToken: "replacement-worker",
    });
    vi.mocked(store.assertActiveAttempt).mockImplementation(() => {
      throw new Error("Publication lease was lost");
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.publish({
      worktree: "/worktree",
      baseSha: approved.target.base_sha,
      pushBranch: "feature/existing",
      localBranch: "codex/cursor/task-demo-followup-job",
    }, approved, repository, publicationInput(), attempt)).rejects.toThrow(/lease/i);

    expect(mocks.git).not.toHaveBeenCalled();
  });

  it("rejects a PR readback whose head branch is not the published branch", async () => {
    const approved = task({ mode: "existing_pr", number: 7 });
    const attempt = publishingAttempt();
    const candidateHead = "d".repeat(40);
    let remoteReads = 0;
    vi.mocked(store.get).mockReturnValue({ currentAttemptId: attempt.id } as never);
    vi.mocked(store.getAttempt).mockReturnValue(attempt);
    vi.mocked(store.beginEffect).mockImplementation((_jobId, _attemptId, kind, key) =>
      durableEffect(kind, key));
    vi.mocked(store.completeEffect).mockImplementation((_effectId, payload) => ({
      ...durableEffect("completed", "completed"),
      status: "COMPLETED",
      payload,
    }));
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "remote") return "git@github.com:owner/repo.git";
      if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") return "e".repeat(40);
      if (args[0] === "rev-parse") return candidateHead;
      if (args[0] === "cat-file") {
        return rawCommit("e".repeat(40), approved.target.base_sha);
      }
      if (args[0] === "ls-remote") {
        remoteReads += 1;
        const sha = remoteReads === 1 ? approved.target.base_sha : candidateHead;
        return `${sha}\trefs/heads/feature/existing`;
      }
      return "";
    });
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/other",
        headRefOid: candidateHead,
        headRepository: { nameWithOwner: "owner/repo" },
        url: "https://github.com/owner/repo/pull/7",
        isDraft: true,
      }),
      stderr: "",
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.publish({
      worktree: "/worktree",
      baseSha: approved.target.base_sha,
      pushBranch: "feature/existing",
      localBranch: "codex/cursor/task-demo-followup-job",
    }, approved, repository, publicationInput(), attempt)).rejects.toThrow(/head branch/i);
  });

  it("rejects a final PR readback that is no longer open", async () => {
    const approved = task({ mode: "new_draft" });
    const attempt = publishingAttempt();
    const candidateHead = "d".repeat(40);
    let remoteReads = 0;
    vi.mocked(store.get).mockReturnValue({ currentAttemptId: attempt.id } as never);
    vi.mocked(store.getAttempt).mockReturnValue(attempt);
    vi.mocked(store.beginEffect).mockImplementation((_jobId, _attemptId, kind, key) =>
      durableEffect(kind, key));
    vi.mocked(store.completeEffect).mockImplementation((_effectId, payload) => ({
      ...durableEffect("completed", "completed"),
      status: "COMPLETED",
      payload,
    }));
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "remote") return "git@github.com:owner/repo.git";
      if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") return "e".repeat(40);
      if (args[0] === "rev-parse") return candidateHead;
      if (args[0] === "cat-file") {
        return rawCommit("e".repeat(40), approved.target.base_sha);
      }
      if (args[0] === "ls-remote") {
        remoteReads += 1;
        return remoteReads === 1
          ? ""
          : `${candidateHead}\trefs/heads/codex/cursor/task-demo`;
      }
      return "";
    });
    mocks.runFile.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify([{ url: "https://github.com/owner/repo/pull/9" }]),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          state: "CLOSED",
          url: "https://github.com/owner/repo/pull/9",
          isDraft: true,
          baseRefName: "main",
          headRefName: "codex/cursor/task-demo",
          headRefOid: candidateHead,
          headRepository: { nameWithOwner: "owner/repo" },
        }),
        stderr: "",
      };
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.publish({
      worktree: "/worktree",
      baseSha: approved.target.base_sha,
      pushBranch: "codex/cursor/task-demo",
      localBranch: "codex/cursor/task-demo",
    }, approved, repository, publicationInput(), attempt)).rejects.toThrow(/open/i);
  });

  it("reconciles an ambiguous push error when remote readback has the candidate", async () => {
    const approved = task({ mode: "existing_pr", number: 7 });
    const attempt = publishingAttempt();
    const candidateHead = "d".repeat(40);
    let remoteReads = 0;
    vi.mocked(store.get).mockReturnValue({ currentAttemptId: attempt.id } as never);
    vi.mocked(store.getAttempt).mockReturnValue(attempt);
    vi.mocked(store.beginEffect).mockImplementation((_jobId, _attemptId, kind, key) =>
      durableEffect(kind, key));
    vi.mocked(store.completeEffect).mockImplementation((_effectId, payload) => ({
      ...durableEffect("completed", "completed"),
      status: "COMPLETED",
      payload,
    }));
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "remote") return "git@github.com:owner/repo.git";
      if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") return "e".repeat(40);
      if (args[0] === "rev-parse") return candidateHead;
      if (args[0] === "cat-file") {
        return rawCommit("e".repeat(40), approved.target.base_sha);
      }
      if (args[0] === "ls-remote") {
        remoteReads += 1;
        const sha = remoteReads === 1 ? approved.target.base_sha : candidateHead;
        return `${sha}\trefs/heads/feature/existing`;
      }
      if (args.includes("push")) throw new Error("connection closed after send");
      return "";
    });
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify({
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/existing",
        headRefOid: candidateHead,
        headRepository: { nameWithOwner: "owner/repo" },
        url: "https://github.com/owner/repo/pull/7",
        isDraft: true,
      }),
      stderr: "",
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.publish({
      worktree: "/worktree",
      baseSha: approved.target.base_sha,
      pushBranch: "feature/existing",
      localBranch: "codex/cursor/task-demo-followup-job",
    }, approved, repository, publicationInput(), attempt)).resolves.toMatchObject({
      headSha: candidateHead,
      remoteHeadSha: candidateHead,
    });
  });

  it("reconciles an ambiguous PR creation error using exact readback", async () => {
    const approved = task({ mode: "new_draft" });
    const attempt = publishingAttempt();
    const candidateHead = "d".repeat(40);
    const prUrl = "https://github.com/owner/repo/pull/9";
    let remoteReads = 0;
    let listReads = 0;
    vi.mocked(store.get).mockReturnValue({ currentAttemptId: attempt.id } as never);
    vi.mocked(store.getAttempt).mockReturnValue(attempt);
    vi.mocked(store.beginEffect).mockImplementation((_jobId, _attemptId, kind, key) =>
      durableEffect(kind, key));
    vi.mocked(store.completeEffect).mockImplementation((_effectId, payload) => ({
      ...durableEffect("completed", "completed"),
      status: "COMPLETED",
      payload,
    }));
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "remote") return "git@github.com:owner/repo.git";
      if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") return "e".repeat(40);
      if (args[0] === "rev-parse") return candidateHead;
      if (args[0] === "cat-file") {
        return rawCommit("e".repeat(40), approved.target.base_sha);
      }
      if (args[0] === "ls-remote") {
        remoteReads += 1;
        return remoteReads === 1
          ? ""
          : `${candidateHead}\trefs/heads/codex/cursor/task-demo`;
      }
      return "";
    });
    mocks.runFile.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args[1] === "list") {
        listReads += 1;
        return {
          stdout: JSON.stringify(listReads === 1 ? [] : [{ url: prUrl }]),
          stderr: "",
        };
      }
      if (args[1] === "create") throw new Error("connection closed after PR creation");
      return {
        stdout: JSON.stringify({
          state: "OPEN",
          url: prUrl,
          isDraft: true,
          baseRefName: "main",
          headRefName: "codex/cursor/task-demo",
          headRefOid: candidateHead,
          headRepository: { nameWithOwner: "owner/repo" },
        }),
        stderr: "",
      };
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.publish({
      worktree: "/worktree",
      baseSha: approved.target.base_sha,
      pushBranch: "codex/cursor/task-demo",
      localBranch: "codex/cursor/task-demo",
    }, approved, repository, publicationInput(), attempt)).resolves.toMatchObject({
      prUrl,
      isDraft: true,
    });
    expect(listReads).toBe(2);
  });

  it("does not start a duplicate run when a finished run lacks a persisted outcome", async () => {
    sdkMocks.getRun.mockResolvedValue({
      id: "run",
      agentId: "agent",
      status: "finished",
      requestId: "request",
      result: "Implementation finished without submitting the outcome tool.",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, task({ mode: "new_draft" }), attempt);

    expect(outcome).toMatchObject({
      status: "needs_input",
      agentId: "agent",
      runId: "run",
      requestId: "request",
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(outcome.summary).toMatch(/finished without submitting/i);
    expect(sdkMocks.create).not.toHaveBeenCalled();
    expect(sdkMocks.resume).not.toHaveBeenCalled();
  });

  it("stops a lingering run and restores its already persisted structured outcome", async () => {
    sdkMocks.getRun
      .mockResolvedValueOnce({
        id: "run",
        agentId: "agent",
        status: "running",
      })
      .mockResolvedValueOnce({
        id: "run",
        agentId: "agent",
        status: "cancelled",
        requestId: "request",
        usage: { inputTokens: 10, outputTokens: 20 },
      });
    sdkMocks.cancelRun.mockResolvedValue(undefined);
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
      outcome: "completed" as const,
      outcomeSummary: "Persisted final outcome",
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, task({ mode: "new_draft" }), attempt);

    expect(outcome).toMatchObject({
      status: "completed",
      summary: "Persisted final outcome",
      agentId: "agent",
      runId: "run",
      requestId: "request",
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(sdkMocks.cancelRun).toHaveBeenCalledOnce();
    expect(sdkMocks.resume).not.toHaveBeenCalled();
    expect(sdkMocks.create).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous durable-outcome cancellation after terminal readback", async () => {
    sdkMocks.getRun
      .mockResolvedValueOnce({
        id: "run",
        agentId: "agent",
        status: "running",
      })
      .mockResolvedValueOnce({
        id: "run",
        agentId: "agent",
        status: "finished",
        result: "done",
      });
    sdkMocks.cancelRun.mockRejectedValue(new Error("connection closed after cancellation"));
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
      outcome: "completed" as const,
      outcomeSummary: "Persisted final outcome",
    };

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, task({ mode: "new_draft" }), attempt)).resolves.toMatchObject({
      status: "completed",
      summary: "Persisted final outcome",
    });
    expect(sdkMocks.getRun).toHaveBeenCalledTimes(2);
    expect(sdkMocks.resume).not.toHaveBeenCalled();
  });

  it("restores a terminal Cursor error instead of starting a follow-up run", async () => {
    sdkMocks.getRun.mockResolvedValue({
      id: "run",
      agentId: "agent",
      status: "error",
      error: { message: "Cursor model failed" },
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
    };

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, task({ mode: "new_draft" }), attempt)).rejects.toThrow(/model failed/i);
    expect(sdkMocks.create).not.toHaveBeenCalled();
    expect(sdkMocks.resume).not.toHaveBeenCalled();
  });

  it("fails closed when the prior run cannot be read instead of forcing a duplicate", async () => {
    sdkMocks.getRun.mockRejectedValue(new Error("local run store is temporarily unavailable"));
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
    };

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, task({ mode: "new_draft" }), attempt)).rejects.toThrow(/safely recover/i);

    expect(sdkMocks.resume).not.toHaveBeenCalled();
    expect(sdkMocks.create).not.toHaveBeenCalled();
  });

  it("creates diagnostic logs with owner-only permissions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-log-"));
    const logPath = path.join(directory, "job.log");
    vi.mocked(store.get).mockReturnValue({ logPath } as Job);
    sdkMocks.getRun.mockRejectedValue(new Error("local run store is unavailable"));
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
    };

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, task({ mode: "new_draft" }), attempt)).rejects.toThrow(/safely recover/i);

    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });

  it("redacts a structured Cursor outcome before persisting it", async () => {
    const dispose = vi.fn(async () => undefined);
    sdkMocks.create.mockImplementation(async (options: {
      local?: {
        customTools?: Record<string, { execute: (args: Record<string, string>) => unknown }>;
        settingSources?: string[];
        sandboxOptions?: { enabled: boolean };
      };
    }) => {
      expect(options.local).toMatchObject({
        settingSources: [],
        sandboxOptions: { enabled: true },
      });
      const submit = options.local?.customTools?.submit_bridge_outcome;
      return {
        agentId: "agent",
        send: vi.fn(async () => {
          submit?.execute({
            status: "completed",
            summary: "Implemented with token: abcdefghijklmnopqrstuvwxyz",
          });
          return {
            id: "run",
            agentId: "agent",
            status: "running",
            async *stream(): AsyncGenerator<never, void> { /* No events. */ },
            wait: vi.fn(async () => ({
              id: "run",
              agentId: "agent",
              status: "finished",
              result: "done",
            })),
          };
        }),
        [Symbol.asyncDispose]: dispose,
      };
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, task({ mode: "new_draft" }), attempt);

    expect(outcome.summary).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(store.updateAttempt).toHaveBeenCalledWith(
      attempt.id,
      attempt.workerToken,
      expect.objectContaining({ outcomeSummary: "Implemented with token: [REDACTED]" }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("includes redacted verifier diagnostics in a failure report", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-report-"));
    const reportPaths = {
      ...paths,
      home: directory,
      reportsDir: path.join(directory, "reports"),
    };
    const adapter = new RealWorkflowAdapter(reportPaths, config, store, "job");
    const job: Job = {
      id: "job",
      repositoryAlias: "demo",
      taskId: "TASK-DEMO",
      specVersion: 2,
      specHash: `sha256:${"a".repeat(64)}`,
      taskCommitSha: "b".repeat(40),
      taskBlobSha: "c".repeat(40),
      targetOrigin: "owner/repo",
      targetBaseSha: "d".repeat(40),
      policyVersion: 2,
      maxAttempts: 2,
      status: "FAILED",
      createdAt: now,
      updatedAt: now,
    };

    const report = await adapter.writeReport({
      job,
      task: task({ mode: "new_draft" }),
      verification: [{
        command: "pnpm test",
        status: "failed",
        durationMs: 10,
        output: "failing assertion\napi_key=super-secret-value",
      }],
      error: "Verification failed with token: another-secret-value",
    });
    const content = await readFile(report, "utf8");

    expect(content).toContain("failing assertion");
    expect(content).not.toContain("super-secret-value");
    expect(content).not.toContain("another-secret-value");
  });

  it("does not confirm cancellation while the persisted Cursor run is still active", async () => {
    sdkMocks.cancelRun.mockResolvedValue(undefined);
    sdkMocks.getRun.mockResolvedValue({
      id: "run",
      agentId: "agent",
      status: "running",
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.cancel({
      ...publishingAttempt(),
      status: "IMPLEMENTING",
      cursorAgentId: "agent",
      cursorRunId: "run",
      worktree: "/worktree",
    })).rejects.toThrow(/still active/i);
  });

  it("treats an already terminal persisted run as stopped without cancelling it again", async () => {
    sdkMocks.getRun.mockResolvedValue({
      id: "run",
      agentId: "agent",
      status: "finished",
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await adapter.cancel({
      ...publishingAttempt(),
      status: "VERIFYING",
      cursorAgentId: "agent",
      cursorRunId: "run",
      worktree: "/worktree",
    });

    expect(sdkMocks.cancelRun).not.toHaveBeenCalled();
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
