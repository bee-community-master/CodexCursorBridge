import type { RepositoryConfig } from "./config.js";
import type { CandidateTree, CollectedChanges } from "./git.js";
import {
  terminalJobStatuses,
  type Attempt,
  type ClaimedWork,
  type Job,
  type JobStore,
} from "./state.js";
import type { ApprovedTask } from "./task.js";
import { assessChanges, type ChangeAssessment } from "./verification.js";

export interface PreparedWorktree {
  worktree: string;
  baseSha: string;
  pushBranch: string;
  localBranch: string;
}

export interface ImplementerOutcome {
  status: "completed" | "blocked" | "needs_input";
  agentId: string;
  runId: string;
  requestId?: string;
  summary: string;
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface VerificationResult {
  command: string;
  status: "passed" | "failed";
  durationMs: number;
  output?: string;
}

export interface PublicationInput {
  tree: CandidateTree;
  initialChanges: CollectedChanges;
  finalChanges: CollectedChanges;
  assessment: ChangeAssessment;
  verification: VerificationResult[];
  attempts: Attempt[];
  cursorSummary: string;
}

export interface PublicationResult {
  prUrl: string;
  headSha: string;
  remoteHeadSha: string;
  treeHash: string;
  isDraft: boolean;
}

export interface AttestationData extends PublicationInput {
  job: Job;
  task: ApprovedTask;
  publication: PublicationResult;
}

export interface WorkflowReportData {
  job: Job;
  task: ApprovedTask;
  changes?: CollectedChanges;
  initialChanges?: CollectedChanges;
  assessment?: ChangeAssessment;
  verification?: VerificationResult[];
  attempts?: Attempt[];
  cursorSummary?: string;
  publication?: PublicationResult;
  error?: string;
}

export interface WorkflowAdapter {
  prepare(job: Job, task: ApprovedTask, repository: RepositoryConfig): Promise<PreparedWorktree>;
  runImplementer(
    worktree: PreparedWorktree,
    task: ApprovedTask,
    attempt: Attempt,
    repairFeedback?: string,
  ): Promise<ImplementerOutcome>;
  collectChanges(worktree: PreparedWorktree): Promise<CollectedChanges>;
  runVerification(worktree: PreparedWorktree, task: ApprovedTask): Promise<VerificationResult[]>;
  computeCandidateTree(worktree: PreparedWorktree): Promise<CandidateTree>;
  publish(
    worktree: PreparedWorktree,
    task: ApprovedTask,
    repository: RepositoryConfig,
    input: PublicationInput,
  ): Promise<PublicationResult>;
  writeAttestation(data: AttestationData): Promise<string>;
  writeReport(data: WorkflowReportData): Promise<string>;
  cleanup(worktree: PreparedWorktree, repository: RepositoryConfig): Promise<void>;
  cancel(attempt: Attempt): Promise<void>;
}

const leaseMs = 60_000;

function assessmentFor(task: ApprovedTask, changes: CollectedChanges): ChangeAssessment {
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

function verificationFailure(results: readonly VerificationResult[]): VerificationResult | undefined {
  return results.find((result) => result.status === "failed");
}

function repairFeedback(failure: VerificationResult): string {
  return [
    "Independent verification failed. Repair only the evidenced failure and stay within the approved scope.",
    `Command: ${failure.command}`,
    `Output:\n${failure.output ?? "No verifier output was captured."}`,
  ].join("\n\n");
}

async function persistReport(
  store: JobStore,
  adapter: WorkflowAdapter,
  data: WorkflowReportData,
): Promise<void> {
  const reportPath = await adapter.writeReport(data);
  store.update(data.job.id, { reportPath });
}

async function confirmCancellationIfRequested(
  store: JobStore,
  adapter: WorkflowAdapter,
  claim: ClaimedWork,
  attempt: Attempt,
): Promise<boolean> {
  if (!store.isCancellationRequested(claim.job.id)) return false;
  await adapter.cancel(attempt);
  store.confirmCancellation(claim.job.id, attempt.id, attempt.workerToken);
  return true;
}

export async function executeWorkflow(
  store: JobStore,
  claim: ClaimedWork,
  task: ApprovedTask,
  repository: RepositoryConfig,
  adapter: WorkflowAdapter,
): Promise<void> {
  const jobId = claim.job.id;
  let attempt = claim.attempt;
  let prepared: PreparedWorktree | undefined;
  let initialChanges: CollectedChanges | undefined;
  let finalChanges: CollectedChanges | undefined;
  let assessment: ChangeAssessment | undefined;
  let verification: VerificationResult[] | undefined;
  let cursorSummary: string | undefined;

  try {
    if (await confirmCancellationIfRequested(store, adapter, claim, attempt)) return;

    prepared = await adapter.prepare(store.get(jobId) ?? claim.job, task, repository);
    if (attempt.status === "PREPARING") {
      attempt = store.transitionAttempt(
        attempt.id,
        attempt.workerToken,
        ["PREPARING"],
        "IMPLEMENTING",
        { worktree: prepared.worktree, baseSha: prepared.baseSha },
      );
    } else {
      attempt = store.updateAttempt(attempt.id, attempt.workerToken, {
        worktree: prepared.worktree,
        baseSha: prepared.baseSha,
      });
    }

    let feedback: string | undefined;
    for (;;) {
      if (attempt.status === "REPAIRING") {
        attempt = store.transitionAttempt(
          attempt.id,
          attempt.workerToken,
          ["REPAIRING"],
          "IMPLEMENTING",
        );
      }
      if (await confirmCancellationIfRequested(store, adapter, claim, attempt)) return;

      if (attempt.status === "IMPLEMENTING") {
        const outcome = await adapter.runImplementer(prepared, task, attempt, feedback);
        cursorSummary = outcome.summary;
        const outcomeFields: Partial<Attempt> = {
          cursorAgentId: outcome.agentId,
          cursorRunId: outcome.runId,
          ...(outcome.requestId ? { cursorRequestId: outcome.requestId } : {}),
          outcome: outcome.status,
          outcomeSummary: outcome.summary,
          ...(outcome.reason ? { outcomeReason: outcome.reason } : {}),
          ...(outcome.inputTokens === undefined ? {} : { inputTokens: outcome.inputTokens }),
          ...(outcome.outputTokens === undefined ? {} : { outputTokens: outcome.outputTokens }),
        };
        if (outcome.status !== "completed") {
          attempt = store.transitionAttempt(
            attempt.id,
            attempt.workerToken,
            ["IMPLEMENTING"],
            "BLOCKED",
            outcomeFields,
          );
          await persistReport(store, adapter, {
            job: store.get(jobId)!,
            task,
            attempts: store.listAttempts(jobId),
            cursorSummary,
            error: outcome.reason ?? outcome.summary,
          });
          return;
        }

        attempt = store.transitionAttempt(
          attempt.id,
          attempt.workerToken,
          ["IMPLEMENTING"],
          "VERIFYING",
          outcomeFields,
        );
      }
      if (await confirmCancellationIfRequested(store, adapter, claim, attempt)) return;

      if (attempt.status !== "VERIFYING" && attempt.status !== "PUBLISHING") {
        throw new Error(`Cannot resume workflow from attempt state ${attempt.status}`);
      }
      initialChanges = await adapter.collectChanges(prepared);
      assessment = assessmentFor(task, initialChanges);
      if (!assessment.ok) {
        attempt = store.transitionAttempt(
          attempt.id,
          attempt.workerToken,
          [attempt.status],
          "SCOPE_VIOLATION",
          { errorMessage: assessment.reasons.join("; ") },
        );
        await persistReport(store, adapter, {
          job: store.get(jobId)!,
          task,
          changes: initialChanges,
          assessment,
          attempts: store.listAttempts(jobId),
          ...(cursorSummary ? { cursorSummary } : {}),
        });
        return;
      }

      verification = await adapter.runVerification(prepared, task);
      const failure = verificationFailure(verification);
      if (!failure) break;
      if (attempt.status === "PUBLISHING" || attempt.ordinal >= claim.job.maxAttempts) {
        const message = `Verification failed: ${failure.command}`;
        attempt = store.transitionAttempt(
          attempt.id,
          attempt.workerToken,
          [attempt.status],
          "FAILED",
          { errorMessage: message },
        );
        await persistReport(store, adapter, {
          job: store.get(jobId)!,
          task,
          changes: initialChanges,
          assessment,
          verification,
          attempts: store.listAttempts(jobId),
          ...(cursorSummary ? { cursorSummary } : {}),
          error: message,
        });
        return;
      }
      feedback = repairFeedback(failure);
      attempt = store.beginRepairAttempt(jobId, attempt.id, attempt.workerToken, leaseMs);
    }

    if (await confirmCancellationIfRequested(store, adapter, claim, attempt)) return;
    finalChanges = await adapter.collectChanges(prepared);
    assessment = assessmentFor(task, finalChanges);
    if (!assessment.ok) {
      attempt = store.transitionAttempt(
        attempt.id,
        attempt.workerToken,
        [attempt.status],
        "SCOPE_VIOLATION",
        { errorMessage: assessment.reasons.join("; ") },
      );
      await persistReport(store, adapter, {
        job: store.get(jobId)!,
        task,
        changes: finalChanges,
        initialChanges,
        assessment,
        ...(verification ? { verification } : {}),
        attempts: store.listAttempts(jobId),
        ...(cursorSummary ? { cursorSummary } : {}),
      });
      return;
    }

    const tree = await adapter.computeCandidateTree(prepared);
    attempt = attempt.status === "PUBLISHING"
      ? store.updateAttempt(attempt.id, attempt.workerToken, { treeHash: tree.treeHash })
      : store.transitionAttempt(
        attempt.id,
        attempt.workerToken,
        ["VERIFYING"],
        "PUBLISHING",
        { treeHash: tree.treeHash },
      );
    if (await confirmCancellationIfRequested(store, adapter, claim, attempt)) return;

    const publicationInput: PublicationInput = {
      tree,
      initialChanges,
      finalChanges,
      assessment,
      verification: verification ?? [],
      attempts: store.listAttempts(jobId),
      cursorSummary: cursorSummary ?? "",
    };
    const publication = await adapter.publish(prepared, task, repository, publicationInput);
    if (publication.treeHash !== tree.treeHash || publication.remoteHeadSha !== publication.headSha) {
      throw new Error("Published Git readback does not match the attested candidate");
    }
    if (task.pull_request.mode === "new_draft" && !publication.isDraft) {
      throw new Error("New pull request was not created as a draft");
    }
    store.update(jobId, {
      prUrl: publication.prUrl,
      headSha: publication.headSha,
      treeHash: tree.treeHash,
    });

    const attestationPath = await adapter.writeAttestation({
      job: store.get(jobId)!,
      task,
      publication,
      ...publicationInput,
    });
    const projectedDeliveredJob: Job = {
      ...store.get(jobId)!,
      status: "DELIVERED_REVIEW_REQUIRED",
      prUrl: publication.prUrl,
      headSha: publication.headSha,
      treeHash: tree.treeHash,
    };
    const reportPath = await adapter.writeReport({
      job: projectedDeliveredJob,
      task,
      changes: finalChanges,
      initialChanges,
      assessment,
      verification: publicationInput.verification,
      attempts: store.listAttempts(jobId),
      cursorSummary: publicationInput.cursorSummary,
      publication,
    });
    attempt = store.transitionAttempt(
      attempt.id,
      attempt.workerToken,
      ["PUBLISHING"],
      "COMPLETED",
      { headSha: publication.headSha, treeHash: tree.treeHash },
    );
    store.transitionJob(jobId, ["PUBLISHING"], "DELIVERED_REVIEW_REQUIRED", {
      prUrl: publication.prUrl,
      headSha: publication.headSha,
      treeHash: tree.treeHash,
      attestationPath,
      reportPath,
      deliveredAt: new Date().toISOString(),
    });

    try {
      await adapter.cleanup(prepared, repository);
      store.update(jobId, { cleanupStatus: "COMPLETED" });
      store.recordEvent(jobId, attempt.id, "CLEANUP_COMPLETED", {});
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      store.update(jobId, { cleanupStatus: "FAILED", cleanupError: message });
      store.recordEvent(jobId, attempt.id, "CLEANUP_FAILED", { error: message });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const currentJob = store.get(jobId);
    const currentAttempt = store.getAttempt(attempt.id);
    if (currentJob?.status === "CANCEL_REQUESTED" && currentAttempt) {
      try {
        await adapter.cancel(currentAttempt);
      } finally {
        store.confirmCancellation(jobId, currentAttempt.id, currentAttempt.workerToken);
      }
      return;
    }
    if (currentAttempt && !["COMPLETED", "BLOCKED", "FAILED", "CANCELLED", "SCOPE_VIOLATION"].includes(currentAttempt.status)) {
      try {
        store.transitionAttempt(
          currentAttempt.id,
          currentAttempt.workerToken,
          [currentAttempt.status],
          "FAILED",
          { errorMessage: message },
        );
      } catch {
        // The original failure remains authoritative if a concurrent transition won.
      }
    } else if (currentJob && !terminalJobStatuses.has(currentJob.status)) {
      try {
        store.transitionJob(jobId, [currentJob.status], "FAILED", { errorMessage: message });
      } catch {
        // The original failure remains authoritative if a concurrent transition won.
      }
    }
    const reportJob = store.get(jobId);
    if (reportJob) {
      try {
        const reportChanges = finalChanges ?? initialChanges;
        await persistReport(store, adapter, {
          job: reportJob,
          task,
          ...(reportChanges ? { changes: reportChanges } : {}),
          ...(initialChanges ? { initialChanges } : {}),
          ...(assessment ? { assessment } : {}),
          ...(verification ? { verification } : {}),
          attempts: store.listAttempts(jobId),
          ...(cursorSummary ? { cursorSummary } : {}),
          error: message,
        });
      } catch {
        // The primary job error remains authoritative if report persistence also fails.
      }
    }
  }
}
