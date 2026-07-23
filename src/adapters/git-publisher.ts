import type {
  PreparedWorktree,
  PublicationInput,
  PublicationResult,
  PublicationStatePort,
} from "../application/workflow-ports.js";
import type { RepositoryConfig } from "../domain/configuration.js";
import type { Attempt } from "../domain/job.js";
import type { ApprovedTask } from "../domain/task.js";
import { safeErrorMessage } from "../application/redaction.js";
import { git } from "./git-runtime.js";
import { assertGitHubRemote } from "./git-remote.js";
import type { GitHubPullRequestAdapter } from "./github-pull-request.js";
import type { PreparedWorktreeGuard } from "./prepared-worktree-guard.js";
import type { WorkflowLogger } from "./workflow-logger.js";

type PublicationEffectPort = Pick<
  PublicationStatePort,
  "beginEffect" | "completeEffect"
>;

export class GitPublisher {
  readonly #store: PublicationEffectPort;
  readonly #jobId: string;
  readonly #guard: PreparedWorktreeGuard;
  readonly #pullRequests: GitHubPullRequestAdapter;
  readonly #logger: WorkflowLogger;

  constructor(
    store: PublicationEffectPort,
    jobId: string,
    guard: PreparedWorktreeGuard,
    pullRequests: GitHubPullRequestAdapter,
    logger: WorkflowLogger,
  ) {
    this.#store = store;
    this.#jobId = jobId;
    this.#guard = guard;
    this.#pullRequests = pullRequests;
    this.#logger = logger;
  }

  async publish(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    repository: RepositoryConfig,
    input: PublicationInput,
    attempt: Attempt,
  ): Promise<PublicationResult> {
    await this.#guard.assertPreparedWorktree(prepared);
    this.#guard.assertPublicationLease(attempt);
    const headSha = await this.#commitCandidate(prepared, task, input, attempt);
    const remoteHeadSha = await this.#pushCandidate(prepared, task, headSha, attempt);
    const pullRequest = await this.#pullRequests.ensure(
      prepared,
      task,
      repository,
      input,
      attempt,
    );
    if (pullRequest.headRefOid !== headSha) {
      throw new Error("Pull request head readback does not match the published commit");
    }
    return {
      prUrl: pullRequest.url,
      headSha,
      remoteHeadSha,
      treeHash: input.tree.treeHash,
      isDraft: pullRequest.isDraft,
    };
  }

  async #commitCandidate(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    input: PublicationInput,
    attempt: Attempt,
  ): Promise<string> {
    await this.#guard.assertPreparedWorktree(prepared);
    this.#guard.assertPublicationLease(attempt);
    const key = `commit:${this.#jobId}:${input.tree.treeHash}`;
    const effect = this.#store.beginEffect(this.#jobId, attempt.id, "git_commit", key);
    const currentTree = await git(prepared.worktree, "rev-parse", "HEAD^{tree}");
    let headSha: string;
    if (currentTree === input.tree.treeHash) {
      headSha = await git(prepared.worktree, "rev-parse", "HEAD");
    } else {
      await git(prepared.worktree, "read-tree", input.tree.treeHash);
      const stagedTree = await git(prepared.worktree, "write-tree");
      if (stagedTree !== input.tree.treeHash) {
        throw new Error("Candidate tree changed between attestation and commit");
      }
      await git(
        prepared.worktree,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Codex Cursor Bridge",
        "-c",
        "user.email=codex-cursor-bridge@example.invalid",
        "commit",
        "--no-gpg-sign",
        "-m",
        `chore(cursor): ${task.title}`,
      );
      headSha = await git(prepared.worktree, "rev-parse", "HEAD");
    }
    const committedTree = await git(prepared.worktree, "rev-parse", "HEAD^{tree}");
    if (committedTree !== input.tree.treeHash) {
      throw new Error("Committed tree does not match the attested candidate");
    }
    await this.#guard.assertDirectChildOfApprovedBase(
      prepared.worktree,
      headSha,
      prepared.baseSha,
    );
    if (
      effect.status === "COMPLETED"
      && effect.payload?.headSha
      && effect.payload.headSha !== headSha
    ) {
      throw new Error("Completed commit checkpoint does not match local HEAD");
    }
    if (effect.status !== "COMPLETED") {
      this.#store.completeEffect(effect.id, { headSha, treeHash: input.tree.treeHash });
    }
    return headSha;
  }

  async #pushCandidate(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    headSha: string,
    attempt: Attempt,
  ): Promise<string> {
    await this.#guard.assertPreparedWorktree(prepared);
    this.#guard.assertPublicationLease(attempt);
    await assertGitHubRemote(prepared.worktree, task.target.origin);
    const key = `push:${this.#jobId}:${prepared.pushBranch}:${headSha}`;
    const effect = this.#store.beginEffect(this.#jobId, attempt.id, "git_push", key);
    const remoteBefore = await git(
      prepared.worktree,
      "ls-remote",
      "origin",
      `refs/heads/${prepared.pushBranch}`,
    );
    const existingSha = remoteBefore.split(/\s+/)[0] ?? "";
    const approvedRemoteSha = task.pull_request.mode === "existing_pr"
      ? task.target.base_sha
      : "";
    if (existingSha !== headSha && existingSha !== approvedRemoteSha) {
      throw new Error("STALE_SPEC: remote head changed after task approval");
    }
    let pushFailure: unknown;
    if (existingSha !== headSha) {
      try {
        await git(
          prepared.worktree,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "push.gpgSign=false",
          "push",
          `--force-with-lease=refs/heads/${prepared.pushBranch}:${approvedRemoteSha}`,
          "origin",
          `${headSha}:refs/heads/${prepared.pushBranch}`,
        );
      } catch (error) {
        pushFailure = error;
      }
    }
    const remoteAfter = await git(
      prepared.worktree,
      "ls-remote",
      "origin",
      `refs/heads/${prepared.pushBranch}`,
    );
    const remoteHeadSha = remoteAfter.split(/\s+/)[0] ?? "";
    if (remoteHeadSha !== headSha) {
      if (pushFailure) {
        throw new Error(
          `Git push failed and remote readback did not contain the candidate: ${safeErrorMessage(pushFailure)}`,
        );
      }
      throw new Error("Remote branch readback does not match local HEAD");
    }
    if (pushFailure) {
      await this.#logger.log(
        "Git push reported an error, but exact remote readback confirmed the candidate.",
      );
    }
    if (effect.status !== "COMPLETED") {
      this.#store.completeEffect(effect.id, { headSha, remoteHeadSha });
    }
    return remoteHeadSha;
  }
}
