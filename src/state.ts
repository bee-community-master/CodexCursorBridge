import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STATE_SCHEMA_VERSION = 3;

export const jobStatuses = [
  "QUEUED",
  "PREPARING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PUBLISHING",
  "DELIVERED_REVIEW_REQUIRED",
  "CANCEL_REQUESTED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "STALE_SPEC",
  "SCOPE_VIOLATION",
  // Legacy terminal state retained for forward migration of v1 databases.
  "DONE",
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const attemptStatuses = [
  "PREPARING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PUBLISHING",
  "FAILED_REPAIRABLE",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "SCOPE_VIOLATION",
] as const;
export type AttemptStatus = (typeof attemptStatuses)[number];

export const terminalJobStatuses = new Set<JobStatus>([
  "DELIVERED_REVIEW_REQUIRED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "STALE_SPEC",
  "SCOPE_VIOLATION",
  "DONE",
]);
const reclaimableJobStatuses: JobStatus[] = [
  "PREPARING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PUBLISHING",
  "CANCEL_REQUESTED",
];
const allowedAttemptTransitions: Record<AttemptStatus, ReadonlySet<AttemptStatus>> = {
  PREPARING: new Set(["IMPLEMENTING", "FAILED", "CANCELLED"]),
  IMPLEMENTING: new Set(["VERIFYING", "BLOCKED", "FAILED", "CANCELLED"]),
  VERIFYING: new Set([
    "PUBLISHING",
    "FAILED_REPAIRABLE",
    "FAILED",
    "CANCELLED",
    "SCOPE_VIOLATION",
  ]),
  REPAIRING: new Set(["IMPLEMENTING", "FAILED", "CANCELLED"]),
  PUBLISHING: new Set(["COMPLETED", "FAILED", "CANCELLED", "SCOPE_VIOLATION"]),
  FAILED_REPAIRABLE: new Set(),
  COMPLETED: new Set(),
  BLOCKED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  SCOPE_VIOLATION: new Set(),
};

export interface CreateJobInput {
  repositoryAlias: string;
  taskId: string;
  specVersion: number;
  specHash: string;
  taskCommitSha: string;
  taskBlobSha: string;
  targetOrigin: string;
  targetBaseSha: string;
  policyVersion: number;
  maxAttempts: number;
}

export interface Job extends CreateJobInput {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  currentAttemptId?: string;
  cancelRequestedAt?: string;
  deliveredAt?: string;
  headSha?: string;
  treeHash?: string;
  attestationPath?: string;
  cleanupStatus?: "PENDING" | "COMPLETED" | "FAILED";
  cleanupError?: string;
  // Compatibility fields from the v1 schema.
  pid?: number;
  cursorAgentId?: string;
  cursorRunId?: string;
  worktree?: string;
  baseSha?: string;
  reportPath?: string;
  logPath?: string;
  prUrl?: string;
  errorMessage?: string;
}

export interface Attempt {
  id: string;
  jobId: string;
  ordinal: number;
  status: AttemptStatus;
  workerToken: string;
  leaseExpiresAt: string;
  heartbeatAt: string;
  createdAt: string;
  updatedAt: string;
  cursorAgentId?: string;
  cursorRunId?: string;
  cursorRequestId?: string;
  worktree?: string;
  baseSha?: string;
  gitConfigDigest?: string;
  headSha?: string;
  treeHash?: string;
  outcome?: "completed" | "blocked" | "needs_input";
  outcomeSummary?: string;
  outcomeReason?: string;
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ClaimedWork {
  job: Job;
  attempt: Attempt;
  resumed: boolean;
}

export interface JobEvent {
  sequence: number;
  jobId: string;
  attemptId?: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface Effect {
  id: string;
  jobId: string;
  attemptId: string;
  kind: string;
  idempotencyKey: string;
  status: "STARTED" | "COMPLETED" | "FAILED";
  payload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface JobMetrics {
  totalJobs: number;
  activeJobs: number;
  deliveredJobs: number;
  firstAttemptDeliveries: number;
  repairedDeliveries: number;
  blockedJobs: number;
  failedJobs: number;
  cancelledJobs: number;
  firstAttemptDeliveryRate: number;
}

export interface DeliveryCompletion {
  prUrl: string;
  headSha: string;
  treeHash: string;
  attestationPath: string;
  reportPath: string;
  deliveredAt: string;
}

export type PublicationRecord = Pick<DeliveryCompletion, "prUrl" | "headSha" | "treeHash">;

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  return typeof row[key] === "string" ? String(row[key]) : undefined;
}

function optionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  return typeof row[key] === "number" ? Number(row[key]) : undefined;
}

function rowToJob(row: Record<string, unknown>): Job {
  const currentAttemptId = optionalString(row, "current_attempt_id");
  const cancelRequestedAt = optionalString(row, "cancel_requested_at");
  const deliveredAt = optionalString(row, "delivered_at");
  const headSha = optionalString(row, "head_sha");
  const treeHash = optionalString(row, "tree_hash");
  const attestationPath = optionalString(row, "attestation_path");
  const cleanupStatus = optionalString(row, "cleanup_status") as Job["cleanupStatus"];
  const cleanupError = optionalString(row, "cleanup_error");
  const pid = optionalNumber(row, "pid");
  const cursorAgentId = optionalString(row, "cursor_agent_id");
  const cursorRunId = optionalString(row, "cursor_run_id");
  const worktree = optionalString(row, "worktree");
  const baseSha = optionalString(row, "base_sha");
  const reportPath = optionalString(row, "report_path");
  const logPath = optionalString(row, "log_path");
  const prUrl = optionalString(row, "pr_url");
  const errorMessage = optionalString(row, "error_message");
  return {
    id: String(row.id),
    repositoryAlias: String(row.repository_alias),
    taskId: String(row.task_id),
    specVersion: Number(row.spec_version),
    specHash: String(row.spec_hash),
    taskCommitSha: optionalString(row, "task_commit_sha") ?? "",
    taskBlobSha: optionalString(row, "task_blob_sha") ?? "",
    targetOrigin: optionalString(row, "target_origin") ?? "",
    targetBaseSha: optionalString(row, "target_base_sha") ?? optionalString(row, "base_sha") ?? "",
    policyVersion: optionalNumber(row, "policy_version") ?? 1,
    maxAttempts: optionalNumber(row, "max_attempts") ?? 1,
    status: String(row.status) as JobStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(currentAttemptId ? { currentAttemptId } : {}),
    ...(cancelRequestedAt ? { cancelRequestedAt } : {}),
    ...(deliveredAt ? { deliveredAt } : {}),
    ...(headSha ? { headSha } : {}),
    ...(treeHash ? { treeHash } : {}),
    ...(attestationPath ? { attestationPath } : {}),
    ...(cleanupStatus ? { cleanupStatus } : {}),
    ...(cleanupError ? { cleanupError } : {}),
    ...(pid === undefined ? {} : { pid }),
    ...(cursorAgentId ? { cursorAgentId } : {}),
    ...(cursorRunId ? { cursorRunId } : {}),
    ...(worktree ? { worktree } : {}),
    ...(baseSha ? { baseSha } : {}),
    ...(reportPath ? { reportPath } : {}),
    ...(logPath ? { logPath } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function rowToAttempt(row: Record<string, unknown>): Attempt {
  const cursorAgentId = optionalString(row, "cursor_agent_id");
  const cursorRunId = optionalString(row, "cursor_run_id");
  const cursorRequestId = optionalString(row, "cursor_request_id");
  const worktree = optionalString(row, "worktree");
  const baseSha = optionalString(row, "base_sha");
  const gitConfigDigest = optionalString(row, "git_config_digest");
  const headSha = optionalString(row, "head_sha");
  const treeHash = optionalString(row, "tree_hash");
  const outcome = optionalString(row, "outcome") as Attempt["outcome"];
  const outcomeSummary = optionalString(row, "outcome_summary");
  const outcomeReason = optionalString(row, "outcome_reason");
  const errorMessage = optionalString(row, "error_message");
  const inputTokens = optionalNumber(row, "input_tokens");
  const outputTokens = optionalNumber(row, "output_tokens");
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    ordinal: Number(row.ordinal),
    status: String(row.status) as AttemptStatus,
    workerToken: String(row.worker_token),
    leaseExpiresAt: String(row.lease_expires_at),
    heartbeatAt: String(row.heartbeat_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(cursorAgentId ? { cursorAgentId } : {}),
    ...(cursorRunId ? { cursorRunId } : {}),
    ...(cursorRequestId ? { cursorRequestId } : {}),
    ...(worktree ? { worktree } : {}),
    ...(baseSha ? { baseSha } : {}),
    ...(gitConfigDigest ? { gitConfigDigest } : {}),
    ...(headSha ? { headSha } : {}),
    ...(treeHash ? { treeHash } : {}),
    ...(outcome ? { outcome } : {}),
    ...(outcomeSummary ? { outcomeSummary } : {}),
    ...(outcomeReason ? { outcomeReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function rowToEffect(row: Record<string, unknown>): Effect {
  const payload = optionalString(row, "payload_json");
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    attemptId: String(row.attempt_id),
    kind: String(row.kind),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as Effect["status"],
    ...(payload ? { payload: JSON.parse(payload) as Record<string, unknown> } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function leaseIso(now: Date, leaseMs: number): string {
  return new Date(now.getTime() + leaseMs).toISOString();
}

export class JobStore {
  readonly #database: DatabaseSync;

  constructor(file: string) {
    const directory = path.dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.#database = new DatabaseSync(file);
    try {
      this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      this.#migrate();
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

  #migrate(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    const currentVersion = Number(versionRow.user_version);
    if (currentVersion > STATE_SCHEMA_VERSION) {
      throw new Error(
        `Database uses newer schema version ${currentVersion}; this bridge supports ${STATE_SCHEMA_VERSION}`,
      );
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, repository_alias TEXT NOT NULL, task_id TEXT NOT NULL,
          spec_version INTEGER NOT NULL, spec_hash TEXT NOT NULL, status TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pid INTEGER,
          cursor_agent_id TEXT, cursor_run_id TEXT, worktree TEXT, base_sha TEXT,
          report_path TEXT, log_path TEXT, pr_url TEXT, error_message TEXT,
          task_commit_sha TEXT, task_blob_sha TEXT, target_origin TEXT, target_base_sha TEXT,
          policy_version INTEGER, max_attempts INTEGER NOT NULL DEFAULT 1,
          current_attempt_id TEXT, cancel_requested_at TEXT, delivered_at TEXT,
          head_sha TEXT, tree_hash TEXT, attestation_path TEXT,
          cleanup_status TEXT, cleanup_error TEXT,
          UNIQUE(repository_alias, task_id, spec_hash)
        );
      `);
      const columns = new Set(
        (this.#database.prepare("PRAGMA table_info(jobs)").all() as Array<Record<string, unknown>>)
          .map((row) => String(row.name)),
      );
      const additions: Record<string, string> = {
        task_commit_sha: "TEXT",
        task_blob_sha: "TEXT",
        target_origin: "TEXT",
        target_base_sha: "TEXT",
        policy_version: "INTEGER",
        max_attempts: "INTEGER NOT NULL DEFAULT 1",
        current_attempt_id: "TEXT",
        cancel_requested_at: "TEXT",
        delivered_at: "TEXT",
        head_sha: "TEXT",
        tree_hash: "TEXT",
        attestation_path: "TEXT",
        cleanup_status: "TEXT",
        cleanup_error: "TEXT",
      };
      for (const [column, definition] of Object.entries(additions)) {
        if (!columns.has(column)) this.#database.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`);
      }
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
          status TEXT NOT NULL, worker_token TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          cursor_agent_id TEXT, cursor_run_id TEXT, cursor_request_id TEXT,
          worktree TEXT, base_sha TEXT, git_config_digest TEXT, head_sha TEXT, tree_hash TEXT,
          outcome TEXT, outcome_summary TEXT, outcome_reason TEXT, error_message TEXT,
          input_tokens INTEGER, output_tokens INTEGER,
          UNIQUE(job_id, ordinal), FOREIGN KEY(job_id) REFERENCES jobs(id)
        );
        CREATE INDEX IF NOT EXISTS attempts_job_idx ON attempts(job_id, ordinal);
        CREATE INDEX IF NOT EXISTS attempts_lease_idx ON attempts(lease_expires_at);
        CREATE TABLE IF NOT EXISTS job_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
          attempt_id TEXT, type TEXT NOT NULL, data_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, sequence);
        CREATE TABLE IF NOT EXISTS effects (
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
          kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL, payload_json TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS effects_job_idx ON effects(job_id, kind);
        UPDATE jobs
        SET status = 'FAILED',
            error_message = COALESCE(
              error_message,
              'Legacy active job cannot be resumed because immutable task provenance is unavailable'
            )
        WHERE (task_commit_sha IS NULL OR task_commit_sha = '')
          AND status IN ('QUEUED', 'RUNNING', 'PREPARING', 'IMPLEMENTING', 'VERIFYING',
                         'REPAIRING', 'COMMITTING', 'PUSHING', 'PUBLISHING');
        PRAGMA user_version = ${STATE_SCHEMA_VERSION};
      `);
      const attemptColumns = new Set(
        (this.#database.prepare("PRAGMA table_info(attempts)").all() as Array<Record<string, unknown>>)
          .map((row) => String(row.name)),
      );
      if (!attemptColumns.has("outcome_summary")) {
        this.#database.exec("ALTER TABLE attempts ADD COLUMN outcome_summary TEXT");
      }
      if (!attemptColumns.has("git_config_digest")) {
        this.#database.exec("ALTER TABLE attempts ADD COLUMN git_config_digest TEXT");
      }
      this.#database.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION}`);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  schemaVersion(): number {
    const row = this.#database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    return Number(row.user_version);
  }

  createOrGet(input: CreateJobInput): Job {
    const now = nowIso();
    const id = randomUUID();
    this.#database.prepare(`
      INSERT INTO jobs (
        id, repository_alias, task_id, spec_version, spec_hash, status,
        created_at, updated_at, task_commit_sha, task_blob_sha, target_origin,
        target_base_sha, policy_version, max_attempts, cleanup_status
      ) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
      ON CONFLICT(repository_alias, task_id, spec_hash) DO NOTHING
    `).run(
      id,
      input.repositoryAlias,
      input.taskId,
      input.specVersion,
      input.specHash,
      now,
      now,
      input.taskCommitSha,
      input.taskBlobSha,
      input.targetOrigin,
      input.targetBaseSha,
      input.policyVersion,
      input.maxAttempts,
    );
    const job = this.#database.prepare(
      "SELECT * FROM jobs WHERE repository_alias = ? AND task_id = ? AND spec_hash = ?",
    ).get(input.repositoryAlias, input.taskId, input.specHash) as Record<string, unknown> | undefined;
    if (!job) throw new Error("Failed to create or load job");
    const parsed = rowToJob(job);
    if (
      parsed.specVersion !== input.specVersion
      || parsed.taskBlobSha !== input.taskBlobSha
      || parsed.targetOrigin !== input.targetOrigin
      || parsed.targetBaseSha !== input.targetBaseSha
      || parsed.policyVersion !== input.policyVersion
      || parsed.maxAttempts !== input.maxAttempts
    ) {
      throw new Error("Existing job metadata does not match the immutable RunSpec");
    }
    if (parsed.id === id) this.#recordEvent(parsed.id, undefined, "JOB_CREATED", { status: parsed.status }, now);
    return parsed;
  }

  get(id: string): Job | undefined {
    const row = this.#database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToJob(row) : undefined;
  }

  getAttempt(id: string): Attempt | undefined {
    const row = this.#database.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToAttempt(row) : undefined;
  }

  listAttempts(jobId: string): Attempt[] {
    return (this.#database.prepare(
      "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal",
    ).all(jobId) as Array<Record<string, unknown>>).map(rowToAttempt);
  }

  assertActiveAttempt(
    jobId: string,
    attemptId: string,
    workerToken: string,
    expectedStatus: AttemptStatus,
  ): Attempt {
    const expectedJobStatus = this.#jobStatusForAttempt(expectedStatus);
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
        attempt = this.getAttempt(existing.id)!;
        if (attempt.workerToken !== workerToken) {
          throw new Error(`Expired attempt was reclaimed concurrently: ${existing.id}`);
        }
        resumed = true;
        this.#recordEvent(job.id, attempt.id, "ATTEMPT_RECLAIMED", { ordinal: attempt.ordinal }, timestamp);
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
        attempt = this.getAttempt(attemptId)!;
        job = this.get(job.id)!;
        this.#recordEvent(job.id, attempt.id, "JOB_CLAIMED", { ordinal }, timestamp);
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
    return this.getAttempt(attemptId)!;
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
        && !allowedAttemptTransitions[attempt.status].has(next)
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
        : this.#jobStatusForAttempt(next);
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
      this.#recordEvent(attempt.jobId, attemptId, "ATTEMPT_TRANSITIONED", {
        from: attempt.status,
        to: next,
      }, timestamp);
      this.#database.exec("COMMIT");
      return this.getAttempt(attemptId)!;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #jobStatusForAttempt(status: AttemptStatus): JobStatus | undefined {
    if (["PREPARING", "IMPLEMENTING", "VERIFYING", "REPAIRING", "PUBLISHING"].includes(status)) {
      return status as JobStatus;
    }
    if (status === "BLOCKED") return "BLOCKED";
    if (status === "FAILED") return "FAILED";
    if (status === "CANCELLED") return "CANCELLED";
    if (status === "SCOPE_VIOLATION") return "SCOPE_VIOLATION";
    return undefined;
  }

  updateAttempt(attemptId: string, workerToken: string, fields: Partial<Attempt>): Attempt {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`);
    return this.transitionAttempt(attemptId, workerToken, [attempt.status], attempt.status, fields);
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
      this.#recordEvent(job.id, attemptId, "REPAIR_ATTEMPT_STARTED", { ordinal }, timestamp);
      this.#database.exec("COMMIT");
      return this.getAttempt(attemptId)!;
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
      const expectedJobStatus = this.#jobStatusForAttempt(attempt.status);
      if (!expectedJobStatus || job.status !== expectedJobStatus) {
        throw new Error(`Job is not active for stale-spec failure: ${jobId}`);
      }
      if (!allowedAttemptTransitions[attempt.status].has("FAILED")) {
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
      this.#recordEvent(jobId, attemptId, "ATTEMPT_TRANSITIONED", {
        from: attempt.status,
        to: "FAILED",
      }, timestamp);
      this.#recordEvent(jobId, attemptId, "JOB_TRANSITIONED", {
        to: "STALE_SPEC",
      }, timestamp);
      this.#database.exec("COMMIT");
      return this.get(jobId)!;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  requestCancellation(jobId: string): Job {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const job = this.get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      if (
        terminalJobStatuses.has(job.status)
        || job.status === "CANCEL_REQUESTED"
        || job.status === "PUBLISHING"
      ) {
        this.#database.exec("COMMIT");
        return job;
      }
      const timestamp = nowIso();
      let result;
      if (job.status === "QUEUED") {
        result = this.#database.prepare(`
          UPDATE jobs SET status = 'CANCELLED', cancel_requested_at = ?, updated_at = ?
          WHERE id = ? AND status = 'QUEUED'
        `).run(timestamp, timestamp, jobId);
      } else {
        result = this.#database.prepare(`
          UPDATE jobs SET status = 'CANCEL_REQUESTED', cancel_requested_at = ?, updated_at = ?
          WHERE id = ? AND status = ?
        `).run(timestamp, timestamp, jobId, job.status);
      }
      if (result.changes !== 1) throw new Error(`Job state changed concurrently: ${jobId}`);
      this.#recordEvent(jobId, job.currentAttemptId, "CANCELLATION_REQUESTED", {}, timestamp);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.get(jobId)!;
  }

  isCancellationRequested(jobId: string): boolean {
    return this.get(jobId)?.status === "CANCEL_REQUESTED";
  }

  confirmCancellation(jobId: string, attemptId: string, workerToken: string): Job {
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
        throw new Error("Cancellation confirmation does not own the active attempt lease");
      }
      if (job.status !== "CANCEL_REQUESTED") throw new Error("Job has no pending cancellation");
      const attemptResult = this.#database.prepare(`
        UPDATE attempts SET status = 'CANCELLED', updated_at = ?
        WHERE id = ? AND worker_token = ?
          AND status IN ('PREPARING', 'IMPLEMENTING', 'VERIFYING', 'REPAIRING', 'PUBLISHING')
      `).run(timestamp, attemptId, workerToken);
      if (attemptResult.changes !== 1) {
        throw new Error("Cancellation confirmation lost the active attempt lease");
      }
      const jobResult = this.#database.prepare(`
        UPDATE jobs SET status = 'CANCELLED', updated_at = ?
        WHERE id = ? AND status = 'CANCEL_REQUESTED' AND current_attempt_id = ?
      `).run(timestamp, jobId, attemptId);
      if (jobResult.changes !== 1) {
        throw new Error("Cancellation confirmation lost the active job");
      }
      this.#recordEvent(jobId, attemptId, "CANCELLATION_CONFIRMED", {}, timestamp);
      this.#database.exec("COMMIT");
      return this.get(jobId)!;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordPublication(
    jobId: string,
    attemptId: string,
    workerToken: string,
    publication: PublicationRecord,
  ): Job {
    const timestamp = nowIso();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.assertActiveAttempt(
        jobId,
        attemptId,
        workerToken,
        "PUBLISHING",
      );
      if (!attempt.treeHash || attempt.treeHash !== publication.treeHash) {
        throw new Error("Published tree does not match the active attempt");
      }
      const result = this.#database.prepare(`
        UPDATE jobs
        SET pr_url = ?, head_sha = ?, tree_hash = ?, updated_at = ?
        WHERE id = ? AND status = 'PUBLISHING' AND current_attempt_id = ?
      `).run(
        publication.prUrl,
        publication.headSha,
        publication.treeHash,
        timestamp,
        jobId,
        attemptId,
      );
      if (result.changes !== 1) throw new Error("Publication record lost the active job lease");
      this.#recordEvent(jobId, attemptId, "PUBLICATION_RECORDED", {
        prUrl: publication.prUrl,
        headSha: publication.headSha,
        treeHash: publication.treeHash,
      }, timestamp);
      this.#database.exec("COMMIT");
      return this.get(jobId)!;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  completeDelivery(
    jobId: string,
    attemptId: string,
    workerToken: string,
    completion: DeliveryCompletion,
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
        throw new Error("Delivery completion does not own the active attempt lease");
      }
      if (job.status === "CANCEL_REQUESTED") {
        throw new Error(`Job cancellation is pending: ${job.id}`);
      }
      if (attempt.status !== "PUBLISHING" || job.status !== "PUBLISHING") {
        throw new Error(`Job is not ready for delivery completion: ${job.id}`);
      }
      if (
        job.prUrl !== completion.prUrl
        || job.headSha !== completion.headSha
        || job.treeHash !== completion.treeHash
        || attempt.treeHash !== completion.treeHash
      ) {
        throw new Error("Delivery completion does not match the recorded publication");
      }
      const attemptResult = this.#database.prepare(`
        UPDATE attempts
        SET status = 'COMPLETED', updated_at = ?, head_sha = ?, tree_hash = ?
        WHERE id = ? AND worker_token = ? AND status = 'PUBLISHING'
      `).run(
        timestamp,
        completion.headSha,
        completion.treeHash,
        attemptId,
        workerToken,
      );
      if (attemptResult.changes !== 1) {
        throw new Error("Delivery completion lost the active attempt lease");
      }
      const jobResult = this.#database.prepare(`
        UPDATE jobs
        SET status = 'DELIVERED_REVIEW_REQUIRED', updated_at = ?,
            pr_url = ?, head_sha = ?, tree_hash = ?, attestation_path = ?,
            report_path = ?, delivered_at = ?
        WHERE id = ? AND status = 'PUBLISHING' AND current_attempt_id = ?
      `).run(
        timestamp,
        completion.prUrl,
        completion.headSha,
        completion.treeHash,
        completion.attestationPath,
        completion.reportPath,
        completion.deliveredAt,
        jobId,
        attemptId,
      );
      if (jobResult.changes !== 1) {
        throw new Error("Delivery completion lost the active job");
      }
      this.#recordEvent(jobId, attemptId, "ATTEMPT_TRANSITIONED", {
        from: "PUBLISHING",
        to: "COMPLETED",
      }, timestamp);
      this.#recordEvent(jobId, attemptId, "JOB_TRANSITIONED", {
        to: "DELIVERED_REVIEW_REQUIRED",
      }, timestamp);
      this.#database.exec("COMMIT");
      return this.get(jobId)!;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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
      this.#recordEvent(jobId, currentAttemptId, "JOB_TRANSITIONED", { to: next }, timestamp);
      this.#database.exec("COMMIT");
      return this.get(jobId)!;
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

  update(id: string, fields: Partial<Job>): void {
    if (fields.status !== undefined) throw new Error("Use transitionJob to update status");
    const columns: Record<string, unknown> = {
      pid: fields.pid,
      cursor_agent_id: fields.cursorAgentId,
      cursor_run_id: fields.cursorRunId,
      worktree: fields.worktree,
      base_sha: fields.baseSha,
      report_path: fields.reportPath,
      log_path: fields.logPath,
      pr_url: fields.prUrl,
      error_message: fields.errorMessage,
      head_sha: fields.headSha,
      tree_hash: fields.treeHash,
      attestation_path: fields.attestationPath,
      cleanup_status: fields.cleanupStatus,
      cleanup_error: fields.cleanupError,
    };
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => {
      if (typeof value === "string" || typeof value === "number" || value === null) return value;
      throw new Error("Unsupported SQLite job field value");
    });
    const result = this.#database.prepare(`UPDATE jobs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...values, nowIso(), id);
    if (result.changes !== 1) throw new Error(`Unknown job: ${id}`);
  }

  beginEffect(jobId: string, attemptId: string, kind: string, idempotencyKey: string): Effect {
    const now = nowIso();
    const id = randomUUID();
    this.#database.prepare(`
      INSERT INTO effects (
        id, job_id, attempt_id, kind, idempotency_key, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'STARTED', ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(id, jobId, attemptId, kind, idempotencyKey, now, now);
    const effect = this.getEffect(idempotencyKey);
    if (!effect) throw new Error("Failed to create or load effect");
    if (effect.jobId !== jobId || effect.attemptId !== attemptId || effect.kind !== kind) {
      throw new Error("Existing effect does not match the requested durable operation");
    }
    return effect;
  }

  getEffect(idempotencyKey: string): Effect | undefined {
    const row = this.#database.prepare("SELECT * FROM effects WHERE idempotency_key = ?")
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? rowToEffect(row) : undefined;
  }

  completeEffect(effectId: string, payload: Record<string, unknown>): Effect {
    const now = nowIso();
    const result = this.#database.prepare(`
      UPDATE effects SET status = 'COMPLETED', payload_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(payload), now, effectId);
    if (result.changes !== 1) throw new Error(`Unknown effect: ${effectId}`);
    const row = this.#database.prepare("SELECT * FROM effects WHERE id = ?").get(effectId) as Record<string, unknown>;
    return rowToEffect(row);
  }

  failEffect(effectId: string, payload: Record<string, unknown>): Effect {
    const now = nowIso();
    const result = this.#database.prepare(`
      UPDATE effects SET status = 'FAILED', payload_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(payload), now, effectId);
    if (result.changes !== 1) throw new Error(`Unknown effect: ${effectId}`);
    const row = this.#database.prepare("SELECT * FROM effects WHERE id = ?").get(effectId) as Record<string, unknown>;
    return rowToEffect(row);
  }

  recordEvent(jobId: string, attemptId: string | undefined, type: string, data: Record<string, unknown>): void {
    this.#recordEvent(jobId, attemptId, type, data, nowIso());
  }

  #recordEvent(
    jobId: string,
    attemptId: string | undefined,
    type: string,
    data: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.#database.prepare(`
      INSERT INTO job_events (job_id, attempt_id, type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(jobId, attemptId ?? null, type, JSON.stringify(data), createdAt);
  }

  listEvents(jobId: string): JobEvent[] {
    return (this.#database.prepare(
      "SELECT * FROM job_events WHERE job_id = ? ORDER BY sequence",
    ).all(jobId) as Array<Record<string, unknown>>).map((row) => {
      const attemptId = optionalString(row, "attempt_id");
      return {
        sequence: Number(row.sequence),
        jobId: String(row.job_id),
        ...(attemptId ? { attemptId } : {}),
        type: String(row.type),
        data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
        createdAt: String(row.created_at),
      };
    });
  }

  metrics(): JobMetrics {
    const row = this.#database.prepare(`
      SELECT
        COUNT(*) AS total_jobs,
        SUM(CASE WHEN status NOT IN (
          'DELIVERED_REVIEW_REQUIRED', 'BLOCKED', 'FAILED', 'CANCELLED',
          'STALE_SPEC', 'SCOPE_VIOLATION', 'DONE'
        ) THEN 1 ELSE 0 END) AS active_jobs,
        SUM(CASE WHEN status = 'DELIVERED_REVIEW_REQUIRED' THEN 1 ELSE 0 END) AS delivered_jobs,
        SUM(CASE WHEN status = 'DELIVERED_REVIEW_REQUIRED'
          AND (SELECT COUNT(*) FROM attempts a WHERE a.job_id = jobs.id) = 1
          THEN 1 ELSE 0 END) AS first_attempt_deliveries,
        SUM(CASE WHEN status = 'DELIVERED_REVIEW_REQUIRED'
          AND (SELECT COUNT(*) FROM attempts a WHERE a.job_id = jobs.id) > 1
          THEN 1 ELSE 0 END) AS repaired_deliveries,
        SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked_jobs,
        SUM(CASE WHEN status IN ('FAILED', 'STALE_SPEC', 'SCOPE_VIOLATION')
          THEN 1 ELSE 0 END) AS failed_jobs,
        SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_jobs
      FROM jobs
    `).get() as Record<string, unknown>;
    const deliveredJobs = Number(row.delivered_jobs ?? 0);
    const firstAttemptDeliveries = Number(row.first_attempt_deliveries ?? 0);
    return {
      totalJobs: Number(row.total_jobs ?? 0),
      activeJobs: Number(row.active_jobs ?? 0),
      deliveredJobs,
      firstAttemptDeliveries,
      repairedDeliveries: Number(row.repaired_deliveries ?? 0),
      blockedJobs: Number(row.blocked_jobs ?? 0),
      failedJobs: Number(row.failed_jobs ?? 0),
      cancelledJobs: Number(row.cancelled_jobs ?? 0),
      firstAttemptDeliveryRate: deliveredJobs === 0
        ? 0
        : firstAttemptDeliveries / deliveredJobs,
    };
  }
}
