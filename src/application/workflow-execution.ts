import type { RepositoryConfig } from "../domain/configuration.js";
import type {
  Attempt,
  ClaimedWork,
  Job,
} from "../domain/job.js";
import type { ApprovedTask } from "../domain/task.js";
import { assessChanges, type ChangeAssessment } from "./change-assessment.js";
import { safeErrorMessage } from "./redaction.js";
import { handleWorkflowFailure } from "./workflow-failure-handler.js";
import type {
  CandidateTree,
  CollectedChanges,
  ImplementerOutcome,
  PreparedWorktree,
  PublicationInput,
  PublicationResult,
  VerificationResult,
  WorkflowAdapter,
  WorkflowReportData,
  WorkflowStatePort,
} from "./workflow-ports.js";

const leaseMs = 60_000;

type CandidateReview =
  | { kind: "stopped" }
  | { kind: "verified" }
  | { kind: "failed"; failure: VerificationResult };

type ExecutionReport = Omit<
  WorkflowReportData,
  "attempts" | "job" | "task"
>;

interface ReviewedCandidate {
  initialChanges: CollectedChanges;
  finalChanges: CollectedChanges;
  assessment: ChangeAssessment;
  verification: VerificationResult[];
}

interface VerifiedCandidate extends ReviewedCandidate {
  tree: CandidateTree;
}

function assessmentFor(
  task: ApprovedTask,
  changes: CollectedChanges,
): ChangeAssessment {
  return assessChanges({
    files: changes.files,
    deletedFiles: changes.deletedFiles,
    diffLines: changes.diffLines,
    allowedPatterns: task.allowed_paths,
    forbiddenPatterns: task.forbidden_paths,
    maxChangedFiles: task.limits.max_changed_files,
    maxDiffLines: task.limits.max_diff_lines,
    allowTestDeletion: task.limits.allow_test_deletion,
  });
}

function verificationFailure(
  results: readonly VerificationResult[],
): VerificationResult | undefined {
  return results.find((result) => result.status === "failed");
}

function repairFeedback(failure: VerificationResult): string {
  return [
    "Independent verification failed. Repair only the evidenced failure and stay within the approved scope.",
    `Command: ${failure.command}`,
    `Output:\n${failure.output ?? "No verifier output was captured."}`,
  ].join("\n\n");
}

function implementerOutcomeFields(
  outcome: ImplementerOutcome,
): Partial<Attempt> {
  return {
    cursorAgentId: outcome.agentId,
    cursorRunId: outcome.runId,
    ...(outcome.requestId ? { cursorRequestId: outcome.requestId } : {}),
    outcome: outcome.status,
    outcomeSummary: outcome.summary,
    ...(outcome.reason ? { outcomeReason: outcome.reason } : {}),
    ...(outcome.inputTokens === undefined
      ? {}
      : { inputTokens: outcome.inputTokens }),
    ...(outcome.outputTokens === undefined
      ? {}
      : { outputTokens: outcome.outputTokens }),
  };
}

function candidateTreeStabilityFailure(
  before: CandidateTree,
  after: CandidateTree,
): VerificationResult {
  return {
    command: "candidate-tree-stability",
    status: "failed",
    durationMs: 0,
    output: [
      "Candidate tree changed during independent verification.",
      `Before: ${before.treeHash}`,
      `After: ${after.treeHash}`,
      "The verification evidence does not cover the candidate that would be published.",
    ].join("\n"),
  };
}

function candidateChangePresenceFailure(): VerificationResult {
  return {
    command: "candidate-change-presence",
    status: "failed",
    durationMs: 0,
    output: [
      "The completed implementation contains no changed files.",
      "A Draft PR cannot be delivered without a candidate change.",
    ].join("\n"),
  };
}

async function persistReport(
  store: WorkflowStatePort,
  adapter: WorkflowAdapter,
  data: WorkflowReportData,
): Promise<void> {
  const reportPath = await adapter.writeReport(data);
  store.update(data.job.id, { reportPath });
}

