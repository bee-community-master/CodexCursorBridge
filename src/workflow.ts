import type { RepositoryConfig } from "./config.js";
import type { CollectedChanges } from "./git.js";
import type { Job, JobStore } from "./state.js";
import type { Task } from "./task.js";
import { assessChanges, type ChangeAssessment } from "./verification.js";

export interface PreparedWorktree {
  worktree: string;
  baseSha: string;
  pushBranch: string;
  localBranch: string;
}

export interface CursorExecution {
  agentId: string;
  runId: string;
  summary: string;
}

export interface VerificationResult {
  command: string;
  status: "passed" | "failed";
  durationMs: number;
  output?: string;
}

export interface WorkflowReportData {
  job: Job;
  task: Task;
  changes?: CollectedChanges;
  assessment?: ChangeAssessment;
  verification?: VerificationResult[];
  cursorSummary?: string;
  error?: string;
}

export interface WorkflowAdapter {
  prepare(job: Job, task: Task, repository: RepositoryConfig): Promise<PreparedWorktree>;
  runCursor(worktree: PreparedWorktree, task: Task): Promise<CursorExecution>;
  collectChanges(worktree: PreparedWorktree): Promise<CollectedChanges>;
  runVerification(worktree: PreparedWorktree, task: Task): Promise<VerificationResult[]>;
  publish(worktree: PreparedWorktree, task: Task, repository: RepositoryConfig, reportData: WorkflowReportData): Promise<{ prUrl: string }>;
  writeReport(data: WorkflowReportData): Promise<string>;
  cleanup(worktree: PreparedWorktree, repository: RepositoryConfig): Promise<void>;
}

const terminal = new Set(["DONE", "BLOCKED", "FAILED", "CANCELLED", "STALE_SPEC", "SCOPE_VIOLATION"]);

export async function executeWorkflow(
  store: JobStore,
  jobId: string,
  task: Task,
  repository: RepositoryConfig,
  adapter: WorkflowAdapter,
): Promise<void> {
  let prepared: PreparedWorktree | undefined;
  let changes: CollectedChanges | undefined;
  let assessment: ChangeAssessment | undefined;
  let verification: VerificationResult[] | undefined;
  let cursorSummary: string | undefined;
  try {
    let job = store.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    job = store.transition(jobId, "RUNNING");
    prepared = await adapter.prepare(job, task, repository);
    store.update(jobId, { worktree: prepared.worktree, baseSha: prepared.baseSha });

    const cursor = await adapter.runCursor(prepared, task);
    cursorSummary = cursor.summary;
    store.update(jobId, { cursorAgentId: cursor.agentId, cursorRunId: cursor.runId });
    store.transition(jobId, "VERIFYING");

    changes = await adapter.collectChanges(prepared);
    assessment = assessChanges({
      files: changes.files,
      deletedFiles: changes.deletedFiles,
      diffLines: changes.diffLines,
      allowedPatterns: task.allowed_paths,
      forbiddenPatterns: task.forbidden_paths,
      maxChangedFiles: task.limits.max_changed_files,
      maxDiffLines: task.limits.max_diff_lines,
      allowTestDeletion: task.limits.allow_test_deletion,
    });
    if (!assessment.ok) {
      store.transition(jobId, "SCOPE_VIOLATION", { errorMessage: assessment.reasons.join("; ") });
      const reportPath = await adapter.writeReport({ job: store.get(jobId)!, task, changes, assessment, cursorSummary });
      store.update(jobId, { reportPath });
      return;
    }

    verification = await adapter.runVerification(prepared, task);
    const failed = verification.find((result) => result.status === "failed");
    if (failed) throw new Error(`Verification failed: ${failed.command}`);

    store.transition(jobId, "COMMITTING");
    const reportData: WorkflowReportData = { job: store.get(jobId)!, task, changes, assessment, verification, cursorSummary };
    store.transition(jobId, "PUSHING");
    const publication = await adapter.publish(prepared, task, repository, reportData);
    store.transition(jobId, "DONE", { prUrl: publication.prUrl });
    const reportPath = await adapter.writeReport({ ...reportData, job: store.get(jobId)! });
    store.update(jobId, { reportPath });
    await adapter.cleanup(prepared, repository);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = store.get(jobId);
    if (current && !terminal.has(current.status)) store.transition(jobId, "FAILED", { errorMessage: message });
    if (current) {
      try {
        const reportPath = await adapter.writeReport({
          job: store.get(jobId) ?? current, task,
          ...(changes ? { changes } : {}), ...(assessment ? { assessment } : {}),
          ...(verification ? { verification } : {}), ...(cursorSummary ? { cursorSummary } : {}), error: message,
        });
        store.update(jobId, { reportPath });
      } catch {
        // The primary job error remains authoritative if report persistence also fails.
      }
    }
  }
}
