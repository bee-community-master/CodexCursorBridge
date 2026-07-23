import type {
  PreparedWorktree,
  PublicationStatePort,
} from "../application/workflow-ports.js";
import type { Attempt } from "../domain/job.js";
import { git } from "./git-runtime.js";
import { assertWorktreeIdentity } from "./git-worktree-identity.js";

type WorktreeGuardStatePort = Pick<
  PublicationStatePort,
  "assertActiveAttempt" | "getEffect"
>;

export class PreparedWorktreeGuard {
  readonly #store: WorktreeGuardStatePort;
  readonly #jobId: string;

  constructor(store: WorktreeGuardStatePort, jobId: string) {
    this.#store = store;
    this.#jobId = jobId;
  }

  hasDurableEffect(kind: string, idempotencyKey: string): boolean {
    const effect = this.#store.getEffect(idempotencyKey);
    return effect !== undefined
      && effect.jobId === this.#jobId
      && effect.kind === kind
      && effect.status !== "FAILED";
  }

  async assertDirectChildOfApprovedBase(
    worktree: string,
    headSha: string,
    approvedBaseSha: string,
  ): Promise<void> {
    const commit = await git(worktree, "cat-file", "-p", headSha);
    const header = commit.split("\n\n", 1)[0] ?? "";
    const parents = header
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice("parent ".length));
    if (parents.length !== 1 || parents[0] !== approvedBaseSha) {
      throw new Error(
        "Bridge publication commit is not a direct child of the approved base",
      );
    }
  }

  async isBridgeOwnedHead(
    worktree: string,
    headSha: string,
    approvedBaseSha: string,
  ): Promise<boolean> {
    const treeHash = await git(worktree, "rev-parse", "HEAD^{tree}");
    const effect = this.#store.getEffect(`commit:${this.#jobId}:${treeHash}`);
    const checkpointMatches = effect !== undefined
      && effect.jobId === this.#jobId
      && effect.kind === "git_commit"
      && effect.status !== "FAILED"
      && (
        effect.status !== "COMPLETED"
        || effect.payload?.headSha === undefined
        || effect.payload.headSha === headSha
      );
    if (!checkpointMatches) return false;
    await this.assertDirectChildOfApprovedBase(worktree, headSha, approvedBaseSha);
    return true;
  }

  async assertPreparedHead(worktree: string, approvedBaseSha: string): Promise<void> {
    const currentHead = await git(worktree, "rev-parse", "HEAD");
    if (
      currentHead !== approvedBaseSha
      && !await this.isBridgeOwnedHead(worktree, currentHead, approvedBaseSha)
    ) {
      throw new Error("STALE_SPEC: prepared worktree HEAD is not the approved base or a Bridge commit");
    }
  }

  assertPublicationLease(attempt: Attempt): void {
    this.#store.assertActiveAttempt(
      this.#jobId,
      attempt.id,
      attempt.workerToken,
      "PUBLISHING",
    );
  }

  async assertPreparedWorktree(prepared: PreparedWorktree): Promise<void> {
    if (!prepared.gitIdentity) return;
    await assertWorktreeIdentity(prepared.worktree, prepared.gitIdentity);
    const currentBranch = await git(
      prepared.worktree,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    );
    if (currentBranch !== prepared.localBranch) {
      throw new Error("Prepared worktree branch changed after preparation");
    }
  }
}
