import type { DatabaseSync } from "node:sqlite";
import {
  terminalJobStatuses,
  type Attempt,
  type AttemptStatus,
  type DeliveryCompletion,
  type Job,
  type PublicationRecord,
} from "../domain/job.js";
import type { SqliteJobRecords } from "./sqlite-job-records.js";
import type { SqliteStateLedger } from "./sqlite-state-ledger.js";

type ActiveAttemptAssertion = (
  jobId: string,
  attemptId: string,
  workerToken: string,
  expectedStatus: AttemptStatus,
) => Attempt;

function nowIso(): string {
  return new Date().toISOString();
}

export class SqliteDeliveryLifecycle {
  readonly #database: DatabaseSync;
  readonly #records: SqliteJobRecords;
  readonly #ledger: SqliteStateLedger;
  readonly #assertActiveAttempt: ActiveAttemptAssertion;

  constructor(
    database: DatabaseSync,
    records: SqliteJobRecords,
    ledger: SqliteStateLedger,
    assertActiveAttempt: ActiveAttemptAssertion,
  ) {
    this.#database = database;
    this.#records = records;
    this.#ledger = ledger;
    this.#assertActiveAttempt = assertActiveAttempt;
  }

  requestCancellation(jobId: string): Job {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const job = this.#records.get(jobId);
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
      const result = job.status === "QUEUED"
        ? this.#database.prepare(`
          UPDATE jobs SET status = 'CANCELLED', cancel_requested_at = ?, updated_at = ?
          WHERE id = ? AND status = 'QUEUED'
        `).run(timestamp, timestamp, jobId)
        : this.#database.prepare(`
          UPDATE jobs SET status = 'CANCEL_REQUESTED', cancel_requested_at = ?, updated_at = ?
          WHERE id = ? AND status = ?
        `).run(timestamp, timestamp, jobId, job.status);
      if (result.changes !== 1) throw new Error(`Job state changed concurrently: ${jobId}`);
      this.#ledger.recordEvent(
        jobId,
        job.currentAttemptId,
        "CANCELLATION_REQUESTED",
        {},
        timestamp,
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.#records.get(jobId)!;
  }

  isCancellationRequested(jobId: string): boolean {
    return this.#records.get(jobId)?.status === "CANCEL_REQUESTED";
  }

  confirmCancellation(
    jobId: string,
    attemptId: string,
    workerToken: string,
  ): Job {
    const timestamp = nowIso();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.#records.getAttempt(attemptId);
      const job = this.#records.get(jobId);
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
      this.#ledger.recordEvent(
        jobId,
        attemptId,
        "CANCELLATION_CONFIRMED",
        {},
        timestamp,
      );
      this.#database.exec("COMMIT");
      return this.#records.get(jobId)!;
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
      const attempt = this.#assertActiveAttempt(
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
      if (result.changes !== 1) {
        throw new Error("Publication record lost the active job lease");
      }
      this.#ledger.recordEvent(jobId, attemptId, "PUBLICATION_RECORDED", {
        prUrl: publication.prUrl,
        headSha: publication.headSha,
        treeHash: publication.treeHash,
      }, timestamp);
      this.#database.exec("COMMIT");
      return this.#records.get(jobId)!;
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
      const attempt = this.#records.getAttempt(attemptId);
      const job = this.#records.get(jobId);
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
      this.#ledger.recordEvent(jobId, attemptId, "ATTEMPT_TRANSITIONED", {
        from: "PUBLISHING",
        to: "COMPLETED",
      }, timestamp);
      this.#ledger.recordEvent(jobId, attemptId, "JOB_TRANSITIONED", {
        to: "DELIVERED_REVIEW_REQUIRED",
      }, timestamp);
      this.#database.exec("COMMIT");
      return this.#records.get(jobId)!;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
