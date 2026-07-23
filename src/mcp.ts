import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadMachineConfig, runtimePaths } from "./config.js";
import { resolveCommittedTask } from "./dispatch.js";
import { wakeSupervisor } from "./launchd.js";
import { readReportText, wakeJobSupervisor } from "./mcp-support.js";
import { safeErrorMessage } from "./redaction.js";
import {
  cancellationSummary,
  cancellationToolStatus,
  errorResponse,
  jobNextActions,
  missingReportResponse,
  successResponse,
  warningResponse,
  type ToolResponse,
} from "./response.js";
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
  const nextActions = jobNextActions(
    job.status,
    job.reportPath !== undefined,
    job.currentAttemptId !== undefined,
  );
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
    const wakeWarning = await wakeJobSupervisor(store, job, wakeSupervisor);
    if (wakeWarning) {
      return toolResult({
        ...jobResponse(
          job,
          `Cursor task ${taskId} is queued, but the supervisor wake request failed.`,
        ),
        status: "warning",
        next_actions: [
          "Retry cursor_start_task once with the same approved identity, then monitor this jobId.",
        ],
        warning: { root_cause: wakeWarning },
      });
    }
    return toolResult(jobResponse(job, `Cursor task ${taskId} is ${job.status.toLowerCase()}.`));
  } catch (error) {
    return toolResult(errorResponse(
      "Cursor task was not started.", safeErrorMessage(error),
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
  let wakeWarning: string | undefined;
  if (requested.status === "CANCEL_REQUESTED") {
    wakeWarning = await wakeJobSupervisor(store, requested, wakeSupervisor);
  }
  const response = jobResponse(
    requested,
    cancellationSummary(job.status, requested.status),
  );
  return toolResult({
    ...response,
    status: cancellationToolStatus(
      job.status,
      requested.status,
      wakeWarning !== undefined,
    ),
    ...(wakeWarning ? {
      next_actions: [
        "Retry cursor_cancel_task once for this jobId, then continue monitoring cancellation.",
      ],
      warning: { root_cause: wakeWarning },
    } : {}),
  });
});

server.registerTool("cursor_get_report", {
  description: "Read the final Cursor Bridge execution report for a job.",
  inputSchema: z.object({ jobId: z.string().uuid() }),
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ jobId }) => {
  const job = store.get(jobId);
  if (!job) return toolResult(errorResponse("Job was not found.", `Unknown job: ${jobId}`, "Check the job ID and retry.", "Stop if no matching start result exists."));
  if (!job.reportPath) {
    return toolResult(missingReportResponse(
      job.status,
      job.currentAttemptId !== undefined,
      job.logPath,
    ));
  }
  const report = await readReportText(job.reportPath);
  if (!report.ok) {
    return toolResult({
      ...jobResponse(job, "Cursor task report could not be read."),
      status: "error",
      next_actions: [
        "Retry cursor_get_report once; stop and inspect the report artifact path if it still fails.",
      ],
      error: {
        root_cause: report.error,
        safe_retry: "Retry cursor_get_report once for this jobId.",
        stop_condition: "Stop if the same report artifact remains unreadable.",
      },
    });
  }
  return toolResult({
    ...jobResponse(job, "Cursor task report is available."),
    report: report.report,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
