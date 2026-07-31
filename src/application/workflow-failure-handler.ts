import {
  terminalAttemptStatuses,
  terminalJobStatuses,
  type Attempt,
  type Job,
} from "../domain/job.js";
import type { ApprovedTask } from "../domain/task.js";
import type { ChangeAssessment } from "./change-assessment.js";
import { safeErrorMessage } from "./redaction.js";
import type {
  CollectedChanges,
  VerificationResult,
  WorkflowAdapter,
  WorkflowStatePort,
} from "./workflow-ports.js";

export interface WorkflowFailureContext {
  store: WorkflowStatePort;
  adapter: WorkflowAdapter;
  jobId: string;
  workerToken: string;
  attempt: Attempt;
  task: ApprovedTask;
  initialChanges?: CollectedChanges;
  finalChanges?: CollectedChanges;
  assessment?: ChangeAssessment;
  verification?: VerificationResult[];
  cursorSummary?: string;
}

function publicationNeedsFinalization(
  job: Job | undefined,
  attempt: Attempt | undefined,
): attempt is Attempt {
  return job?.status === "PUBLISHING"
    && attempt?.status === "PUBLISHING"
    && job.prUrl !== undefined
    && job.headSha !== undefined
    && job.treeHash !== undefined;
}

function isUncertainCursorTransportFailure(message: string): boolean {
  return message.startsWith("CURSOR_TRANSPORT_UNCERTAIN:");
}

class WorkflowFailureHandler {
  readonly #context: WorkflowFailureContext;

  constructor(context: WorkflowFailureContext) {
    this.#context = context;
  }

  async handle(error: unknown): Promise<void> {
    const { store, jobId, attempt, workerToken } = this.#context;
    const message = safeErrorMessage(error);
    const currentJob = store.get(jobId);
    const currentAttempt = store.getAttempt(attempt.id);
    const currentAttemptId = currentAttempt?.id;
    if (currentAttempt && currentAttempt.workerToken !== workerToken) return;
    if (currentJob?.status === "CANCEL_REQUESTED" && currentAttempt) {
      await this.#confirmCancellation(currentAttempt);
      return;
    }
    if (publicationNeedsFinalization(currentJob, currentAttempt)) {
      this.#recordEventSafely(
        jobId,
        currentAttempt.id,
        "DELIVERY_FINALIZATION_DEFERRED",
        { error: message },
      );
      return;
    }
    if (isUncertainCursorTransportFailure(message)) {
      // The SDK may have accepted the request while the supervisor lost its
      // transport. Keep the active attempt lease-fenced and let the next
      // supervisor reclaim/reconcile the durable local run instead of turning
      // an unknown outcome into a false terminal failure.
      if (currentAttemptId) {
        this.#recordEventSafely(jobId, currentAttemptId, "CURSOR_TRANSPORT_UNCERTAIN", {
          error: message,
        });
      }
      await this.#writeReport(message);
      return;
    }
    if (!this.#markFailed(currentJob, currentAttempt, message)) return;
    await this.#writeReport(message);
  }

  async #confirmCancellation(attempt: Attempt): Promise<void> {
    const { adapter, store, jobId, workerToken } = this.#context;
    try {
      await adapter.cancel(attempt);
      store.confirmCancellation(jobId, attempt.id, workerToken);
    } catch (error) {
      this.#recordEventSafely(
        jobId,
        attempt.id,
        "CANCELLATION_CONFIRMATION_FAILED",
        { error: safeErrorMessage(error) },
      );
    }
  }

  #recordEventSafely(
    jobId: string,
    attemptId: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    try {
      this.#context.store.recordEvent(jobId, attemptId, type, data);
    } catch {
      // Diagnostic events must never turn a recoverable workflow state into a
      // false terminal failure when the event ledger is unavailable.
    }
  }

  #markFailed(
    job: Job | undefined,
    attempt: Attempt | undefined,
    message: string,
  ): boolean {
    const { store, jobId, workerToken } = this.#context;
    const staleSpec = message.startsWith("STALE_SPEC:");
    if (attempt && !terminalAttemptStatuses.has(attempt.status)) {
      try {
        if (staleSpec) {
          store.failStaleSpec(jobId, attempt.id, workerToken, message);
        } else {
          store.transitionAttempt(
            attempt.id,
            workerToken,
            [attempt.status],
            "FAILED",
            { errorMessage: message },
          );
        }
      } catch {
        return false;
      }
    } else if (job && !terminalJobStatuses.has(job.status)) {
      try {
        store.transitionJob(
          jobId,
          [job.status],
          staleSpec ? "STALE_SPEC" : "FAILED",
          { errorMessage: message },
        );
      } catch {
        return false;
      }
    }
    return true;
  }

  async #writeReport(message: string): Promise<void> {
    const {
      adapter,
      assessment,
      cursorSummary,
      finalChanges,
      initialChanges,
      jobId,
      store,
      task,
      verification,
    } = this.#context;
    const job = store.get(jobId);
    if (!job) return;
    try {
      const reportPath = await adapter.writeReport({
        job,
        task,
        ...(finalChanges ?? initialChanges
          ? { changes: finalChanges ?? initialChanges }
          : {}),
        ...(initialChanges ? { initialChanges } : {}),
        ...(assessment ? { assessment } : {}),
        ...(verification ? { verification } : {}),
        attempts: store.listAttempts(jobId),
        ...(cursorSummary ? { cursorSummary } : {}),
        error: message,
        reportOwner: {
          attemptId: this.#context.attempt.id,
          workerToken: this.#context.workerToken,
        },
      });
      store.attachReportIfOwned(
        jobId,
        this.#context.attempt.id,
        this.#context.workerToken,
        reportPath,
      );
    } catch {
      // The primary job error remains authoritative if report persistence also fails.
    }
  }
}

export async function handleWorkflowFailure(
  context: WorkflowFailureContext,
  error: unknown,
): Promise<void> {
  await new WorkflowFailureHandler(context).handle(error);
}
