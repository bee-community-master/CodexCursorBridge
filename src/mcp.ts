import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadMachineConfig, runtimePaths } from "./config.js";
import { resolveCommittedTask } from "./dispatch.js";
import { wakeSupervisor } from "./launchd.js";
import { errorResponse, successResponse, warningResponse, type ToolResponse } from "./response.js";
import { JobStore, terminalJobStatuses, type Job } from "./state.js";

const inferredRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = runtimePaths(process.env.CURSOR_BRIDGE_ROOT ?? inferredRoot);
const store = new JobStore(paths.databaseFile);
function jobResponse(job: Job, summary: string): ToolResponse {
  const attempt = job.currentAttemptId ? store.getAttempt(job.currentAttemptId) : undefined;
  const artifacts: Record<string, string> = {};
  if (job.logPath) artifacts.log = job.logPath;
  if (job.reportPath) artifacts.report = job.reportPath;
  const worktree = attempt?.worktree ?? job.worktree;
  if (worktree && job.cleanupStatus !== "COMPLETED") artifacts.worktree = worktree;
  if (job.prUrl) artifacts.pr = job.prUrl;
  if (job.attestationPath) artifacts.attestation = job.attestationPath;
  const nextActions = job.status === "DELIVERED_REVIEW_REQUIRED"
    ? ["Review the Draft PR, report, and attestation before marking it ready."]
    : terminalJobStatuses.has(job.status)
      ? job.reportPath ? [] : ["Call cursor_get_report after the report becomes available."]
      : ["Call cursor_get_task with this jobId to continue monitoring."];
  return {
    ...successResponse(summary, nextActions, artifacts),
    jobId: job.id, jobStatus: job.status, repositoryAlias: job.repositoryAlias, taskId: job.taskId,
    cursorAgentId: attempt?.cursorAgentId ?? job.cursorAgentId,
    cursorRunId: attempt?.cursorRunId ?? job.cursorRunId,
    prUrl: job.prUrl,
    errorMessage: job.errorMessage,
  };
}

function toolResult(response: ToolResponse): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
    ...(response.status === "error" ? { isError: true } : {}),
  };
}

async function waitForChange(jobId: string, initialUpdatedAt: string, waitSeconds: number): Promise<Job | undefined> {
  const deadline = Date.now() + waitSeconds * 1000;
  let job = store.get(jobId);
  while (job && job.updatedAt === initialUpdatedAt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    job = store.get(jobId);
  }
  return job;
}

const server = new McpServer(
  { name: "cursor-bridge", version: "0.2.0" },
  { instructions: "Only approved, committed Task IDs may be started. Start once, monitor by job ID, and report exact failures without changing the task contract." },
);

server.registerTool("cursor_start_task", {
  description: "Start one committed and approved Cursor coding task in an isolated Git worktree.",
  inputSchema: z.object({
    repositoryAlias: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    taskId: z.string().regex(/^TASK-[A-Z0-9][A-Z0-9-]*$/),
    specVersion: z.number().int().positive(),
    specHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ repositoryAlias, taskId, specVersion, specHash }) => {
  try {
    const config = await loadMachineConfig(paths.configFile);
    const repository = config.repositories[repositoryAlias];
    if (!repository) {
      throw new Error(`Repository alias is not registered: ${repositoryAlias}`);
    }
    const resolved = await resolveCommittedTask(
      paths,
      repository,
      repositoryAlias,
      taskId,
      specVersion,
      specHash,
    );
    let job = store.createOrGet(resolved.createJobInput);
    if (!job.logPath) {
      store.update(job.id, { logPath: path.join(paths.logsDir, `${job.id}.log`) });
      job = store.get(job.id)!;
    }
    if (!terminalJobStatuses.has(job.status)) await wakeSupervisor();
    return toolResult(jobResponse(job, `Cursor task ${taskId} is ${job.status.toLowerCase()}.`));
  } catch (error) {
    return toolResult(errorResponse(
      "Cursor task was not started.", error instanceof Error ? error.message : String(error),
      "Correct the task, repository registration, or local configuration and retry with the same approved spec.",
      "Do not retry if the task version or hash is stale; approve a new spec instead.",
    ));
  }
});

server.registerTool("cursor_get_task", {
  description: "Get current state for a Cursor Bridge job, optionally long-polling for a change.",
  inputSchema: z.object({ jobId: z.string().uuid(), waitSeconds: z.number().int().min(0).max(30).default(0) }),
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ jobId, waitSeconds }) => {
  const initial = store.get(jobId);
  if (!initial) return toolResult(errorResponse("Job was not found.", `Unknown job: ${jobId}`, "Check the job ID and retry.", "Stop if no matching start result exists."));
  const job = waitSeconds > 0 ? await waitForChange(jobId, initial.updatedAt, waitSeconds) : initial;
  return toolResult(jobResponse(job ?? initial, `Cursor task is ${(job ?? initial).status.toLowerCase()}.`));
});

server.registerTool("cursor_cancel_task", {
  description: "Cancel an active Cursor Bridge job without terminating unrelated processes.",
  inputSchema: z.object({ jobId: z.string().uuid() }),
  annotations: { destructiveHint: true, idempotentHint: true },
}, async ({ jobId }) => {
  const job = store.get(jobId);
  if (!job) return toolResult(errorResponse("Job was not found.", `Unknown job: ${jobId}`, "Check the job ID and retry.", "Stop if no matching start result exists."));
  if (terminalJobStatuses.has(job.status)) {
    return toolResult(warningResponse(
      `Job is already terminal: ${job.status}`,
      [],
      job.reportPath ? { report: job.reportPath } : {},
    ));
  }
  const requested = store.requestCancellation(jobId);
  try {
    await wakeSupervisor();
  } catch (error) {
    store.recordEvent(jobId, requested.currentAttemptId, "SUPERVISOR_WAKE_FAILED", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return toolResult(jobResponse(
    requested,
    requested.status === "CANCELLED"
      ? "Queued Cursor task was cancelled."
      : "Cursor task cancellation was requested and awaits worker confirmation.",
  ));
});

server.registerTool("cursor_get_report", {
  description: "Read the final Cursor Bridge execution report for a job.",
  inputSchema: z.object({ jobId: z.string().uuid() }),
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ jobId }) => {
  const job = store.get(jobId);
  if (!job) return toolResult(errorResponse("Job was not found.", `Unknown job: ${jobId}`, "Check the job ID and retry.", "Stop if no matching start result exists."));
  if (!job.reportPath) return toolResult(warningResponse("Report is not available yet.", ["Monitor the job with cursor_get_task."], job.logPath ? { log: job.logPath } : {}));
  const report = await readFile(job.reportPath, "utf8");
  return toolResult({ ...jobResponse(job, "Cursor task report is available."), report });
});

const transport = new StdioServerTransport();
await server.connect(transport);
