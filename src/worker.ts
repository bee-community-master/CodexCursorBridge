import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMachineConfig, runtimePaths } from "./config.js";
import { cancelActiveCursorRun, RealWorkflowAdapter } from "./real-adapter.js";
import { JobStore } from "./state.js";
import { assertApprovedTask, loadTaskFile } from "./task.js";
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
    `# ${job?.taskId ?? jobId} Cursor execution report`, "",
    `- Status: ${job?.status ?? "FAILED"}`, "", "## Preflight error", "", message, "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  store.update(jobId, { reportPath });
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) throw new Error("Usage: node dist/worker.js <job-id>");
  const paths = runtimePaths();
  const store = new JobStore(paths.databaseFile);
  const job = store.get(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);

  const stop = async (): Promise<void> => {
    try { await cancelActiveCursorRun(); } finally { process.exitCode = 130; }
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });

  try {
    const config = await loadMachineConfig(paths.configFile);
    const repository = config.repositories[job.repositoryAlias];
    if (!repository) throw new Error(`Repository alias is not registered: ${job.repositoryAlias}`);
    const taskFile = path.join(paths.tasksDir, job.repositoryAlias, `${job.taskId}.yaml`);
    const task = await loadTaskFile(taskFile);
    if (task.id !== job.taskId || task.repository !== job.repositoryAlias) throw new Error("Task identity does not match the job");
    try {
      assertApprovedTask(task, job.specVersion, job.specHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.transition(jobId, "STALE_SPEC", { errorMessage: message });
      await writePreflightReport(paths.reportsDir, store, jobId, message);
      return;
    }
    const adapter = new RealWorkflowAdapter(paths, config, store, jobId);
    await executeWorkflow(store, jobId, task, repository, adapter);
  } catch (error) {
    const current = store.get(jobId);
    const message = error instanceof Error ? error.message : String(error);
    if (current && current.status === "QUEUED") {
      store.transition(jobId, "FAILED", { errorMessage: message });
      await writePreflightReport(paths.reportsDir, store, jobId, message);
    }
    throw error;
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
