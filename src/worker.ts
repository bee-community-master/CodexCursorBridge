import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
  terminalJobStatuses,
  type ClaimedWork,
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
  await writeFile(reportPath, [
    `# ${job?.taskId ?? jobId} Cursor 실행 보고서`,
    "",
    `- 상태: ${job?.status ?? "FAILED"}`,
    "",
    "## 사전 점검 오류",
    "",
    message,
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
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
      const message = safeErrorMessage(error);
      const current = store.get(jobId);
      const currentAttempt = current?.currentAttemptId
        ? store.getAttempt(current.currentAttemptId)
        : undefined;
      if (
        currentAttempt
        && currentAttempt.workerToken !== claim.attempt.workerToken
      ) return;
      if (current?.status === "CANCEL_REQUESTED") {
        await confirmPendingCancellation(store, adapter, jobId, claim.attempt.workerToken);
      } else if (current && !terminalJobStatuses.has(current.status)) {
        store.failStaleSpec(
          jobId,
          claim.attempt.id,
          claim.attempt.workerToken,
          message,
        );
      }
      await tryWritePreflightReport(paths.reportsDir, store, jobId, message);
      return;
    }
    await dependencies.executeWorkflow(store, claim, task, repository, adapter);
  } catch (error) {
    const message = safeErrorMessage(error);
    const current = store.get(jobId);
    const currentAttempt = current?.currentAttemptId
      ? store.getAttempt(current.currentAttemptId)
      : undefined;
    if (
      currentAttempt
      && currentAttempt.workerToken !== claim.attempt.workerToken
    ) return;
    if (current?.status === "CANCEL_REQUESTED") {
      await confirmPendingCancellation(store, adapter, jobId, claim.attempt.workerToken);
    } else if (current && !terminalJobStatuses.has(current.status)) {
      if (
        currentAttempt
        && !["FAILED", "BLOCKED", "CANCELLED", "SCOPE_VIOLATION", "COMPLETED"].includes(currentAttempt.status)
      ) {
        try {
          store.transitionAttempt(
            currentAttempt.id,
            currentAttempt.workerToken,
            [currentAttempt.status],
            "FAILED",
            { errorMessage: message },
          );
        } catch {
          return;
        }
      } else if (!currentAttempt) {
        try {
          store.transitionJob(jobId, [current.status], "FAILED", { errorMessage: message });
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    await tryWritePreflightReport(paths.reportsDir, store, jobId, message);
  }
}
