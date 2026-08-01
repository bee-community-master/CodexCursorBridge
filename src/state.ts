import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PendingRunEvent,
  RunEventDeliveryState,
  WorkerStatePort,
} from "./application/workflow-ports.js";
import {
  rowToAttempt,
  rowToJob,
} from "./adapters/sqlite-state-mappers.js";
import { SqliteDeliveryLifecycle } from "./adapters/sqlite-delivery-lifecycle.js";
import { SqliteJobRecords } from "./adapters/sqlite-job-records.js";
import { SqliteStateLedger } from "./adapters/sqlite-state-ledger.js";
import { migrateStateDatabase } from "./adapters/sqlite-state-schema.js";
import {
  canTransitionAttempt,
  jobStatusForAttempt,
  terminalJobStatuses,
  type Attempt,
  type AttemptStatus,
  type ClaimedWork,
  type CreateJobInput,
  type DeliveryCompletion,
  type Effect,
  type Job,
  type JobEvent,
  type JobMetrics,
  type JobStatus,
  type PublicationRecord,
} from "./domain/job.js";

export {
  attemptStatuses,
  jobStatuses,
  terminalAttemptStatuses,
  terminalJobStatuses,
} from "./domain/job.js";
export type {
  Attempt,
  AttemptStatus,
  ClaimedWork,
  CreateJobInput,
  DeliveryCompletion,
  Effect,
  Job,
  JobEvent,
  JobMetrics,
  JobStatus,
  PublicationRecord,
} from "./domain/job.js";

export { STATE_SCHEMA_VERSION } from "./adapters/sqlite-state-schema.js";

const reclaimableJobStatuses: JobStatus[] = [
  "PREPARING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PUBLISHING",
  "CANCEL_REQUESTED",
];
const reportAttachAttemptStatuses: AttemptStatus[] = [
  "PREPARING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PUBLISHING",
];

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function leaseIso(now: Date, leaseMs: number): string {
  return new Date(now.getTime() + leaseMs).toISOString();
}

export class JobStore implements WorkerStatePort {
  readonly #database: DatabaseSync;
  readonly #ledger: SqliteStateLedger;
  readonly #records: SqliteJobRecords;
  readonly #delivery: SqliteDeliveryLifecycle;

  constructor(file: string) {
    const directory = path.dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.#database = new DatabaseSync(file);
    this.#ledger = new SqliteStateLedger(this.#database);
    this.#records = new SqliteJobRecords(this.#database, this.#ledger);
    this.#delivery = new SqliteDeliveryLifecycle(
      this.#database,
      this.#records,
      this.#ledger,
      (jobId, attemptId, workerToken, expectedStatus) =>
        this.assertActiveAttempt(jobId, attemptId, workerToken, expectedStatus),
    );
    try {
      this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      migrateStateDatabase(this.#database);
      chmodSync(file, 0o600);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${file}${suffix}`)) chmodSync(`${file}${suffix}`, 0o600);
      }
    } catch (error) {
      try {
        this.#database.close();
      } catch {
        // Preserve the migration failure if SQLite also fails to close.
      }
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  schemaVersion(): number {
    return this.#records.schemaVersion();
  }

  createOrGet(input: CreateJobInput): Job {
    return this.#records.createOrGet(input);
  }

  get(id: string): Job | undefined {
    return this.#records.get(id);
  }

  getAttempt(id: string): Attempt | undefined {
    return this.#records.getAttempt(id);
  }

  #requireJob(id: string): Job {
    const job = this.get(id);
    if (!job) throw new Error(`Job disappeared from state storage: ${id}`);
    return job;
  }

  #requireAttempt(id: string): Attempt {
    const attempt = this.getAttempt(id);
    if (!attempt) {
      throw new Error(`Attempt disappeared from state storage: ${id}`);
    }
    return attempt;
  }

  listAttempts(jobId: string): Attempt[] {
    return this.#records.listAttempts(jobId);
  }

  assertActiveAttempt(
    jobId: string,
    attemptId: string,
    workerToken: string,
    expectedStatus: AttemptStatus,
  ): Attempt {
    const expectedJobStatus = jobStatusForAttempt(expectedStatus);
    if (!expectedJobStatus || terminalJobStatuses.has(expectedJobStatus)) {
      throw new Error(`Attempt status is not active: ${expectedStatus}`);
    }
    const row = this.#database.prepare(`
      SELECT a.* FROM attempts a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ? AND a.job_id = ? AND a.worker_token = ? AND a.status = ?
        AND j.current_attempt_id = a.id AND j.status = ?
    `).get(
      attemptId,
      jobId,
      workerToken,
      expectedStatus,
      expectedJobStatus,
    ) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Active attempt lease was lost: ${attemptId}`);
    return rowToAttempt(row);
  }

