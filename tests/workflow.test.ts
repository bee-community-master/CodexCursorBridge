import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryConfig } from "../src/config.js";
import { JobStore, type ClaimedWork } from "../src/state.js";
import type { Task } from "../src/task.js";
import { executeWorkflow, type WorkflowAdapter } from "../src/workflow.js";

const stores: JobStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

const task = {
  id: "TASK-DEMO", repository: "demo", title: "Demo", spec_version: 1, status: "approved",
  spec_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  policy_version: 2,
  target: {
    origin: "owner/repo",
    base_ref: "main",
    base_sha: "b".repeat(40),
    context_digest: `sha256:${"c".repeat(64)}`,
  },
  approval: { approved_at: "2026-07-23T00:00:00.000Z", approved_by: "local-user" },
  goal: "demo", context_files: [], allowed_paths: ["src/**"], forbidden_paths: ["infra/**"],
  non_goals: [], acceptance_criteria: ["done"], implementation_constraints: [],
  verification: {
    commands: [{ command: "pnpm", args: ["test"], timeout_seconds: 30 }],
    profile_hash: `sha256:${"d".repeat(64)}`,
  },
  required_new_tests: [],
  limits: {
    max_changed_files: 3,
    max_diff_lines: 50,
    allow_test_deletion: false,
    max_repair_attempts: 1,
  },
  stop_conditions: [], pull_request: { mode: "new_draft" },
} satisfies Task;

const repository: RepositoryConfig = { root: "/repo", origin: "owner/repo", defaultBranch: "main" };

async function fixture(): Promise<{ store: JobStore; claim: ClaimedWork }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cursor-workflow-"));
  const store = new JobStore(path.join(dir, "jobs.sqlite"));
  stores.push(store);
  store.createOrGet({
    repositoryAlias: "demo", taskId: task.id, specVersion: 1, specHash: task.spec_hash,
    taskCommitSha: "e".repeat(40), taskBlobSha: "f".repeat(40),
    targetOrigin: task.target.origin, targetBaseSha: task.target.base_sha,
    policyVersion: task.policy_version, maxAttempts: task.limits.max_repair_attempts + 1,
  });
  return { store, claim: store.claimNext("worker", 60_000)! };
}

