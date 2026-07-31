import os from "node:os";
import path from "node:path";
import type {
  PreparedWorktree,
  PublicationInput,
} from "../../src/application/workflow-ports.js";
import type {
  MachineConfig,
  RepositoryConfig,
  RuntimePaths,
} from "../../src/domain/configuration.js";
import type {
  Attempt,
  Effect,
} from "../../src/domain/job.js";
import type { ApprovedTask } from "../../src/domain/task.js";

export const paths: RuntimePaths = {
  projectRoot: "/bridge",
  home: "/home",
  configFile: "/home/config.json",
  databaseFile: "/home/jobs.sqlite",
  logsDir: "/home/logs",
  reportsDir: "/home/reports",
  worktreesDir: path.join(os.tmpdir(), "cursor-adapter-tests"),
  tasksDir: "/bridge/tasks",
};

export const config: MachineConfig = {
  cursorModelId: "grok-4.5",
  cursorModelParams: [
    { id: "effort", value: "high" },
    { id: "fast", value: "false" },
  ],
  repositories: {
    demo: {
      root: "/repo",
      origin: "owner/repo",
      defaultBranch: "main",
    },
  },
};

export const repository: RepositoryConfig = config.repositories.demo!;
export const fixedNow = "2026-07-23T00:00:00.000Z";

export function approvedTask(
  pullRequest: ApprovedTask["pull_request"],
): ApprovedTask {
  return {
    id: "TASK-DEMO",
    repository: "demo",
    title: "Demo change",
    spec_version: 2,
    status: "approved",
    spec_hash: `sha256:${"a".repeat(64)}`,
    policy_version: 3,
    target: {
      origin: "owner/repo",
      base_ref: pullRequest.mode === "existing_pr" ? "feature/existing" : "main",
      destination_ref: "main",
      base_sha: "b".repeat(40),
      context_digest: `sha256:${"c".repeat(64)}`,
    },
    approval: {
      approved_at: fixedNow,
      approved_by: "local-user",
    },
    goal: "demo",
    context_files: [],
    allowed_paths: ["src/**"],
    forbidden_paths: [],
    non_goals: [],
    acceptance_criteria: ["done"],
    implementation_constraints: [],
    required_new_tests: [],
    verification: {
      commands: [{
        command: "pnpm",
        args: ["test"],
        timeout_seconds: 30,
      }],
      profile_hash: `sha256:${"d".repeat(64)}`,
    },
    limits: {
      max_changed_files: 3,
      max_diff_lines: 100,
      allow_test_deletion: false,
      max_repair_attempts: 1,
    },
    stop_conditions: [],
    pull_request: pullRequest,
  };
}

export function durableEffect(kind: string, idempotencyKey: string): Effect {
  return {
    id: `effect-${kind}`,
    jobId: "job",
    attemptId: "attempt",
    kind,
    idempotencyKey,
    status: "STARTED",
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
}

export function publishingAttempt(): Attempt {
  return {
    id: "attempt",
    jobId: "job",
    ordinal: 1,
    status: "PUBLISHING",
    workerToken: "worker",
    leaseExpiresAt: "2026-07-23T01:00:00.000Z",
    heartbeatAt: fixedNow,
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
}

export function preparedWorktree(
  overrides: Partial<PreparedWorktree> = {},
): PreparedWorktree {
  return {
    worktree: "/worktree",
    baseSha: "b".repeat(40),
    pushBranch: "feature/existing",
    localBranch: "codex/cursor/task-demo-followup-job",
    ...overrides,
  };
}

export function publicationInput(
  treeHash = "e".repeat(40),
): PublicationInput {
  return {
    tree: {
      treeHash,
      patchHash: `sha256:${"a".repeat(64)}`,
    },
    initialChanges: {
      files: ["src/demo.ts"],
      deletedFiles: [],
      diffLines: 1,
    },
    finalChanges: {
      files: ["src/demo.ts"],
      deletedFiles: [],
      diffLines: 1,
    },
    assessment: {
      ok: true,
      reasons: [],
      allowed: ["src/demo.ts"],
      forbidden: [],
      outOfScope: [],
    },
    verification: [{
      command: "pnpm test",
      status: "passed",
      durationMs: 1,
    }],
    attempts: [publishingAttempt()],
    cursorSummary: "done",
  };
}

export function rawCommit(treeHash: string, parentSha: string): string {
  return `tree ${treeHash}\nparent ${parentSha}\n\nbridge commit`;
}
