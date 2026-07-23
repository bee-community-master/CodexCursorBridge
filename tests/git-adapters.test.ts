import { mkdir, rm, symlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { Job, JobStore } from "../src/state.js";
import {
  approvedTask as task,
  config,
  durableEffect,
  paths,
  publicationInput,
  publishingAttempt,
  rawCommit,
  repository,
} from "./helpers/workflow-fixtures.js";

const mocks = vi.hoisted(() => ({
  assertGitHubRemote: vi.fn(),
  assertWorktreeIdentity: vi.fn(),
  captureWorktreeIdentity: vi.fn(),
  git: vi.fn(),
  runFile: vi.fn(),
  collectChanges: vi.fn(),
  collectTreeChanges: vi.fn(),
  computeCandidateTree: vi.fn(),
}));

vi.mock("../src/git.js", () => mocks);
vi.mock("../src/adapters/command-runner.js", () => ({
  runFile: mocks.runFile,
}));
vi.mock("../src/adapters/git-candidate.js", () => ({
  collectChanges: mocks.collectChanges,
  collectTreeChanges: mocks.collectTreeChanges,
  computeCandidateTree: mocks.computeCandidateTree,
}));
vi.mock("../src/adapters/git-remote.js", () => ({
  assertGitHubRemote: mocks.assertGitHubRemote,
}));
vi.mock("../src/adapters/git-runtime.js", () => ({
  git: mocks.git,
}));
vi.mock("../src/adapters/git-worktree-identity.js", () => ({
  assertWorktreeIdentity: mocks.assertWorktreeIdentity,
  captureWorktreeIdentity: mocks.captureWorktreeIdentity,
}));
vi.mock("@cursor/sdk", () => ({
  Agent: {},
  Cursor: { models: {} },
  JsonlLocalAgentStore: class JsonlLocalAgentStore {},
}));

const { RealWorkflowAdapter } = await import("../src/real-adapter.js");

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
  mocks.collectTreeChanges.mockReset();
  mocks.computeCandidateTree.mockReset();
  vi.mocked(store.get).mockReset().mockReturnValue(undefined);
  vi.mocked(store.getAttempt).mockReset().mockReturnValue(undefined);
  vi.mocked(store.getEffect).mockReset().mockReturnValue(undefined);
  vi.mocked(store.assertActiveAttempt).mockReset();
  vi.mocked(store.beginEffect).mockReset();
  vi.mocked(store.completeEffect).mockReset();
  vi.mocked(store.update).mockReset();
  vi.mocked(store.updateAttempt).mockReset();
  await rm(paths.worktreesDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(paths.worktreesDir, { recursive: true, force: true });
});

describe("Git and GitHub adapters", () => {
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

  it("rejects a worktree request for a job outside the adapter scope", async () => {
    mocks.git.mockResolvedValue("");
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.prepare(
      { id: "different-job" },
      task({ mode: "new_draft" }),
      repository,
    )).rejects.toThrow(/adapter job scope/i);

    expect(mocks.git).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("creates a collision-resistant new draft branch", async () => {
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      return args[0] === "rev-parse" ? "b".repeat(40) : "";
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "12345678-abcd");
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

  it("propagates local branch lookup failures instead of treating them as a missing branch", async () => {
    mocks.git.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "for-each-ref") {
        throw new Error("Git reference database is unavailable");
      }
      return "";
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.prepare(
      { id: "job" },
      task({ mode: "new_draft" }),
      repository,
    )).rejects.toThrow(/reference database is unavailable/i);

    expect(mocks.git.mock.calls.some(([, ...args]) => args.includes("worktree"))).toBe(false);
  });

  it("propagates worktree access failures instead of treating them as a missing directory", async () => {
    const worktree = path.join(paths.worktreesDir, "demo", "job");
    await mkdir(path.dirname(worktree), { recursive: true });
    await symlink("job", worktree);
    mocks.git.mockResolvedValue("");
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.prepare(
      { id: "job" },
      task({ mode: "new_draft" }),
      repository,
    )).rejects.toMatchObject({ code: "ELOOP" });

    expect(mocks.git).not.toHaveBeenCalled();
  });

  it("records a newly created worktree before identity validation can fail", async () => {
    mocks.git.mockResolvedValue("");
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
      return args[0] === "rev-parse" ? "b".repeat(40) : "";
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "12345678-abcd");
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
    const adapter = new RealWorkflowAdapter(paths, config, store, "12345678-abcd");

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
    const adapter = new RealWorkflowAdapter(paths, config, store, "12345678-abcd");

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
      if (args[0] === "for-each-ref") {
        return "refs/heads/codex/cursor/task-demo-followup-job";
      }
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