function adapter(
  changedFileSnapshots: string[][],
  verificationSnapshots: Array<"passed" | "failed"> = ["passed"],
): WorkflowAdapter {
  let changeIndex = 0;
  let verificationIndex = 0;
  const runImplementer: WorkflowAdapter["runImplementer"] = async (
    _prepared,
    _task,
    attempt,
  ) => ({
    status: "completed",
    agentId: "agent",
    runId: `run-${attempt.ordinal}`,
    requestId: `request-${attempt.ordinal}`,
    summary: "implemented",
  });
  const publish: WorkflowAdapter["publish"] = async (
    _prepared,
    _task,
    _repository,
    input,
  ) => ({
    prUrl: "https://github.com/owner/repo/pull/1",
    headSha: "3".repeat(40),
    remoteHeadSha: "3".repeat(40),
    treeHash: input.tree.treeHash,
    isDraft: true,
  });
  return {
    prepare: vi.fn(async () => ({
      worktree: "/worktree",
      baseSha: task.target.base_sha,
      pushBranch: "codex/cursor/task-demo",
      localBranch: "codex/cursor/task-demo",
    })),
    runImplementer: vi.fn(runImplementer),
    collectChanges: vi.fn(async () => {
      const files = changedFileSnapshots[Math.min(changeIndex, changedFileSnapshots.length - 1)] ?? [];
      changeIndex += 1;
      return { files, deletedFiles: [], diffLines: 10 };
    }),
    runVerification: vi.fn(async () => {
      const status = verificationSnapshots[Math.min(
        verificationIndex,
        verificationSnapshots.length - 1,
      )] ?? "passed";
      verificationIndex += 1;
      return [{
        command: "pnpm test",
        status,
        durationMs: 1,
        ...(status === "failed" ? { output: "failing assertion" } : {}),
      }];
    }),
    computeCandidateTree: vi.fn(async () => ({
      treeHash: "1".repeat(40),
      patchHash: `sha256:${"2".repeat(64)}`,
    })),
    publish: vi.fn(publish),
    writeAttestation: vi.fn(async () => "/attestation.json"),
    writeReport: vi.fn(async () => "/report.md"),
    cleanup: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
}

describe("workflow orchestration", () => {
  it("publishes only the final tree after post-verification scope re-evaluation", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"], ["src/demo.ts", "src/generated.ts"]]);
    await executeWorkflow(store, claim, task, repository, fake);
    expect(store.get(claim.job.id)?.status).toBe("DELIVERED_REVIEW_REQUIRED");
    expect(fake.collectChanges).toHaveBeenCalledTimes(2);
    expect(fake.publish).toHaveBeenCalledOnce();
    const publicationInput = vi.mocked(fake.publish).mock.calls[0]?.[3];
    expect(publicationInput?.tree).toEqual({
      treeHash: "1".repeat(40),
      patchHash: `sha256:${"2".repeat(64)}`,
    });
    expect(publicationInput?.finalChanges.files).toEqual([
      "src/demo.ts",
      "src/generated.ts",
    ]);
    expect(fake.writeAttestation).toHaveBeenCalledOnce();
    expect(fake.cleanup).toHaveBeenCalledOnce();
  });

  it("stops when verification creates an out-of-scope file", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"], ["src/demo.ts", "infra/generated.tf"]]);
    await executeWorkflow(store, claim, task, repository, fake);
    expect(store.get(claim.job.id)?.status).toBe("SCOPE_VIOLATION");
    expect(fake.publish).not.toHaveBeenCalled();
    expect(fake.cleanup).not.toHaveBeenCalled();
  });

  it("runs one bounded repair attempt with exact verifier evidence", async () => {
    const { store, claim } = await fixture();
    const fake = adapter(
      [["src/demo.ts"], ["src/demo.ts"], ["src/demo.ts"], ["src/demo.ts"]],
      ["failed", "passed"],
    );
    await executeWorkflow(store, claim, task, repository, fake);
    expect(store.get(claim.job.id)?.status).toBe("DELIVERED_REVIEW_REQUIRED");
    expect(fake.runImplementer).toHaveBeenCalledTimes(2);
    expect(fake.runImplementer).toHaveBeenLastCalledWith(
      expect.anything(),
      task,
      expect.objectContaining({ ordinal: 2 }),
      expect.stringContaining("failing assertion"),
    );
    expect(store.listAttempts(claim.job.id)).toHaveLength(2);
  });

  it("maps a structured implementer stop to BLOCKED without publishing", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"]]);
    vi.mocked(fake.runImplementer).mockResolvedValueOnce({
      status: "blocked",
      agentId: "agent",
      runId: "run",
      summary: "Needs a production credential",
      reason: "A stop condition requires production access",
    });
    await executeWorkflow(store, claim, task, repository, fake);
    expect(store.get(claim.job.id)?.status).toBe("BLOCKED");
    expect(fake.publish).not.toHaveBeenCalled();
  });

  it("reclaims a verification phase without rerunning the implementer", async () => {
    const { store, claim } = await fixture();
    const implementing = store.transitionAttempt(
      claim.attempt.id,
      claim.attempt.workerToken,
      ["PREPARING"],
      "IMPLEMENTING",
      { worktree: "/worktree", baseSha: task.target.base_sha },
    );
    store.transitionAttempt(
      implementing.id,
      implementing.workerToken,
      ["IMPLEMENTING"],
      "VERIFYING",
    );
    const reclaimed = store.claimNext(
      "replacement-worker",
      60_000,
      new Date(Date.now() + 120_000),
    );
    expect(reclaimed?.resumed).toBe(true);
    const fake = adapter([["src/demo.ts"], ["src/demo.ts"]]);
    await executeWorkflow(store, reclaimed!, task, repository, fake);
    expect(store.get(claim.job.id)?.status).toBe("DELIVERED_REVIEW_REQUIRED");
    expect(fake.runImplementer).not.toHaveBeenCalled();
    expect(fake.runVerification).toHaveBeenCalledOnce();
  });

  it("confirms a persisted cancellation before starting implementation", async () => {
    const { store, claim } = await fixture();
    store.requestCancellation(claim.job.id);
    const fake = adapter([["src/demo.ts"]]);
    await executeWorkflow(store, claim, task, repository, fake);
    expect(store.get(claim.job.id)?.status).toBe("CANCELLED");
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.prepare).not.toHaveBeenCalled();
    expect(fake.runImplementer).not.toHaveBeenCalled();
  });
});
