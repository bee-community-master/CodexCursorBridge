import type { DatabaseSync } from "node:sqlite";

export const STATE_SCHEMA_VERSION = 3;

export function migrateStateDatabase(database: DatabaseSync): void {
  const versionRow = database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  const currentVersion = Number(versionRow.user_version);
  if (currentVersion > STATE_SCHEMA_VERSION) {
    throw new Error(
      `Database uses newer schema version ${currentVersion}; this bridge supports ${STATE_SCHEMA_VERSION}`,
    );
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
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
      (database.prepare("PRAGMA table_info(jobs)").all() as Array<Record<string, unknown>>)
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
      if (!columns.has(column)) {
        database.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`);
      }
    }
    database.exec(`
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
      (database.prepare("PRAGMA table_info(attempts)").all() as Array<Record<string, unknown>>)
        .map((row) => String(row.name)),
    );
    if (!attemptColumns.has("outcome_summary")) {
      database.exec("ALTER TABLE attempts ADD COLUMN outcome_summary TEXT");
    }
    if (!attemptColumns.has("git_config_digest")) {
      database.exec("ALTER TABLE attempts ADD COLUMN git_config_digest TEXT");
    }
    database.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
