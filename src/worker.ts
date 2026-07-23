import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeOwnerOnlyAtomic } from "./adapters/owner-only-atomic-file.js";
import type {
  PublicationStatePort,
  WorkerStatePort,
  WorkflowAdapter,
} from "./application/workflow-ports.js";
import { loadMachineConfig } from "./config.js";
import { loadJobTask } from "./dispatch.js";
import type {
  MachineConfig,
  RuntimePaths,
} from "./domain/configuration.js";
import {
  terminalAttemptStatuses,
  terminalJobStatuses,
  type Attempt,
  type ClaimedWork,
  type Job,
} from "./domain/job.js";
import { safeErrorMessage } from "./redaction.js";
import { RealWorkflowAdapter } from "./real-adapter.js";
import { executeWorkflow } from "./workflow.js";

export interface WorkerDependencies {
  loadMachineConfig: typeof loadMachineConfig;
  loadJobTask: typeof loadJobTask;
  createWorkflowAdapter(
    paths: RuntimePaths,
    config: MachineConfig,
    store: PublicationStatePort,
    jobId: string,
  ): WorkflowAdapter;
  executeWorkflow: typeof executeWorkflow;
}

const defaultWorkerDependencies: WorkerDependencies = {
  loadMachineConfig,
  loadJobTask,
  createWorkflowAdapter: (paths, config, store, jobId) =>
    new RealWorkflowAdapter(paths, config, store, jobId),
  executeWorkflow,
};

interface CurrentClaimState {
  job: Job | undefined;
  attempt: Attempt | undefined;
}

function readCurrentClaimState(
  store: WorkerStatePort,
  jobId: string,
): CurrentClaimState {
  const job = store.get(jobId);
  const attempt = job?.currentAttemptId
    ? store.getAttempt(job.currentAttemptId)
    : undefined;
  return { job, attempt };
}

function claimLeaseWasReplaced(
  attempt: Attempt | undefined,
  workerToken: string,
): boolean {
  return attempt !== undefined && attempt.workerToken !== workerToken;
}

async function confirmPendingCancellation(
  store: WorkerStatePort,
  adapter: WorkflowAdapter | undefined,
  jobId: string,
  workerToken: string,
): Promise<void> {
  const current = store.get(jobId);
  const attempt = current?.currentAttemptId
    ? store.getAttempt(current.currentAttemptId)
    : undefined;
  if (
    current?.status !== "CANCEL_REQUESTED"
    || !attempt
    || attempt.workerToken !== workerToken
  ) return;
  try {
    if (adapter) {
      await adapter.cancel(attempt);
    } else if (
      attempt.status !== "PREPARING"
      || attempt.cursorAgentId
      || attempt.cursorRunId
    ) {
      throw new Error("Cancellation adapter is unavailable");
    }
    store.confirmCancellation(jobId, attempt.id, attempt.workerToken);
  } catch (error) {
    store.recordEvent(jobId, attempt.id, "CANCELLATION_CONFIRMATION_FAILED", {
      error: safeErrorMessage(error),
    });
  }
}

async function writePreflightReport(
  reportsDir: string,
  store: WorkerStatePort,
  jobId: string,
  message: string,
): Promise<void> {
  await mkdir(reportsDir, { recursive: true, mode: 0o700 });
  const reportPath = path.join(reportsDir, `${jobId}.md`);
  const job = store.get(jobId);
  await writeOwnerOnlyAtomic(reportPath, [
    `# ${job?.taskId ?? jobId} Cursor 실행 보고서`,
    "",
    `- 상태: ${job?.status ?? "FAILED"}`,
    "",
    "## 사전 점검 오류",
    "",
    message,
    "",
  ].join("\n"));
  store.update(jobId, { reportPath });
}

async function tryWritePreflightReport(
  reportsDir: string,
  store: WorkerStatePort,
  jobId: string,
  message: string,
): Promise<void> {
  try {
    await writePreflightReport(reportsDir, store, jobId, message);
  } catch (error) {
    try {
      store.recordEvent(
        jobId,
        store.get(jobId)?.currentAttemptId,
        "REPORT_PERSISTENCE_FAILED",
        { error: safeErrorMessage(error) },
      );
    } catch {
      // The terminal Job state remains authoritative if its diagnostic event also fails.
    }
  }
}

