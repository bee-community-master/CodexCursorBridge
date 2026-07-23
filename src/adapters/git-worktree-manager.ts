import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  CandidateTree,
  CollectedChanges,
  PreparedWorktree,
  PublicationStatePort,
} from "../application/workflow-ports.js";
import type {
  RepositoryConfig,
  RuntimePaths,
} from "../domain/configuration.js";
import type { ApprovedTask } from "../domain/task.js";
import {
  collectChanges,
  collectTreeChanges,
  computeCandidateTree,
} from "./git-candidate.js";
import { git } from "./git-runtime.js";
import { captureWorktreeIdentity } from "./git-worktree-identity.js";
import type { GitHubPullRequestAdapter } from "./github-pull-request.js";
import type { PreparedWorktreeGuard } from "./prepared-worktree-guard.js";
import type { WorkflowLogger } from "./workflow-logger.js";

type WorktreeStatePort = Pick<
  PublicationStatePort,
  "get" | "getAttempt" | "update"
>;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function branchNames(task: ApprovedTask, jobId: string, existingHead?: string): {
  pushBranch: string;
  localBranch: string;
} {
  const suffix = `${task.id.toLowerCase()}-${slug(task.title)}-v${task.spec_version}-${jobId.slice(0, 8)}`;
  const pushBranch = task.pull_request.mode === "new_draft"
    ? `codex/cursor/${suffix}`
    : existingHead ?? "";
  if (!pushBranch) throw new Error("Existing PR head branch is missing");
  return {
    pushBranch,
    localBranch: task.pull_request.mode === "new_draft"
      ? pushBranch
      : `codex/cursor/${task.id.toLowerCase()}-followup-${jobId.slice(0, 8)}`,
  };
}

export class GitWorktreeManager {
  readonly #paths: RuntimePaths;
  readonly #store: WorktreeStatePort;
  readonly #jobId: string;
  readonly #guard: PreparedWorktreeGuard;
  readonly #pullRequests: GitHubPullRequestAdapter;
  readonly #logger: WorkflowLogger;

  constructor(
    paths: RuntimePaths,
    store: WorktreeStatePort,
    jobId: string,
    guard: PreparedWorktreeGuard,
    pullRequests: GitHubPullRequestAdapter,
    logger: WorkflowLogger,
  ) {
    this.#paths = paths;
    this.#store = store;
    this.#jobId = jobId;
    this.#guard = guard;
    this.#pullRequests = pullRequests;
    this.#logger = logger;
  }

  async prepare(
    job: { id: string },
    task: ApprovedTask,
    repository: RepositoryConfig,
  ): Promise<PreparedWorktree> {
    const worktree = path.join(this.#paths.worktreesDir, task.repository, job.id);
    await mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
    let existingWorktree = false;
    try {
      await access(worktree);
      existingWorktree = true;
    } catch {
      // The first execution has no durable worktree yet.
    }

    let existingGitIdentity: Awaited<ReturnType<typeof captureWorktreeIdentity>> | undefined;
    if (existingWorktree) {
      this.#store.update(this.#jobId, {
        worktree,
        baseSha: task.target.base_sha,
      });
      existingGitIdentity = await captureWorktreeIdentity(worktree, repository.root);
      const currentJob = this.#store.get(this.#jobId);
      const currentAttempt = currentJob?.currentAttemptId
        ? this.#store.getAttempt(currentJob.currentAttemptId)
        : undefined;
      if (
        currentAttempt?.gitConfigDigest
        && currentAttempt.gitConfigDigest !== existingGitIdentity.configDigest
      ) {
        throw new Error("STALE_SPEC: prepared worktree Git configuration identity changed");
      }
      if (
        currentAttempt
        && currentAttempt.status !== "PREPARING"
        && !currentAttempt.gitConfigDigest
      ) {
        throw new Error("STALE_SPEC: prepared worktree Git configuration identity is missing");
      }
    }

    await git(repository.root, "fetch", "--prune", "origin");
    const existingPr = await this.#pullRequests.readExisting(task, repository);
    const names = branchNames(task, job.id, existingPr?.headRefName);
    if (
      existingPr?.headRefOid
      && existingPr.headRefOid !== task.target.base_sha
      && !this.#guard.hasDurableEffect(
        "git_push",
        `push:${this.#jobId}:${names.pushBranch}:${existingPr.headRefOid}`,
      )
    ) {
      throw new Error("STALE_SPEC: existing PR head changed after task approval");
    }

    if (existingGitIdentity) {
      await this.#guard.assertPreparedWorktree({
        worktree,
        baseSha: task.target.base_sha,
        pushBranch: names.pushBranch,
        localBranch: names.localBranch,
        gitIdentity: existingGitIdentity,
      });
      await this.#guard.assertPreparedHead(worktree, task.target.base_sha);
      return {
        worktree,
        baseSha: task.target.base_sha,
        pushBranch: names.pushBranch,
        localBranch: names.localBranch,
        gitIdentity: existingGitIdentity,
      };
    }

    let localBranchExists = false;
    try {
      await git(repository.root, "show-ref", "--verify", `refs/heads/${names.localBranch}`);
      localBranchExists = true;
    } catch {
      // A new job normally has no local branch yet.
    }
    if (localBranchExists) {
      await git(
        repository.root,
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        worktree,
        names.localBranch,
      );
    } else {
      await git(
        repository.root,
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "-b",
        names.localBranch,
        worktree,
        task.target.base_sha,
      );
    }
    this.#store.update(this.#jobId, {
      worktree,
      baseSha: task.target.base_sha,
    });
    const gitIdentity = await captureWorktreeIdentity(worktree, repository.root);
    await this.#guard.assertPreparedHead(worktree, task.target.base_sha);
    await this.#logger.log(`Prepared worktree ${worktree} from ${task.target.base_sha}`);
    return { worktree, baseSha: task.target.base_sha, gitIdentity, ...names };
  }

  async collectChanges(
    prepared: PreparedWorktree,
    candidate?: CandidateTree,
  ): Promise<CollectedChanges> {
    await this.#guard.assertPreparedWorktree(prepared);
    return candidate
      ? collectTreeChanges(prepared.worktree, prepared.baseSha, candidate.treeHash)
      : collectChanges(prepared.worktree, prepared.baseSha);
  }

  async computeCandidateTree(prepared: PreparedWorktree): Promise<CandidateTree> {
    await this.#guard.assertPreparedWorktree(prepared);
    const candidate = await computeCandidateTree(prepared.worktree, prepared.baseSha);
    const currentHead = await git(prepared.worktree, "rev-parse", "HEAD");
    if (
      currentHead !== prepared.baseSha
      && !await this.#guard.isBridgeOwnedHead(
        prepared.worktree,
        currentHead,
        prepared.baseSha,
      )
    ) {
      throw new Error("Implementer changed HEAD; only bridge-owned commits may be published");
    }
    return candidate;
  }

  async cleanup(
    prepared: PreparedWorktree,
    repository: RepositoryConfig,
  ): Promise<void> {
    await this.#guard.assertPreparedWorktree(prepared);
    await git(repository.root, "worktree", "remove", prepared.worktree);
    await git(repository.root, "branch", "-D", prepared.localBranch);
  }
}
