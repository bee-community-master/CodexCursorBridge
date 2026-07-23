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

type WorktreeGitIdentity = Awaited<ReturnType<typeof captureWorktreeIdentity>>;
type WorktreeBranchNames = ReturnType<typeof branchNames>;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
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
    if (job.id !== this.#jobId) {
      throw new Error("Worktree request does not match the adapter job scope");
    }
    const worktree = path.join(this.#paths.worktreesDir, task.repository, job.id);
    await mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
    const existingGitIdentity = await this.#readExistingIdentity(
      worktree,
      task,
      repository,
    );

    await git(repository.root, "fetch", "--prune", "origin");
    const existingPr = await this.#pullRequests.readExisting(task, repository);
    const names = branchNames(task, job.id, existingPr?.headRefName);
    this.#assertApprovedPullRequestHead(existingPr?.headRefOid, task, names);

    if (existingGitIdentity) {
      return this.#resumeExistingWorktree(worktree, task, names, existingGitIdentity);
    }

    await this.#addWorktree(worktree, task, repository, names);
    this.#store.update(this.#jobId, {
      worktree,
      baseSha: task.target.base_sha,
    });
    const gitIdentity = await captureWorktreeIdentity(worktree, repository.root);
    await this.#guard.assertPreparedHead(worktree, task.target.base_sha);
    await this.#logger.log(`Prepared worktree ${worktree} from ${task.target.base_sha}`);
    return { worktree, baseSha: task.target.base_sha, gitIdentity, ...names };
  }

  async #readExistingIdentity(
    worktree: string,
    task: ApprovedTask,
    repository: RepositoryConfig,
  ): Promise<WorktreeGitIdentity | undefined> {
    if (!await pathExists(worktree)) return undefined;

    this.#store.update(this.#jobId, {
      worktree,
      baseSha: task.target.base_sha,
    });
    const identity = await captureWorktreeIdentity(worktree, repository.root);
    const currentJob = this.#store.get(this.#jobId);
    const currentAttempt = currentJob?.currentAttemptId
      ? this.#store.getAttempt(currentJob.currentAttemptId)
      : undefined;
    if (
      currentAttempt?.gitConfigDigest
      && currentAttempt.gitConfigDigest !== identity.configDigest
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
    return identity;
  }

  #assertApprovedPullRequestHead(
    currentHead: string | undefined,
    task: ApprovedTask,
    names: WorktreeBranchNames,
  ): void {
    if (
      currentHead
      && currentHead !== task.target.base_sha
      && !this.#guard.hasDurableEffect(
        "git_push",
        `push:${this.#jobId}:${names.pushBranch}:${currentHead}`,
      )
    ) {
      throw new Error("STALE_SPEC: existing PR head changed after task approval");
    }
  }

  async #resumeExistingWorktree(
    worktree: string,
    task: ApprovedTask,
    names: WorktreeBranchNames,
    gitIdentity: WorktreeGitIdentity,
  ): Promise<PreparedWorktree> {
    const prepared = {
      worktree,
      baseSha: task.target.base_sha,
      pushBranch: names.pushBranch,
      localBranch: names.localBranch,
      gitIdentity,
    };
    await this.#guard.assertPreparedWorktree(prepared);
    await this.#guard.assertPreparedHead(worktree, task.target.base_sha);
    return prepared;
  }

  async #addWorktree(
    worktree: string,
    task: ApprovedTask,
    repository: RepositoryConfig,
    names: WorktreeBranchNames,
  ): Promise<void> {
    const branchRef = `refs/heads/${names.localBranch}`;
    const matchingRef = await git(
      repository.root,
      "for-each-ref",
      "--format=%(refname)",
      branchRef,
    );
    if (matchingRef === branchRef) {
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