async function handleTaskLoadFailure(
  store: WorkerStatePort,
  claim: ClaimedWork,
  adapter: WorkflowAdapter,
  reportsDir: string,
  error: unknown,
): Promise<void> {
  const message = safeErrorMessage(error);
  await settleClaimFailure(
    store,
    claim,
    adapter,
    reportsDir,
    message,
    (current) => {
      if (
        current.job
        && !terminalJobStatuses.has(current.job.status)
      ) {
        store.failStaleSpec(
          claim.job.id,
          claim.attempt.id,
          claim.attempt.workerToken,
          message,
        );
      }
      return true;
    },
  );
}

function markUnexpectedWorkerFailure(
  store: WorkerStatePort,
  current: CurrentClaimState,
  jobId: string,
  message: string,
): boolean {
  if (!current.job || terminalJobStatuses.has(current.job.status)) return true;
  if (
    current.attempt
    && !terminalAttemptStatuses.has(current.attempt.status)
  ) {
    try {
      store.transitionAttempt(
        current.attempt.id,
        current.attempt.workerToken,
        [current.attempt.status],
        "FAILED",
        { errorMessage: message },
      );
      return true;
    } catch {
      return false;
    }
  }
  if (current.attempt) return false;
  try {
    store.transitionJob(
      jobId,
      [current.job.status],
      "FAILED",
      { errorMessage: message },
    );
    return true;
  } catch {
    return false;
  }
}

async function settleClaimFailure(
  store: WorkerStatePort,
  claim: ClaimedWork,
  adapter: WorkflowAdapter | undefined,
  reportsDir: string,
  message: string,
  markFailure: (current: CurrentClaimState) => boolean,
): Promise<void> {
  const current = readCurrentClaimState(store, claim.job.id);
  if (claimLeaseWasReplaced(current.attempt, claim.attempt.workerToken)) return;
  if (current.job?.status === "CANCEL_REQUESTED") {
    await confirmPendingCancellation(
      store,
      adapter,
      claim.job.id,
      claim.attempt.workerToken,
    );
  } else if (!markFailure(current)) {
    return;
  }
  await tryWritePreflightReport(
    reportsDir,
    store,
    claim.job.id,
    message,
  );
}

async function handleWorkerFailure(
  store: WorkerStatePort,
  claim: ClaimedWork,
  adapter: WorkflowAdapter | undefined,
  reportsDir: string,
  error: unknown,
): Promise<void> {
  const message = safeErrorMessage(error);
  await settleClaimFailure(
    store,
    claim,
    adapter,
    reportsDir,
    message,
    (current) => markUnexpectedWorkerFailure(
      store,
      current,
      claim.job.id,
      message,
    ),
  );
}

export async function processClaim(
  store: WorkerStatePort,
  claim: ClaimedWork,
  paths: RuntimePaths,
  dependencies: WorkerDependencies = defaultWorkerDependencies,
): Promise<void> {
  const jobId = claim.job.id;
  let adapter: WorkflowAdapter | undefined;
  try {
    const config = await dependencies.loadMachineConfig(paths.configFile);
    const repository = config.repositories[claim.job.repositoryAlias];
    if (!repository) {
      throw new Error(`Repository alias is not registered: ${claim.job.repositoryAlias}`);
    }
    adapter = dependencies.createWorkflowAdapter(paths, config, store, jobId);
    let task;
    try {
      task = await dependencies.loadJobTask(paths, repository, claim.job);
    } catch (error) {
      await handleTaskLoadFailure(
        store,
        claim,
        adapter,
        paths.reportsDir,
        error,
      );
      return;
    }
    await dependencies.executeWorkflow(store, claim, task, repository, adapter);
  } catch (error) {
    await handleWorkerFailure(
      store,
      claim,
      adapter,
      paths.reportsDir,
      error,
    );
  }
}
