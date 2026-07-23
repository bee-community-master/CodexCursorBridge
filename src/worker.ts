import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMachineConfig, type RuntimePaths } from "./config.js";
import { loadJobTask } from "./dispatch.js";
import { RealWorkflowAdapter } from "./real-adapter.js";
import { terminalJobStatuses, type ClaimedWork, type JobStore } from "./state.js";
import { executeWorkflow } from "./workflow.js";

async function writePreflightReport(
  reportsDir: string,
  store: JobStore,
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

export async function processClaim(
  store: JobStore,
  claim: ClaimedWork,
  paths: RuntimePaths,
): Promise<void> {
  const jobId = claim.job.id;
  try {
    const config = await loadMachineConfig(paths.configFile);
    const repository = config.repositories[claim.job.repositoryAlias];
    if (!repository) {
      throw new Error(`Repository alias is not registered: ${claim.job.repositoryAlias}`);
    }
    let task;
    try {
      task = await loadJobTask(paths, repository, claim.job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = store.get(jobId);
      if (current?.status === "CANCEL_REQUESTED" && current.currentAttemptId) {
        const attempt = store.getAttempt(current.currentAttemptId);
        if (attempt) {
          store.confirmCancellation(jobId, attempt.id, attempt.workerToken);
        }
      } else if (current && !terminalJobStatuses.has(current.status)) {
        store.transitionJob(jobId, [current.status], "STALE_SPEC", { errorMessage: message });
      }
      await writePreflightReport(paths.reportsDir, store, jobId, message);
      return;
    }
    const adapter = new RealWorkflowAdapter(paths, config, store, jobId);
    await executeWorkflow(store, claim, task, repository, adapter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = store.get(jobId);
    if (current?.status === "CANCEL_REQUESTED" && current.currentAttemptId) {
      const attempt = store.getAttempt(current.currentAttemptId);
      if (attempt) store.confirmCancellation(jobId, attempt.id, attempt.workerToken);
    } else if (current && !terminalJobStatuses.has(current.status)) {
      const attempt = current.currentAttemptId
        ? store.getAttempt(current.currentAttemptId)
        : undefined;
      if (attempt && !["FAILED", "BLOCKED", "CANCELLED", "SCOPE_VIOLATION", "COMPLETED"].includes(attempt.status)) {
        try {
          store.transitionAttempt(
            attempt.id,
            attempt.workerToken,
            [attempt.status],
            "FAILED",
            { errorMessage: message },
          );
        } catch {
          store.transitionJob(jobId, [current.status], "FAILED", { errorMessage: message });
        }
      } else {
        store.transitionJob(jobId, [current.status], "FAILED", { errorMessage: message });
      }
    }
    await writePreflightReport(paths.reportsDir, store, jobId, message);
  }
}
