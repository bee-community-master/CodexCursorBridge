import type { RepositoryConfig } from "../domain/configuration.js";
import type {
  Attempt,
  AttemptStatus,
  DeliveryCompletion,
  Effect,
  Job,
  JobStatus,
  PublicationRecord,
} from "../domain/job.js";
import type { ApprovedTask } from "../domain/task.js";
import type { ChangeAssessment } from "./change-assessment.js";

export interface WorktreeIdentity {
  gitFileContent: string;
  gitDir: string;
  commonGitDir: string;
  configDigest: string;
}

export interface CollectedChanges {
  files: string[];
  deletedFiles: string[];
  diffLines: number;
}

export interface CandidateTree {
  treeHash: string;
  patchHash: string;
}

export interface PreparedWorktree {
  worktree: string;
  baseSha: string;
  pushBranch: string;
  localBranch: string;
  gitIdentity?: WorktreeIdentity;
}

export interface PackageManagerAttestation {
  name: string;
  binary: "pnpm" | "pnpx";
  version: string;
  digest: string;
  integrity?: string;
  artifactDigest: string;
  runtime: "node";
  entrypoint: string;
  source: "verifier-owned-corepack-cache";
  network: "denied";
}

export interface ImplementerOutcome {
  status: "completed" | "blocked" | "needs_input";
  agentId: string;
  runId: string;
  requestId?: string;
  summary: string;
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface VerificationResult {
  command: string;
  status: "passed" | "failed";
  durationMs: number;
  output?: string;
  packageManager?: PackageManagerAttestation;
}

export interface PublicationInput {
  tree: CandidateTree;
  initialChanges: CollectedChanges;
  finalChanges: CollectedChanges;
  assessment: ChangeAssessment;
  verification: VerificationResult[];
  attempts: Attempt[];
  cursorSummary: string;
}

export interface PublicationResult {
  prUrl: string;
  headSha: string;
  remoteHeadSha: string;
  treeHash: string;
  isDraft: boolean;
}

export interface AttestationData extends PublicationInput {
  job: Job;
  task: ApprovedTask;
  publication: PublicationResult;
}

export interface WorkflowReportData {
  job: Job;
  task: ApprovedTask;
  changes?: CollectedChanges;
  initialChanges?: CollectedChanges;
  assessment?: ChangeAssessment;
  verification?: VerificationResult[];
  attempts?: Attempt[];
  cursorSummary?: string;
  publication?: PublicationResult;
  error?: string;
}

export interface WorkflowAdapter {
  prepare(job: Job, task: ApprovedTask, repository: RepositoryConfig): Promise<PreparedWorktree>;
  runImplementer(
    worktree: PreparedWorktree,
    task: ApprovedTask,
    attempt: Attempt,
    repairFeedback?: string,
  ): Promise<ImplementerOutcome>;
  collectChanges(
    worktree: PreparedWorktree,
    candidate?: CandidateTree,
  ): Promise<CollectedChanges>;
  runVerification(worktree: PreparedWorktree, task: ApprovedTask): Promise<VerificationResult[]>;
  computeCandidateTree(worktree: PreparedWorktree): Promise<CandidateTree>;
  publish(
    worktree: PreparedWorktree,
    task: ApprovedTask,
    repository: RepositoryConfig,
    input: PublicationInput,
    attempt: Attempt,
  ): Promise<PublicationResult>;
  writeAttestation(data: AttestationData): Promise<string>;
  writeReport(data: WorkflowReportData): Promise<string>;
  cleanup(worktree: PreparedWorktree, repository: RepositoryConfig): Promise<void>;
  cancel(attempt: Attempt): Promise<void>;
}

interface JobStateReader {
  get(id: string): Job | undefined;
  getAttempt(id: string): Attempt | undefined;
}

export interface WorkflowStatePort extends JobStateReader {
  listAttempts(jobId: string): Attempt[];
  assertActiveAttempt(
    jobId: string,
    attemptId: string,
    workerToken: string,
    expectedStatus: AttemptStatus,
  ): Attempt;
  updateAttempt(attemptId: string, workerToken: string, fields: Partial<Attempt>): Attempt;
  transitionAttempt(
    attemptId: string,
    workerToken: string,
    expected: readonly AttemptStatus[],
    next: AttemptStatus,
    fields?: Partial<Attempt>,
  ): Attempt;
  beginRepairAttempt(
    jobId: string,
    previousAttemptId: string,
    workerToken: string,
    leaseMs: number,
    repairEvidence: string,
    now?: Date,
  ): Attempt;
  isCancellationRequested(jobId: string): boolean;
  confirmCancellation(jobId: string, attemptId: string, workerToken: string): Job;
  failStaleSpec(
    jobId: string,
    attemptId: string,
    workerToken: string,
    errorMessage: string,
  ): Job;
  recordPublication(
    jobId: string,
    attemptId: string,
    workerToken: string,
    publication: PublicationRecord,
  ): Job;
  completeDelivery(
    jobId: string,
    attemptId: string,
    workerToken: string,
    completion: DeliveryCompletion,
  ): Job;
  transitionJob(
    jobId: string,
    expected: readonly JobStatus[],
    next: JobStatus,
    fields?: Partial<Job>,
  ): Job;
  update(id: string, fields: Partial<Job>): void;
  recordEvent(
    jobId: string,
    attemptId: string | undefined,
    type: string,
    data: Record<string, unknown>,
  ): void;
}

export interface PublicationStatePort extends JobStateReader {
  getEffect(idempotencyKey: string): Effect | undefined;
  assertActiveAttempt(
    jobId: string,
    attemptId: string,
    workerToken: string,
    expectedStatus: AttemptStatus,
  ): Attempt;
  beginEffect(jobId: string, attemptId: string, kind: string, idempotencyKey: string): Effect;
  completeEffect(effectId: string, payload: Record<string, unknown>): Effect;
  isCancellationRequested(jobId: string): boolean;
  update(id: string, fields: Partial<Job>): void;
  updateAttempt(attemptId: string, workerToken: string, fields: Partial<Attempt>): Attempt;
}

export type WorkerStatePort = WorkflowStatePort & PublicationStatePort;
