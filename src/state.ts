import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const jobStatuses = [
  "QUEUED", "RUNNING", "VERIFYING", "COMMITTING", "PUSHING", "DONE",
  "BLOCKED", "FAILED", "CANCELLED", "STALE_SPEC", "SCOPE_VIOLATION",
] as const;
export type JobStatus = (typeof jobStatuses)[number];

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  QUEUED: ["RUNNING", "CANCELLED", "STALE_SPEC", "BLOCKED", "FAILED"],
  RUNNING: ["VERIFYING", "CANCELLED", "BLOCKED", "FAILED", "SCOPE_VIOLATION"],
  VERIFYING: ["COMMITTING", "CANCELLED", "BLOCKED", "FAILED", "SCOPE_VIOLATION"],
  COMMITTING: ["PUSHING", "FAILED", "CANCELLED"],
  PUSHING: ["DONE", "FAILED", "CANCELLED"],
  DONE: [], BLOCKED: [], FAILED: [], CANCELLED: [], STALE_SPEC: [], SCOPE_VIOLATION: [],
};

export interface CreateJobInput {
  repositoryAlias: string;
  taskId: string;
  specVersion: number;
  specHash: string;
}

export interface Job extends CreateJobInput {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
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

function rowToJob(row: Record<string, unknown>): Job {
  const optionalString = (key: string): string | undefined => typeof row[key] === "string" ? row[key] : undefined;
  const optionalNumber = (key: string): number | undefined => typeof row[key] === "number" ? row[key] : undefined;
  return {
    id: String(row.id), repositoryAlias: String(row.repository_alias), taskId: String(row.task_id),
    specVersion: Number(row.spec_version), specHash: String(row.spec_hash), status: String(row.status) as JobStatus,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(optionalNumber("pid") === undefined ? {} : { pid: optionalNumber("pid") }),
    ...(optionalString("cursor_agent_id") === undefined ? {} : { cursorAgentId: optionalString("cursor_agent_id") }),
    ...(optionalString("cursor_run_id") === undefined ? {} : { cursorRunId: optionalString("cursor_run_id") }),
    ...(optionalString("worktree") === undefined ? {} : { worktree: optionalString("worktree") }),
    ...(optionalString("base_sha") === undefined ? {} : { baseSha: optionalString("base_sha") }),
    ...(optionalString("report_path") === undefined ? {} : { reportPath: optionalString("report_path") }),
    ...(optionalString("log_path") === undefined ? {} : { logPath: optionalString("log_path") }),
    ...(optionalString("pr_url") === undefined ? {} : { prUrl: optionalString("pr_url") }),
    ...(optionalString("error_message") === undefined ? {} : { errorMessage: optionalString("error_message") }),
  } as Job;
}

export class JobStore {
  readonly #database: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(file);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, repository_alias TEXT NOT NULL, task_id TEXT NOT NULL,
        spec_version INTEGER NOT NULL, spec_hash TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pid INTEGER,
        cursor_agent_id TEXT, cursor_run_id TEXT, worktree TEXT, base_sha TEXT,
        report_path TEXT, log_path TEXT, pr_url TEXT, error_message TEXT,
        UNIQUE(repository_alias, task_id, spec_hash)
      );
    `);
  }

  close(): void { this.#database.close(); }

  createOrGet(input: CreateJobInput): Job {
    const existing = this.#database.prepare(
      "SELECT * FROM jobs WHERE repository_alias = ? AND task_id = ? AND spec_hash = ?",
    ).get(input.repositoryAlias, input.taskId, input.specHash) as Record<string, unknown> | undefined;
    if (existing) return rowToJob(existing);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.#database.prepare(`
      INSERT INTO jobs (id, repository_alias, task_id, spec_version, spec_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?)
    `).run(id, input.repositoryAlias, input.taskId, input.specVersion, input.specHash, now, now);
    const job = this.get(id);
    if (!job) throw new Error("Failed to create job");
    return job;
  }

  get(id: string): Job | undefined {
    const row = this.#database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : undefined;
  }

  transition(id: string, next: JobStatus, fields: Partial<Job> = {}): Job {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown job: ${id}`);
    if (!transitions[current.status].includes(next)) throw new Error(`Illegal transition: ${current.status} -> ${next}`);
    this.update(id, { ...fields, status: next });
    const updated = this.get(id);
    if (!updated) throw new Error(`Unknown job after transition: ${id}`);
    return updated;
  }

  update(id: string, fields: Partial<Job>): void {
    const columns: Record<string, unknown> = {
      status: fields.status, pid: fields.pid, cursor_agent_id: fields.cursorAgentId,
      cursor_run_id: fields.cursorRunId, worktree: fields.worktree, base_sha: fields.baseSha,
      report_path: fields.reportPath, log_path: fields.logPath, pr_url: fields.prUrl,
      error_message: fields.errorMessage,
    };
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => {
      if (typeof value === "string" || typeof value === "number" || value === null) return value;
      throw new Error("Unsupported SQLite job field value");
    });
    this.#database.prepare(`UPDATE jobs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id);
  }
}
