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

export const terminalJobStatuses: ReadonlySet<JobStatus> = new Set([
  "DELIVERED_REVIEW_REQUIRED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "STALE_SPEC",
  "SCOPE_VIOLATION",
  "DONE",
]);

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

export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return from === to || allowedAttemptTransitions[from].has(to);
}

export function jobStatusForAttempt(status: AttemptStatus): JobStatus | undefined {
  if (["PREPARING", "IMPLEMENTING", "VERIFYING", "REPAIRING", "PUBLISHING"].includes(status)) {
    return status as JobStatus;
  }
  if (status === "BLOCKED") return "BLOCKED";
  if (status === "FAILED") return "FAILED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "SCOPE_VIOLATION") return "SCOPE_VIOLATION";
  return undefined;
}

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