async function confirmCancellationIfRequested(
  store: WorkflowStatePort,
  adapter: WorkflowAdapter,
  claim: ClaimedWork,
  attempt: Attempt,
): Promise<boolean> {
  if (!store.isCancellationRequested(claim.job.id)) return false;
  await adapter.cancel(attempt);
  store.confirmCancellation(claim.job.id, attempt.id, attempt.workerToken);
  return true;
}

class WorkflowExecution {
  readonly #store: WorkflowStatePort;
  readonly #claim: ClaimedWork;
  readonly #task: ApprovedTask;
  readonly #repository: RepositoryConfig;
  readonly #adapter: WorkflowAdapter;
  readonly #jobId: string;
  #attempt: Attempt;
  #prepared?: PreparedWorktree;
  #initialChanges?: CollectedChanges;
  #finalChanges?: CollectedChanges;
  #assessment?: ChangeAssessment;
  #verification?: VerificationResult[];
  #cursorSummary: string | undefined;
  #tree?: CandidateTree;

  constructor(
    store: WorkflowStatePort,
    claim: ClaimedWork,
    task: ApprovedTask,
    repository: RepositoryConfig,
    adapter: WorkflowAdapter,
  ) {
    this.#store = store;
    this.#claim = claim;
    this.#task = task;
    this.#repository = repository;
    this.#adapter = adapter;
    this.#jobId = claim.job.id;
    this.#attempt = claim.attempt;
    this.#cursorSummary = claim.attempt.outcomeSummary;
  }

  async run(): Promise<void> {
    try {
      if (!await this.#prepare()) return;
      if (!await this.#implementAndVerify()) return;
      if (!await this.#publish()) return;
      await this.#cleanup();
    } catch (error) {
      await handleWorkflowFailure({
        store: this.#store,
        adapter: this.#adapter,
        jobId: this.#jobId,
        workerToken: this.#claim.attempt.workerToken,
        attempt: this.#attempt,
        task: this.#task,
        ...(this.#initialChanges
          ? { initialChanges: this.#initialChanges }
          : {}),
        ...(this.#finalChanges
          ? { finalChanges: this.#finalChanges }
          : {}),
        ...(this.#assessment ? { assessment: this.#assessment } : {}),
        ...(this.#verification
          ? { verification: this.#verification }
          : {}),
        ...(this.#cursorSummary
          ? { cursorSummary: this.#cursorSummary }
          : {}),
      }, error);
    }
  }

  async #prepare(): Promise<boolean> {
    if (await this.#confirmCancellation()) return false;
    this.#store.assertActiveAttempt(
      this.#jobId,
      this.#attempt.id,
      this.#attempt.workerToken,
      this.#attempt.status,
    );

    const prepared = await this.#adapter.prepare(
      this.#store.get(this.#jobId) ?? this.#claim.job,
      this.#task,
      this.#repository,
    );
    this.#prepared = prepared;
    const preparedGitConfigDigest = prepared.gitIdentity?.configDigest;
    if (
      this.#attempt.gitConfigDigest
      && this.#attempt.gitConfigDigest !== preparedGitConfigDigest
    ) {
      throw new Error(
        "STALE_SPEC: prepared worktree Git configuration identity changed",
      );
    }
    this.#attempt = this.#store.updateAttempt(
      this.#attempt.id,
      this.#attempt.workerToken,
      {
        worktree: prepared.worktree,
        baseSha: prepared.baseSha,
        ...(preparedGitConfigDigest
          ? { gitConfigDigest: preparedGitConfigDigest }
          : {}),
      },
    );
    if (await this.#confirmCancellation()) return false;
    if (this.#attempt.status === "PREPARING") {
      this.#attempt = this.#store.transitionAttempt(
        this.#attempt.id,
        this.#attempt.workerToken,
        ["PREPARING"],
        "IMPLEMENTING",
      );
    }
    return true;
  }

  async #implementAndVerify(): Promise<boolean> {
    let feedback = this.#attempt.ordinal > 1
      ? this.#attempt.errorMessage
      : undefined;
    for (;;) {
      if (this.#attempt.status === "REPAIRING") {
        this.#attempt = this.#store.transitionAttempt(
          this.#attempt.id,
          this.#attempt.workerToken,
          ["REPAIRING"],
          "IMPLEMENTING",
        );
      }
      if (await this.#confirmCancellation()) return false;

      if (
        this.#attempt.status === "IMPLEMENTING"
        && !await this.#runImplementer(feedback)
      ) {
        return false;
      }
      if (await this.#confirmCancellation()) return false;
      if (
        this.#attempt.status !== "VERIFYING"
        && this.#attempt.status !== "PUBLISHING"
      ) {
        throw new Error(
          `Cannot resume workflow from attempt state ${this.#attempt.status}`,
        );
      }

      const review = await this.#reviewCandidate();
      if (review.kind === "stopped") return false;
      if (review.kind === "verified") return true;
      if (
        this.#attempt.status === "PUBLISHING"
        || this.#attempt.ordinal >= this.#claim.job.maxAttempts
      ) {
        await this.#failVerification(review.failure);
        return false;
      }
      feedback = repairFeedback(review.failure);
      this.#attempt = this.#store.beginRepairAttempt(
        this.#jobId,
        this.#attempt.id,
        this.#attempt.workerToken,
        leaseMs,
        feedback,
      );
    }
  }

  async #runImplementer(feedback?: string): Promise<boolean> {
    const outcome = await this.#adapter.runImplementer(
      this.#preparedWorktree(),
      this.#task,
      this.#attempt,
      feedback,
    );
    this.#cursorSummary = outcome.summary;
    const outcomeFields = implementerOutcomeFields(outcome);
    if (outcome.status !== "completed") {
      this.#attempt = this.#store.transitionAttempt(
        this.#attempt.id,
        this.#attempt.workerToken,
        ["IMPLEMENTING"],
        "BLOCKED",
        {
          ...outcomeFields,
          errorMessage: safeErrorMessage(outcome.reason ?? outcome.summary),
        },
      );
      await this.#writeExecutionReport({
        cursorSummary: outcome.summary,
        error: outcome.reason ?? outcome.summary,
      });
      return false;
    }

