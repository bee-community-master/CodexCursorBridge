import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Attempt,
  CreateJobInput,
  Job,
} from "../domain/job.js";
import {
  rowToAttempt,
  rowToJob,
} from "./sqlite-state-mappers.js";
import type { SqliteStateLedger } from "./sqlite-state-ledger.js";

function nowIso(): string {
  return new Date().toISOString();
}

export class SqliteJobRecords {
  readonly #database: DatabaseSync;
  readonly #ledger: SqliteStateLedger;

  constructor(database: DatabaseSync, ledger: SqliteStateLedger) {
    this.#database = database;
    this.#ledger = ledger;
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
    const row = this.#database.prepare(
      "SELECT * FROM jobs WHERE repository_alias = ? AND task_id = ? AND spec_hash = ?",
    ).get(
      input.repositoryAlias,
      input.taskId,
      input.specHash,
    ) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Failed to create or load job");
    const parsed = rowToJob(row);
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
    if (parsed.id === id) {
      this.#ledger.recordEvent(
        parsed.id,
        undefined,
        "JOB_CREATED",
        { status: parsed.status },
        now,
      );
    }
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
      if (typeof value === "string" || typeof value === "number" || value === null) {
        return value;
      }
      throw new Error("Unsupported SQLite job field value");
    });
    const result = this.#database.prepare(
      `UPDATE jobs SET ${assignments}, updated_at = ? WHERE id = ?`,
    ).run(...values, nowIso(), id);
    if (result.changes !== 1) throw new Error(`Unknown job: ${id}`);
  }
}