  claimNext(workerToken: string, leaseMs: number, now = new Date()): ClaimedWork | undefined {
    const timestamp = nowIso(now);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = reclaimableJobStatuses.map(() => "?").join(", ");
      const row = this.#database.prepare(`
        SELECT j.* FROM jobs j
        LEFT JOIN attempts a ON a.id = j.current_attempt_id
        WHERE j.status = 'QUEUED'
          OR (j.status IN (${placeholders}) AND a.lease_expires_at <= ?)
        ORDER BY j.created_at, j.id
        LIMIT 1
      `).get(...reclaimableJobStatuses, timestamp) as Record<string, unknown> | undefined;
      if (!row) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      let job = rowToJob(row);
      let attempt: Attempt;
      let resumed = false;
      if (job.currentAttemptId) {
        const existing = this.getAttempt(job.currentAttemptId);
        if (!existing) throw new Error(`Current attempt is missing: ${job.currentAttemptId}`);
        const lease = leaseIso(now, leaseMs);
        this.#database.prepare(`
          UPDATE attempts
          SET worker_token = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
          WHERE id = ? AND lease_expires_at <= ?
        `).run(workerToken, lease, timestamp, timestamp, existing.id, timestamp);
        attempt = this.#requireAttempt(existing.id);
        if (attempt.workerToken !== workerToken) {
          throw new Error(`Expired attempt was reclaimed concurrently: ${existing.id}`);
        }
        resumed = true;
        this.#ledger.recordEvent(
          job.id,
          attempt.id,
          "ATTEMPT_RECLAIMED",
          { ordinal: attempt.ordinal },
          timestamp,
        );
      } else {
        const ordinal = Number((this.#database.prepare(
          "SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM attempts WHERE job_id = ?",
        ).get(job.id) as Record<string, unknown>).ordinal) + 1;
        if (ordinal > job.maxAttempts) throw new Error(`Attempt limit exceeded for job ${job.id}`);
        const attemptId = randomUUID();
        const lease = leaseIso(now, leaseMs);
        this.#database.prepare(`
          INSERT INTO attempts (
            id, job_id, ordinal, status, worker_token, lease_expires_at,
            heartbeat_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'PREPARING', ?, ?, ?, ?, ?)
        `).run(attemptId, job.id, ordinal, workerToken, lease, timestamp, timestamp, timestamp);
        this.#database.prepare(`
          UPDATE jobs SET status = 'PREPARING', current_attempt_id = ?, updated_at = ?
          WHERE id = ? AND status = 'QUEUED'
        `).run(attemptId, timestamp, job.id);
        attempt = this.#requireAttempt(attemptId);
        job = this.#requireJob(job.id);
        this.#ledger.recordEvent(job.id, attempt.id, "JOB_CLAIMED", { ordinal }, timestamp);
      }
      this.#database.exec("COMMIT");
      return { job, attempt, resumed };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(attemptId: string, workerToken: string, leaseMs: number, now = new Date()): Attempt {
    const timestamp = nowIso(now);
    const result = this.#database.prepare(`
      UPDATE attempts
      SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND worker_token = ?
    `).run(timestamp, leaseIso(now, leaseMs), timestamp, attemptId, workerToken);
    if (result.changes !== 1) throw new Error(`Attempt lease was lost: ${attemptId}`);
    return this.#requireAttempt(attemptId);
  }

  transitionAttempt(
    attemptId: string,
    workerToken: string,
    expected: readonly AttemptStatus[],
    next: AttemptStatus,
    fields: Partial<Attempt> = {},
  ): Attempt {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.getAttempt(attemptId);
      if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`);
      if (
        next !== attempt.status
        && !canTransitionAttempt(attempt.status, next)
      ) {
        throw new Error(`Illegal attempt transition: ${attempt.status} -> ${next}`);
      }
      const job = this.get(attempt.jobId);
      if (!job) throw new Error(`Unknown job: ${attempt.jobId}`);
      if (
        job.status === "CANCEL_REQUESTED"
        && next !== "CANCELLED"
        && next !== attempt.status
      ) {
        throw new Error(`Job cancellation is pending: ${job.id}`);
      }
      const timestamp = nowIso();
      const placeholders = expected.map(() => "?").join(", ");
      const result = this.#database.prepare(`
        UPDATE attempts
        SET status = ?, updated_at = ?,
            cursor_agent_id = COALESCE(?, cursor_agent_id),
            cursor_run_id = COALESCE(?, cursor_run_id),
            cursor_request_id = COALESCE(?, cursor_request_id),
            worktree = COALESCE(?, worktree), base_sha = COALESCE(?, base_sha),
            git_config_digest = COALESCE(?, git_config_digest),
            head_sha = COALESCE(?, head_sha), tree_hash = COALESCE(?, tree_hash),
            outcome = COALESCE(?, outcome), outcome_summary = COALESCE(?, outcome_summary),
            outcome_reason = COALESCE(?, outcome_reason),
            error_message = COALESCE(?, error_message),
            input_tokens = COALESCE(?, input_tokens),
            output_tokens = COALESCE(?, output_tokens)
        WHERE id = ? AND worker_token = ? AND status IN (${placeholders})
      `).run(
        next,
        timestamp,
        fields.cursorAgentId ?? null,
        fields.cursorRunId ?? null,
        fields.cursorRequestId ?? null,
        fields.worktree ?? null,
        fields.baseSha ?? null,
        fields.gitConfigDigest ?? null,
        fields.headSha ?? null,
        fields.treeHash ?? null,
        fields.outcome ?? null,
        fields.outcomeSummary ?? null,
        fields.outcomeReason ?? null,
        fields.errorMessage ?? null,
        fields.inputTokens ?? null,
        fields.outputTokens ?? null,
        attemptId,
        workerToken,
        ...expected,
      );
      if (result.changes !== 1) throw new Error(`Attempt state changed concurrently: ${attemptId}`);
      const jobStatus = job.status === "CANCEL_REQUESTED"
        ? undefined
        : jobStatusForAttempt(next);
      if (jobStatus) {
        const jobResult = this.#database.prepare(`
          UPDATE jobs SET status = ?, updated_at = ?,
            error_message = COALESCE(?, error_message)
          WHERE id = ? AND current_attempt_id = ?
        `).run(
          jobStatus,
          timestamp,
          fields.errorMessage ?? null,
          attempt.jobId,
          attemptId,
        );
        if (jobResult.changes !== 1) {
          throw new Error(`Job attempt changed concurrently: ${attempt.jobId}`);
        }
      }
      this.#ledger.recordEvent(attempt.jobId, attemptId, "ATTEMPT_TRANSITIONED", {
        from: attempt.status,
        to: next,
      }, timestamp);
      this.#database.exec("COMMIT");
      return this.#requireAttempt(attemptId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  updateAttempt(attemptId: string, workerToken: string, fields: Partial<Attempt>): Attempt {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`);
    return this.transitionAttempt(attemptId, workerToken, [attempt.status], attempt.status, fields);
  }

  beginRunEvent(jobId: string, attemptId: string, workerToken: string, runId: string, eventKey: string, eventSummary: string): RunEventDeliveryState {
    return this.#ledger.beginRunEvent(jobId, attemptId, workerToken, runId, eventKey, eventSummary);
  }

  completeRunEvent(jobId: string, attemptId: string, workerToken: string, runId: string, eventKey: string): void {
    this.#ledger.completeRunEvent(jobId, attemptId, workerToken, runId, eventKey);
  }

  listPendingRunEvents(jobId: string, attemptId: string, workerToken: string, runId: string): PendingRunEvent[] {
    return this.#ledger.listPendingRunEvents(jobId, attemptId, workerToken, runId);
  }

  beginRepairAttempt(
    jobId: string,
    previousAttemptId: string,
    workerToken: string,
    leaseMs: number,
    repairEvidence: string,
    now = new Date(),
  ): Attempt {
    const timestamp = nowIso(now);
    const attemptId = randomUUID();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const job = this.get(jobId);
      const previous = this.getAttempt(previousAttemptId);
      if (!job || !previous) throw new Error("Cannot begin repair for an unknown job or attempt");
      if (previous.workerToken !== workerToken) {
        throw new Error("Attempt lease is not owned by this worker");
      }
      if (job.status === "CANCEL_REQUESTED") {
        throw new Error(`Job cancellation is pending: ${job.id}`);
      }
      if (job.status !== "VERIFYING" || job.currentAttemptId !== previous.id) {
        throw new Error(`Job is not eligible for repair: ${job.id}`);
      }
      const ordinal = previous.ordinal + 1;
      if (ordinal > job.maxAttempts) throw new Error(`Attempt limit exceeded for job ${job.id}`);
      const previousResult = this.#database.prepare(`
        UPDATE attempts
        SET status = 'FAILED_REPAIRABLE', updated_at = ?, error_message = ?
        WHERE id = ? AND worker_token = ? AND status = 'VERIFYING'
      `).run(timestamp, repairEvidence, previous.id, workerToken);
      if (previousResult.changes !== 1) {
        throw new Error(`Previous repair attempt changed concurrently: ${previous.id}`);
      }
      this.#database.prepare(`
        INSERT INTO attempts (
          id, job_id, ordinal, status, worker_token, lease_expires_at,
          heartbeat_at, created_at, updated_at, cursor_agent_id, worktree, base_sha,
          git_config_digest, error_message
        ) VALUES (?, ?, ?, 'REPAIRING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId,
        job.id,
        ordinal,
        workerToken,
        leaseIso(now, leaseMs),
        timestamp,
        timestamp,
        timestamp,
        previous.cursorAgentId ?? null,
        previous.worktree ?? null,
        previous.baseSha ?? null,
        previous.gitConfigDigest ?? null,
        repairEvidence,
      );
      const jobResult = this.#database.prepare(`
        UPDATE jobs SET status = 'REPAIRING', current_attempt_id = ?, updated_at = ?
        WHERE id = ? AND current_attempt_id = ? AND status = 'VERIFYING'
      `).run(attemptId, timestamp, job.id, previous.id);
      if (jobResult.changes !== 1) throw new Error(`Job attempt changed concurrently: ${job.id}`);
      this.#ledger.recordEvent(
        job.id,
        attemptId,
        "REPAIR_ATTEMPT_STARTED",
        { ordinal },
        timestamp,
      );
      this.#database.exec("COMMIT");
      return this.#requireAttempt(attemptId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  failStaleSpec(
    jobId: string,
    attemptId: string,
    workerToken: string,
    errorMessage: string,
  ): Job {
    const timestamp = nowIso();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.getAttempt(attemptId);
      const job = this.get(jobId);
      if (
        !attempt
        || attempt.jobId !== jobId
        || attempt.workerToken !== workerToken
        || job?.currentAttemptId !== attemptId
      ) {
        throw new Error("Stale-spec failure does not own the active attempt lease");
      }
      const expectedJobStatus = jobStatusForAttempt(attempt.status);
      if (!expectedJobStatus || job.status !== expectedJobStatus) {
        throw new Error(`Job is not active for stale-spec failure: ${jobId}`);
      }
      if (!canTransitionAttempt(attempt.status, "FAILED")) {
        throw new Error(`Attempt cannot fail stale spec from ${attempt.status}`);
      }
      const attemptResult = this.#database.prepare(`
        UPDATE attempts SET status = 'FAILED', updated_at = ?, error_message = ?
        WHERE id = ? AND worker_token = ? AND status = ?
      `).run(timestamp, errorMessage, attemptId, workerToken, attempt.status);
      if (attemptResult.changes !== 1) {
        throw new Error("Stale-spec failure lost the active attempt lease");
      }
      const jobResult = this.#database.prepare(`
        UPDATE jobs SET status = 'STALE_SPEC', updated_at = ?, error_message = ?
        WHERE id = ? AND current_attempt_id = ? AND status = ?
      `).run(timestamp, errorMessage, jobId, attemptId, expectedJobStatus);
      if (jobResult.changes !== 1) {
        throw new Error("Stale-spec failure lost the active job");
      }
      this.#ledger.recordEvent(jobId, attemptId, "ATTEMPT_TRANSITIONED", {
        from: attempt.status,
        to: "FAILED",
      }, timestamp);
      this.#ledger.recordEvent(jobId, attemptId, "JOB_TRANSITIONED", {
        to: "STALE_SPEC",
      }, timestamp);
      this.#database.exec("COMMIT");
      return this.#requireJob(jobId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  requestCancellation(jobId: string): Job {
    return this.#delivery.requestCancellation(jobId);
  }

  isCancellationRequested(jobId: string): boolean {
    return this.#delivery.isCancellationRequested(jobId);
  }

  confirmCancellation(jobId: string, attemptId: string, workerToken: string): Job {
    return this.#delivery.confirmCancellation(jobId, attemptId, workerToken);
  }

  recordPublication(
    jobId: string,
    attemptId: string,
    workerToken: string,
    publication: PublicationRecord,
  ): Job {
    return this.#delivery.recordPublication(
      jobId,
      attemptId,
      workerToken,
      publication,
    );
  }

  completeDelivery(
    jobId: string,
    attemptId: string,
    workerToken: string,
    completion: DeliveryCompletion,
  ): Job {
    return this.#delivery.completeDelivery(
      jobId,
      attemptId,
      workerToken,
      completion,
    );
  }

  transitionJob(
    jobId: string,
    expected: readonly JobStatus[],
    next: JobStatus,
    fields: Partial<Job> = {},
  ): Job {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = expected.map(() => "?").join(", ");
      const timestamp = nowIso();
      const currentAttemptId = this.get(jobId)?.currentAttemptId;
      const result = this.#database.prepare(`
        UPDATE jobs SET status = ?, updated_at = ?,
          report_path = COALESCE(?, report_path), pr_url = COALESCE(?, pr_url),
          error_message = COALESCE(?, error_message), head_sha = COALESCE(?, head_sha),
          tree_hash = COALESCE(?, tree_hash), attestation_path = COALESCE(?, attestation_path),
          delivered_at = COALESCE(?, delivered_at), cleanup_status = COALESCE(?, cleanup_status),
          cleanup_error = COALESCE(?, cleanup_error)
        WHERE id = ? AND status IN (${placeholders})
      `).run(
        next,
        timestamp,
        fields.reportPath ?? null,
        fields.prUrl ?? null,
        fields.errorMessage ?? null,
        fields.headSha ?? null,
        fields.treeHash ?? null,
        fields.attestationPath ?? null,
        fields.deliveredAt ?? null,
        fields.cleanupStatus ?? null,
        fields.cleanupError ?? null,
        jobId,
        ...expected,
      );
      if (result.changes !== 1) throw new Error(`Job state changed concurrently: ${jobId}`);
      this.#ledger.recordEvent(
        jobId,
        currentAttemptId,
        "JOB_TRANSITIONED",
        { to: next },
        timestamp,
      );
      this.#database.exec("COMMIT");
      return this.#requireJob(jobId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  transition(id: string, next: JobStatus, fields: Partial<Job> = {}): Job {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown job: ${id}`);
    return this.transitionJob(id, [current.status], next, fields);
  }

  attachReportIfOwned(
    jobId: string,
    attemptId: string,
    workerToken: string,
    reportPath: string,
  ): boolean {
    const timestamp = nowIso();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const jobPlaceholders = reclaimableJobStatuses.map(() => "?").join(", ");
      const attemptPlaceholders = reportAttachAttemptStatuses.map(() => "?").join(", ");
      const result = this.#database.prepare(`
        UPDATE jobs
        SET report_path = ?, updated_at = ?
        WHERE id = ? AND current_attempt_id = ?
          AND (
            (
              status IN (${jobPlaceholders})
              AND EXISTS (
                SELECT 1 FROM attempts a
                WHERE a.id = ? AND a.job_id = ? AND a.worker_token = ?
                  AND a.status IN (${attemptPlaceholders})
                  AND a.lease_expires_at > ?
              )
            )
            OR EXISTS (
              SELECT 1 FROM attempts a
              WHERE a.id = ? AND a.job_id = ? AND a.worker_token = ?
                AND (
                  (jobs.status = 'BLOCKED' AND a.status = 'BLOCKED')
                  OR (jobs.status = 'FAILED' AND a.status IN ('FAILED', 'FAILED_REPAIRABLE'))
                  OR (jobs.status = 'CANCELLED' AND a.status = 'CANCELLED')
                  OR (jobs.status = 'STALE_SPEC' AND a.status = 'FAILED')
                  OR (jobs.status = 'SCOPE_VIOLATION' AND a.status = 'SCOPE_VIOLATION')
                )
            )
          )
      `).run(
        reportPath,
        timestamp,
        jobId,
        attemptId,
        ...reclaimableJobStatuses,
        attemptId,
        jobId,
        workerToken,
        ...reportAttachAttemptStatuses,
        timestamp,
        attemptId,
        jobId,
        workerToken,
      );
      this.#database.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  update(id: string, fields: Partial<Job>): void {
    this.#records.update(id, fields);
  }

  beginEffect(jobId: string, attemptId: string, kind: string, idempotencyKey: string): Effect {
    return this.#ledger.beginEffect(jobId, attemptId, kind, idempotencyKey);
  }

  getEffect(idempotencyKey: string): Effect | undefined {
    return this.#ledger.getEffect(idempotencyKey);
  }

  completeEffect(effectId: string, payload: Record<string, unknown>): Effect {
    return this.#ledger.completeEffect(effectId, payload);
  }

  failEffect(effectId: string, payload: Record<string, unknown>): Effect {
    return this.#ledger.failEffect(effectId, payload);
  }

  recordEvent(jobId: string, attemptId: string | undefined, type: string, data: Record<string, unknown>): void {
    this.#ledger.recordEvent(jobId, attemptId, type, data);
  }

  listEvents(jobId: string): JobEvent[] {
    return this.#ledger.listEvents(jobId);
  }

  metrics(): JobMetrics {
    return this.#ledger.metrics();
  }
}
