import type { RepositoryConfig } from "../domain/configuration.js";
import {
  terminalJobStatuses,
  type Attempt,
  type ClaimedWork,
  type Job,
} from "../domain/job.js";
import type { ApprovedTask } from "../domain/task.js";
import { assessChanges, type ChangeAssessment } from "./change-assessment.js";
import { safeErrorMessage } from "./redaction.js";
import type {
  CandidateTree,
  CollectedChanges,
  PreparedWorktree,
  PublicationInput,
  VerificationResult,
  WorkflowAdapter,
  WorkflowReportData,
  WorkflowStatePort,
} from "./workflow-ports.js";

export type {
  AttestationData,
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
  WorktreeIdentity,
} from "./workflow-ports.js";

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

export async function executeWorkflow(
  store: WorkflowStatePort,
  claim: ClaimedWork,
  task: ApprovedTask,
  repository: RepositoryConfig,
  adapter: WorkflowAdapter,
): Promise<void> {
  const jobId = claim.job.id;
  const workerToken = claim.attempt.workerToken;
  let attempt = claim.attempt;
  let prepared: PreparedWorktree | undefined;
  let initialChanges: CollectedChanges | undefined;
  let finalChanges: CollectedChanges | undefined;
  let assessment: ChangeAssessment | undefined;
  let verification: VerificationResult[] | undefined;
  let cursorSummary = attempt.outcomeSummary;
  let tree: CandidateTree | undefined;

  try {
    if (await confirmCancellationIfRequested(store, adapter, claim, attempt)) return;
    store.assertActiveAttempt(
      jobId,
      attempt.id,
      attempt.workerToken,
      attempt.status,
    );

    prepared = await adapter.prepare(store.get(jobId) ?? claim.job, task, repository);
    const preparedGitConfigDigest = prepared.gitIdentity?.configDigest;
    if (
      attempt.gitConfigDigest
      && attempt.gitConfigDigest !== preparedGitConfigDigest
    ) {
      throw new Error(
        "STALE_SPEC: prepared worktree Git configuration identity changed",
      );
    }
    attempt = store.updateAttempt(attempt.id, attempt.workerToken, {
      worktree: prepared.worktree,
      baseSha: prepared.baseSha,
      ...(preparedGitConfigDigest
        ? { gitConfigDigest: preparedGitConfigDigest }
        : {}),
    });
    if (await confirmCancellationIfRequested(store, adapter, claim, attempt)) return;
    if (attempt.status === "PREPARING") {
      attempt = store.transitionAttempt(
        attempt.id,
        attempt.workerToken,
        ["PREPARING"],
        "IMPLEMENTING",
      );
    }

    let feedback = attempt.ordinal > 1 ? attempt.errorMessage : undefined;
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
            {
              ...outcomeFields,
              errorMessage: safeErrorMessage(outcome.reason ?? outcome.summary),
            },
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

      const treeBeforeVerification = await adapter.computeCandidateTree(prepared);
      verification = await adapter.runVerification(prepared, task);
      if (await confirmCancellationIfRequested(store, adapter, claim, attempt)) return;
      const treeAfterVerification = await adapter.computeCandidateTree(prepared);
      finalChanges = await adapter.collectChanges(prepared, treeAfterVerification);
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
          verification,
          attempts: store.listAttempts(jobId),
          ...(cursorSummary ? { cursorSummary } : {}),
        });
        return;
      }
      if (treeBeforeVerification.treeHash !== treeAfterVerification.treeHash) {
        verification = [
          ...verification,
          {
            command: "candidate-tree-stability",
            status: "failed",
            durationMs: 0,
            output: [
              "Candidate tree changed during independent verification.",
              `Before: ${treeBeforeVerification.treeHash}`,
              `After: ${treeAfterVerification.treeHash}`,
              "The verification evidence does not cover the candidate that would be published.",
            ].join("\n"),
          },
        ];
      }
      if (finalChanges.files.length === 0) {
        verification = [
          ...verification,
          {
            command: "candidate-change-presence",
            status: "failed",
            durationMs: 0,
            output: [
              "The completed implementation contains no changed files.",
              "A Draft PR cannot be delivered without a candidate change.",
            ].join("\n"),
          },
        ];
      }
      const failure = verificationFailure(verification);
      if (!failure) {
        tree = treeAfterVerification;
        break;
      }
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
          changes: finalChanges,
          initialChanges,
          assessment,
          verification,
          attempts: store.listAttempts(jobId),
          ...(cursorSummary ? { cursorSummary } : {}),
          error: message,
        });
        return;
      }
      feedback = repairFeedback(failure);
      attempt = store.beginRepairAttempt(
        jobId,
        attempt.id,
        attempt.workerToken,
        leaseMs,
        feedback,
      );
    }

    if (!tree || !initialChanges || !finalChanges || !assessment || !verification) {
      throw new Error("Verified publication inputs are incomplete");
    }
    if (await confirmCancellationIfRequested(store, adapter, claim, attempt)) return;
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
    const publication = await adapter.publish(
      prepared,
      task,
      repository,
      publicationInput,
      attempt,
    );
    if (publication.treeHash !== tree.treeHash || publication.remoteHeadSha !== publication.headSha) {
      throw new Error("Published Git readback does not match the attested candidate");
    }
    if (!publication.isDraft) {
      throw new Error("Pull request is not a draft");
    }
    const publishedTreeHash = tree.treeHash;
    store.recordPublication(jobId, attempt.id, attempt.workerToken, {
      prUrl: publication.prUrl,
      headSha: publication.headSha,
      treeHash: publishedTreeHash,
    });

    const projectedAttempts = store.listAttempts(jobId).map((item) =>
      item.id === attempt.id
        ? {
          ...item,
          status: "COMPLETED" as const,
          headSha: publication.headSha,
          treeHash: publishedTreeHash,
        }
        : item,
    );
    const projectedDeliveredJob: Job = {
      ...store.get(jobId)!,
      status: "DELIVERED_REVIEW_REQUIRED",
      prUrl: publication.prUrl,
      headSha: publication.headSha,
      treeHash: publishedTreeHash,
    };
    const attestationPath = await adapter.writeAttestation({
      job: projectedDeliveredJob,
      task,
      publication,
      ...publicationInput,
      attempts: projectedAttempts,
    });
    const reportPath = await adapter.writeReport({
      job: projectedDeliveredJob,
      task,
      changes: finalChanges,
      initialChanges,
      assessment,
      verification: publicationInput.verification,
      attempts: projectedAttempts,
      cursorSummary: publicationInput.cursorSummary,
      publication,
    });
    store.completeDelivery(jobId, attempt.id, attempt.workerToken, {
      prUrl: publication.prUrl,
      headSha: publication.headSha,
      treeHash: publishedTreeHash,
      attestationPath,
      reportPath,
      deliveredAt: new Date().toISOString(),
    });
    attempt = store.getAttempt(attempt.id)!;

    try {
      await adapter.cleanup(prepared, repository);
      store.update(jobId, { cleanupStatus: "COMPLETED" });
      store.recordEvent(jobId, attempt.id, "CLEANUP_COMPLETED", {});
    } catch (cleanupError) {
      const message = safeErrorMessage(cleanupError);
      store.update(jobId, { cleanupStatus: "FAILED", cleanupError: message });
      store.recordEvent(jobId, attempt.id, "CLEANUP_FAILED", { error: message });
    }
  } catch (error) {
    const message = safeErrorMessage(error);
    const staleSpec = message.startsWith("STALE_SPEC:");
    const currentJob = store.get(jobId);
    const currentAttempt = store.getAttempt(attempt.id);
    if (currentAttempt && currentAttempt.workerToken !== workerToken) return;
    if (currentJob?.status === "CANCEL_REQUESTED" && currentAttempt) {
      try {
        await adapter.cancel(currentAttempt);
        store.confirmCancellation(jobId, currentAttempt.id, workerToken);
      } catch (cancellationError) {
        store.recordEvent(jobId, currentAttempt.id, "CANCELLATION_CONFIRMATION_FAILED", {
          error: safeErrorMessage(cancellationError),
        });
      }
      return;
    }
    const publicationNeedsFinalization = currentJob?.status === "PUBLISHING"
      && currentAttempt?.status === "PUBLISHING"
      && currentJob.prUrl !== undefined
      && currentJob.headSha !== undefined
      && currentJob.treeHash !== undefined;
    if (publicationNeedsFinalization && currentAttempt) {
      store.recordEvent(jobId, currentAttempt.id, "DELIVERY_FINALIZATION_DEFERRED", {
        error: message,
      });
      return;
    } else if (currentAttempt && !["COMPLETED", "BLOCKED", "FAILED", "CANCELLED", "SCOPE_VIOLATION"].includes(currentAttempt.status)) {
      try {
        if (staleSpec) {
          store.failStaleSpec(
            jobId,
            currentAttempt.id,
            workerToken,
            message,
          );
        } else {
          store.transitionAttempt(
            currentAttempt.id,
            workerToken,
            [currentAttempt.status],
            "FAILED",
            { errorMessage: message },
          );
        }
      } catch {
        return;
      }
    } else if (currentJob && !terminalJobStatuses.has(currentJob.status)) {
      try {
        store.transitionJob(
          jobId,
          [currentJob.status],
          staleSpec ? "STALE_SPEC" : "FAILED",
          { errorMessage: message },
        );
      } catch {
        return;
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
