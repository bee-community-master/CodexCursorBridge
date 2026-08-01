import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Attempt,
  ClaimedWork,
  Job,
  JobStatus,
} from "../domain/job.js";
import {
  rowToAttempt,
  rowToJob,
} from "./sqlite-state-mappers.js";
import type { SqliteStateLedger } from "./sqlite-state-ledger.js";

const reclaimableJobStatuses: JobStatus[] = [
  "PREPARING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PUBLISHING",
  "CANCEL_REQUESTED",
];

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function leaseIso(now: Date, leaseMs: number): string {
  return new Date(now.getTime() + leaseMs).toISOString();
}

export class SqliteClaimLifecycle {
  readonly #database: DatabaseSync;
  readonly #ledger: SqliteStateLedger;

  constructor(database: DatabaseSync, ledger: SqliteStateLedger) {
    this.#database = database;
    this.#ledger = ledger;
  }

  claimNext(
    workerToken: string,
    leaseMs: number,
    now = new Date(),
    protectedWorkerToken?: string,
  ): ClaimedWork | undefined {
    return this.#claim(workerToken, leaseMs, now, true, protectedWorkerToken);
  }

  claimExpired(workerToken: string, leaseMs: number, now = new Date()): ClaimedWork | undefined {
    return this.#claim(workerToken, leaseMs, now, false, workerToken);
  }

  #claim(
    workerToken: string,
    leaseMs: number,
    now: Date,
    includeQueued: boolean,
    protectedWorkerToken?: string,
  ): ClaimedWork | undefined {
    const timestamp = nowIso(now);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = reclaimableJobStatuses.map(() => "?").join(", ");
      const queuedClause = includeQueued ? "j.status = 'QUEUED' OR" : "";
      const orderBy = includeQueued
        ? "j.created_at, j.id"
        : "a.lease_expires_at, j.created_at, j.id";
      const excludedWorkerToken = protectedWorkerToken;
      const ownerClause = excludedWorkerToken === undefined ? "" : " AND a.worker_token <> ?";
      const row = this.#database.prepare(`
        SELECT j.* FROM jobs j
        LEFT JOIN attempts a ON a.id = j.current_attempt_id
        WHERE ${queuedClause}
          (j.status IN (${placeholders}) AND a.lease_expires_at <= ?${ownerClause})
        ORDER BY ${orderBy}
        LIMIT 1
      `).get(
        ...reclaimableJobStatuses,
        timestamp,
        ...(excludedWorkerToken === undefined ? [] : [excludedWorkerToken]),
      ) as Record<string, unknown> | undefined;
      if (!row) {
        this.#database.exec("COMMIT");
        return undefined;
      }

      let job = rowToJob(row);
      let attempt: Attempt;
      let resumed = false;
      if (job.currentAttemptId) {
        const existing = this.#requireAttempt(job.currentAttemptId);
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

  #requireJob(id: string): Job {
    const row = this.#database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Job disappeared from state storage: ${id}`);
    return rowToJob(row);
  }

  #requireAttempt(id: string): Attempt {
    const row = this.#database.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Current attempt is missing: ${id}`);
    return rowToAttempt(row);
  }
}
