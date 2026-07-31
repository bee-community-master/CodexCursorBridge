import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Effect,
  JobEvent,
  JobMetrics,
} from "../domain/job.js";
import type {
  PendingRunEvent,
  RunEventDeliveryState,
} from "../application/workflow-ports.js";
import {
  optionalString,
  rowToEffect,
} from "./sqlite-state-mappers.js";

function nowIso(): string {
  return new Date().toISOString();
}

export class SqliteStateLedger {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  beginEffect(
    jobId: string,
    attemptId: string,
    kind: string,
    idempotencyKey: string,
  ): Effect {
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
    return this.#finishEffect(effectId, "COMPLETED", payload);
  }

  failEffect(effectId: string, payload: Record<string, unknown>): Effect {
    return this.#finishEffect(effectId, "FAILED", payload);
  }

  #finishEffect(
    effectId: string,
    status: "COMPLETED" | "FAILED",
    payload: Record<string, unknown>,
  ): Effect {
    const result = this.#database.prepare(`
      UPDATE effects SET status = ?, payload_json = ?, updated_at = ? WHERE id = ?
    `).run(status, JSON.stringify(payload), nowIso(), effectId);
    if (result.changes !== 1) throw new Error(`Unknown effect: ${effectId}`);
    const row = this.#database.prepare("SELECT * FROM effects WHERE id = ?")
      .get(effectId) as Record<string, unknown>;
    return rowToEffect(row);
  }

  recordEvent(
    jobId: string,
    attemptId: string | undefined,
    type: string,
    data: Record<string, unknown>,
    createdAt = nowIso(),
  ): void {
    this.#database.prepare(`
      INSERT INTO job_events (job_id, attempt_id, type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(jobId, attemptId ?? null, type, JSON.stringify(data), createdAt);
  }

  beginRunEvent(
    jobId: string,
    attemptId: string,
    workerToken: string,
    runId: string,
    eventKey: string,
    eventSummary: string,
  ): RunEventDeliveryState {
    const consumedAt = nowIso();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertActiveRunEventClaim(jobId, attemptId, workerToken);
      const result = this.#database.prepare(`
        INSERT INTO cursor_run_event_consumptions (
          run_id, event_key, job_id, attempt_id, event_summary, status, consumed_at
        ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
        ON CONFLICT(run_id, event_key) DO NOTHING
      `).run(runId, eventKey, jobId, attemptId, eventSummary, consumedAt);
      const row = this.#database.prepare(`
        SELECT job_id, attempt_id, event_summary, status
        FROM cursor_run_event_consumptions
        WHERE run_id = ? AND event_key = ?
      `).get(runId, eventKey) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Failed to create or load Cursor run event: ${runId}/${eventKey}`);
      if (String(row.job_id) !== jobId || String(row.attempt_id) !== attemptId) {
        throw new Error(`Cursor run event identity collision: ${runId}/${eventKey}`);
      }
      const status = String(row.status);
      let deliveryState: RunEventDeliveryState;
      if (status === "LOGGED") {
        deliveryState = "LOGGED";
      } else if (status === "PENDING") {
        if (String(row.event_summary) !== eventSummary) {
          throw new Error(`Cursor run event payload collision: ${runId}/${eventKey}`);
        }
        deliveryState = result.changes === 1 ? "NEW" : "PENDING";
      } else {
        throw new Error(`Unknown Cursor run event delivery state: ${status}`);
      }
      this.#database.exec("COMMIT");
      return deliveryState;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  completeRunEvent(
    jobId: string,
    attemptId: string,
    workerToken: string,
    runId: string,
    eventKey: string,
  ): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertActiveRunEventClaim(jobId, attemptId, workerToken);
      const result = this.#database.prepare(`
        UPDATE cursor_run_event_consumptions
        SET status = 'LOGGED', logged_at = COALESCE(logged_at, ?)
        WHERE run_id = ? AND event_key = ? AND job_id = ? AND attempt_id = ?
      `).run(nowIso(), runId, eventKey, jobId, attemptId);
      if (result.changes !== 1) {
        const row = this.#database.prepare(`
          SELECT status FROM cursor_run_event_consumptions
          WHERE run_id = ? AND event_key = ? AND job_id = ? AND attempt_id = ?
        `).get(runId, eventKey, jobId, attemptId) as Record<string, unknown> | undefined;
        if (!row) throw new Error(`Unknown Cursor run event: ${runId}/${eventKey}`);
        if (String(row.status) !== "LOGGED") {
          throw new Error(`Could not complete Cursor run event: ${runId}/${eventKey}`);
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listPendingRunEvents(
    jobId: string,
    attemptId: string,
    workerToken: string,
    runId: string,
  ): PendingRunEvent[] {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertActiveRunEventClaim(jobId, attemptId, workerToken);
      const rows = this.#database.prepare(`
        SELECT run_id, event_key, event_summary
        FROM cursor_run_event_consumptions
        WHERE job_id = ? AND attempt_id = ? AND run_id = ? AND status = 'PENDING'
        ORDER BY consumed_at, event_key
      `).all(jobId, attemptId, runId) as Array<Record<string, unknown>>;
      this.#database.exec("COMMIT");
      return rows.map((row) => ({
        runId: String(row.run_id),
        eventKey: String(row.event_key),
        eventSummary: String(row.event_summary),
      }));
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #assertActiveRunEventClaim(
    jobId: string,
    attemptId: string,
    workerToken: string,
  ): void {
    const active = this.#database.prepare(`
      SELECT 1
      FROM attempts a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ?
        AND a.job_id = ?
        AND a.worker_token = ?
        AND j.current_attempt_id = a.id
        AND a.status IN ('PREPARING', 'IMPLEMENTING', 'VERIFYING', 'REPAIRING', 'PUBLISHING')
    `).get(attemptId, jobId, workerToken) as Record<string, unknown> | undefined;
    if (!active) throw new Error(`Active attempt lease was lost: ${attemptId}`);
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