    this.#attempt = this.#store.transitionAttempt(
      this.#attempt.id,
      this.#attempt.workerToken,
      ["IMPLEMENTING"],
      "VERIFYING",
      outcomeFields,
    );
    return true;
  }

  async #reviewCandidate(): Promise<CandidateReview> {
    const prepared = this.#preparedWorktree();
    this.#initialChanges = await this.#adapter.collectChanges(prepared);
    this.#assessment = assessmentFor(this.#task, this.#initialChanges);
    if (!this.#assessment.ok) {
      await this.#recordScopeViolation(this.#initialChanges, false);
      return { kind: "stopped" };
    }

    const treeBeforeVerification = await this.#adapter.computeCandidateTree(
      prepared,
    );
    this.#verification = await this.#adapter.runVerification(
      prepared,
      this.#task,
    );
    if (await this.#confirmCancellation()) return { kind: "stopped" };

    const treeAfterVerification = await this.#adapter.computeCandidateTree(
      prepared,
    );
    this.#finalChanges = await this.#adapter.collectChanges(
      prepared,
      treeAfterVerification,
    );
    this.#assessment = assessmentFor(this.#task, this.#finalChanges);
    if (!this.#assessment.ok) {
      await this.#recordScopeViolation(this.#finalChanges, true);
      return { kind: "stopped" };
    }

    if (treeBeforeVerification.treeHash !== treeAfterVerification.treeHash) {
      this.#verification.push(candidateTreeStabilityFailure(
        treeBeforeVerification,
        treeAfterVerification,
      ));
    }
    if (this.#finalChanges.files.length === 0) {
      this.#verification.push(candidateChangePresenceFailure());
    }
    const failure = verificationFailure(this.#verification);
    if (failure) return { kind: "failed", failure };

    this.#tree = treeAfterVerification;
    return { kind: "verified" };
  }

  async #recordScopeViolation(
    changes: CollectedChanges,
    includeVerificationContext: boolean,
  ): Promise<void> {
    const assessment = this.#requiredAssessment();
    this.#attempt = this.#store.transitionAttempt(
      this.#attempt.id,
      this.#attempt.workerToken,
      [this.#attempt.status],
      "SCOPE_VIOLATION",
      { errorMessage: assessment.reasons.join("; ") },
    );
    await this.#writeExecutionReport({
      changes,
      assessment,
      ...(includeVerificationContext && this.#initialChanges
        ? { initialChanges: this.#initialChanges }
        : {}),
      ...(includeVerificationContext && this.#verification
        ? { verification: this.#verification }
        : {}),
      ...(this.#cursorSummary
        ? { cursorSummary: this.#cursorSummary }
        : {}),
    });
  }

  async #failVerification(failure: VerificationResult): Promise<void> {
    const message = `Verification failed: ${failure.command}`;
    this.#attempt = this.#store.transitionAttempt(
      this.#attempt.id,
      this.#attempt.workerToken,
      [this.#attempt.status],
      "FAILED",
      { errorMessage: message },
    );
    const context = this.#reviewedCandidate();
    await this.#writeExecutionReport({
      changes: context.finalChanges,
      initialChanges: context.initialChanges,
      assessment: context.assessment,
      verification: context.verification,
      ...(this.#cursorSummary
        ? { cursorSummary: this.#cursorSummary }
        : {}),
      error: message,
    });
  }

  async #publish(): Promise<boolean> {
    const prepared = this.#preparedWorktree();
    const candidate = this.#verifiedCandidate();
    if (await this.#confirmCancellation()) return false;
    this.#beginPublishing(candidate.tree.treeHash);
    if (await this.#confirmCancellation()) return false;

    const publicationInput = this.#publicationInput(candidate);
    const publication = await this.#adapter.publish(
      prepared,
      this.#task,
      this.#repository,
      publicationInput,
      this.#attempt,
    );
    this.#assertPublicationMatchesCandidate(publication, candidate.tree);
    await this.#completeDelivery(candidate, publicationInput, publication);
    this.#attempt = this.#currentAttempt();
    return true;
  }

  #beginPublishing(treeHash: string): void {
    this.#attempt = this.#attempt.status === "PUBLISHING"
      ? this.#store.updateAttempt(
        this.#attempt.id,
        this.#attempt.workerToken,
        { treeHash },
      )
      : this.#store.transitionAttempt(
        this.#attempt.id,
        this.#attempt.workerToken,
        ["VERIFYING"],
        "PUBLISHING",
        { treeHash },
      );
  }

  #publicationInput(candidate: VerifiedCandidate): PublicationInput {
    return {
      ...candidate,
      attempts: this.#store.listAttempts(this.#jobId),
      cursorSummary: this.#cursorSummary ?? "",
    };
  }

  #assertPublicationMatchesCandidate(
    publication: PublicationResult,
    tree: CandidateTree,
  ): void {
    if (
      publication.treeHash !== tree.treeHash
      || publication.remoteHeadSha !== publication.headSha
    ) {
      throw new Error(
        "Published Git readback does not match the attested candidate",
      );
    }
    if (!publication.isDraft) throw new Error("Pull request is not a draft");
  }

  async #completeDelivery(
    candidate: VerifiedCandidate,
    publicationInput: PublicationInput,
    publication: PublicationResult,
  ): Promise<void> {
    const publishedTreeHash = candidate.tree.treeHash;
    this.#store.recordPublication(
      this.#jobId,
      this.#attempt.id,
      this.#attempt.workerToken,
      {
        prUrl: publication.prUrl,
        headSha: publication.headSha,
        treeHash: publishedTreeHash,
      },
    );
    const projectedAttempts = this.#store.listAttempts(this.#jobId).map(
      (attempt) => attempt.id === this.#attempt.id
        ? {
          ...attempt,
          status: "COMPLETED" as const,
          headSha: publication.headSha,
          treeHash: publishedTreeHash,
        }
        : attempt,
    );
    const projectedDeliveredJob: Job = {
      ...this.#currentJob(),
      status: "DELIVERED_REVIEW_REQUIRED",
      prUrl: publication.prUrl,
      headSha: publication.headSha,
      treeHash: publishedTreeHash,
    };
    const attestationPath = await this.#adapter.writeAttestation({
      job: projectedDeliveredJob,
      task: this.#task,
      publication,
      ...publicationInput,
      attempts: projectedAttempts,
    });
    const reportPath = await this.#adapter.writeReport({
      job: projectedDeliveredJob,
      task: this.#task,
      changes: candidate.finalChanges,
      initialChanges: candidate.initialChanges,
      assessment: candidate.assessment,
      verification: candidate.verification,
      attempts: projectedAttempts,
      cursorSummary: publicationInput.cursorSummary,
      publication,
    });
    this.#store.completeDelivery(
      this.#jobId,
      this.#attempt.id,
      this.#attempt.workerToken,
      {
        prUrl: publication.prUrl,
        headSha: publication.headSha,
        treeHash: publishedTreeHash,
        attestationPath,
        reportPath,
        deliveredAt: new Date().toISOString(),
      },
    );
  }

  async #cleanup(): Promise<void> {
    try {
      await this.#adapter.cleanup(
        this.#preparedWorktree(),
        this.#repository,
      );
      this.#store.update(this.#jobId, { cleanupStatus: "COMPLETED" });
      this.#store.recordEvent(
        this.#jobId,
        this.#attempt.id,
        "CLEANUP_COMPLETED",
        {},
      );
    } catch (error) {
      const message = safeErrorMessage(error);
      this.#store.update(this.#jobId, {
        cleanupStatus: "FAILED",
        cleanupError: message,
      });
      this.#store.recordEvent(
        this.#jobId,
        this.#attempt.id,
        "CLEANUP_FAILED",
        { error: message },
      );
    }
  }

  async #writeExecutionReport(data: ExecutionReport): Promise<void> {
    await persistReport(this.#store, this.#adapter, {
      job: this.#currentJob(),
      task: this.#task,
      attempts: this.#store.listAttempts(this.#jobId),
      ...data,
    });
  }

  async #confirmCancellation(): Promise<boolean> {
    return confirmCancellationIfRequested(
      this.#store,
      this.#adapter,
      this.#claim,
      this.#attempt,
    );
  }

  #currentJob(): Job {
    const job = this.#store.get(this.#jobId);
    if (!job) throw new Error(`Workflow job disappeared: ${this.#jobId}`);
    return job;
  }

  #currentAttempt(): Attempt {
    const attempt = this.#store.getAttempt(this.#attempt.id);
    if (!attempt) {
      throw new Error(`Workflow attempt disappeared: ${this.#attempt.id}`);
    }
    return attempt;
  }

  #preparedWorktree(): PreparedWorktree {
    if (!this.#prepared) {
      throw new Error("Workflow worktree preparation is incomplete");
    }
    return this.#prepared;
  }

  #requiredAssessment(): ChangeAssessment {
    if (!this.#assessment) {
      throw new Error("Workflow change assessment is incomplete");
    }
    return this.#assessment;
  }

  #reviewedCandidate(): ReviewedCandidate {
    if (
      !this.#initialChanges
      || !this.#finalChanges
      || !this.#assessment
      || !this.#verification
    ) {
      throw new Error("Workflow candidate review is incomplete");
    }
    return {
      initialChanges: this.#initialChanges,
      finalChanges: this.#finalChanges,
      assessment: this.#assessment,
      verification: this.#verification,
    };
  }

  #verifiedCandidate(): VerifiedCandidate {
    if (!this.#tree) {
      throw new Error("Verified publication tree is incomplete");
    }
    return {
      ...this.#reviewedCandidate(),
      tree: this.#tree,
    };
  }
}

export async function executeWorkflow(
  store: WorkflowStatePort,
  claim: ClaimedWork,
  task: ApprovedTask,
  repository: RepositoryConfig,
  adapter: WorkflowAdapter,
): Promise<void> {
  await new WorkflowExecution(
    store,
    claim,
    task,
    repository,
    adapter,
  ).run();
}
