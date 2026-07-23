import type {
  AttestationData,
  CandidateTree,
  CollectedChanges,
  ImplementerOutcome,
  PreparedWorktree,
  PublicationInput,
  PublicationResult,
  PublicationStatePort,
  VerificationResult,
  WorkflowAdapter,
  WorkflowReportData,
} from "./application/workflow-ports.js";
import { CursorImplementer } from "./adapters/cursor-runner.js";
import { GitPublisher } from "./adapters/git-publisher.js";
import { GitWorktreeManager } from "./adapters/git-worktree-manager.js";
import { GitHubPullRequestAdapter } from "./adapters/github-pull-request.js";
import { IndependentVerifier } from "./adapters/independent-verifier.js";
import { PreparedWorktreeGuard } from "./adapters/prepared-worktree-guard.js";
import { WorkflowArtifactWriter } from "./adapters/workflow-artifact-writer.js";
import { FileWorkflowLogger } from "./adapters/workflow-logger.js";
import type {
  MachineConfig,
  RepositoryConfig,
  RuntimePaths,
} from "./domain/configuration.js";
import type { Attempt } from "./domain/job.js";
import type { ApprovedTask } from "./domain/task.js";

export interface RealWorkflowAdapterServices {
  worktrees: {
    prepare(
      job: { id: string },
      task: ApprovedTask,
      repository: RepositoryConfig,
    ): Promise<PreparedWorktree>;
    collectChanges(
      worktree: PreparedWorktree,
      candidate?: CandidateTree,
    ): Promise<CollectedChanges>;
    computeCandidateTree(worktree: PreparedWorktree): Promise<CandidateTree>;
    cleanup(
      worktree: PreparedWorktree,
      repository: RepositoryConfig,
    ): Promise<void>;
  };
  implementer: {
    run(
      prepared: PreparedWorktree,
      task: ApprovedTask,
      attempt: Attempt,
      repairFeedback?: string,
    ): Promise<ImplementerOutcome>;
    cancel(attempt: Attempt): Promise<void>;
  };
  verifier: {
    run(prepared: PreparedWorktree, task: ApprovedTask): Promise<VerificationResult[]>;
  };
  publisher: Pick<WorkflowAdapter, "publish">;
  artifacts: Pick<WorkflowAdapter, "writeAttestation" | "writeReport">;
}

export function createRealWorkflowAdapterServices(
  paths: RuntimePaths,
  config: MachineConfig,
  store: PublicationStatePort,
  jobId: string,
): RealWorkflowAdapterServices {
  const logger = new FileWorkflowLogger(store, jobId);
  const guard = new PreparedWorktreeGuard(store, jobId);
  const pullRequests = new GitHubPullRequestAdapter(
    store,
    jobId,
    guard,
    logger,
  );
  return {
    worktrees: new GitWorktreeManager(
      paths,
      store,
      jobId,
      guard,
      pullRequests,
      logger,
    ),
    implementer: new CursorImplementer(
      paths,
      config,
      store,
      jobId,
      guard,
      logger,
    ),
    verifier: new IndependentVerifier(paths, store, jobId, guard, logger),
    publisher: new GitPublisher(
      store,
      jobId,
      guard,
      pullRequests,
      logger,
    ),
    artifacts: new WorkflowArtifactWriter(paths),
  };
}

export class RealWorkflowAdapter implements WorkflowAdapter {
  readonly #services: RealWorkflowAdapterServices;

  constructor(
    paths: RuntimePaths,
    config: MachineConfig,
    store: PublicationStatePort,
    jobId: string,
    services = createRealWorkflowAdapterServices(paths, config, store, jobId),
  ) {
    this.#services = services;
  }

  prepare(
    job: { id: string },
    task: ApprovedTask,
    repository: RepositoryConfig,
  ): Promise<PreparedWorktree> {
    return this.#services.worktrees.prepare(job, task, repository);
  }

  runImplementer(
    worktree: PreparedWorktree,
    task: ApprovedTask,
    attempt: Attempt,
    repairFeedback?: string,
  ): Promise<ImplementerOutcome> {
    return this.#services.implementer.run(
      worktree,
      task,
      attempt,
      repairFeedback,
    );
  }

  collectChanges(
    worktree: PreparedWorktree,
    candidate?: CandidateTree,
  ): Promise<CollectedChanges> {
    return this.#services.worktrees.collectChanges(worktree, candidate);
  }

  runVerification(
    worktree: PreparedWorktree,
    task: ApprovedTask,
  ): Promise<VerificationResult[]> {
    return this.#services.verifier.run(worktree, task);
  }

  computeCandidateTree(worktree: PreparedWorktree): Promise<CandidateTree> {
    return this.#services.worktrees.computeCandidateTree(worktree);
  }

  publish(
    worktree: PreparedWorktree,
    task: ApprovedTask,
    repository: RepositoryConfig,
    input: PublicationInput,
    attempt: Attempt,
  ): Promise<PublicationResult> {
    return this.#services.publisher.publish(
      worktree,
      task,
      repository,
      input,
      attempt,
    );
  }

  writeAttestation(data: AttestationData): Promise<string> {
    return this.#services.artifacts.writeAttestation(data);
  }

  writeReport(data: WorkflowReportData): Promise<string> {
    return this.#services.artifacts.writeReport(data);
  }

  cleanup(
    worktree: PreparedWorktree,
    repository: RepositoryConfig,
  ): Promise<void> {
    return this.#services.worktrees.cleanup(worktree, repository);
  }

  cancel(attempt: Attempt): Promise<void> {
    return this.#services.implementer.cancel(attempt);
  }
}
