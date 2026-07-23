import type {
  Attempt,
  AttemptStatus,
  Effect,
  Job,
  JobStatus,
} from "../domain/job.js";

export function optionalString(
  row: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof row[key] === "string" ? String(row[key]) : undefined;
}

function optionalNumber(
  row: Record<string, unknown>,
  key: string,
): number | undefined {
  return typeof row[key] === "number" ? Number(row[key]) : undefined;
}

export function rowToJob(row: Record<string, unknown>): Job {
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
    targetBaseSha: optionalString(row, "target_base_sha")
      ?? optionalString(row, "base_sha")
      ?? "",
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

export function rowToAttempt(row: Record<string, unknown>): Attempt {
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

export function rowToEffect(row: Record<string, unknown>): Effect {
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
