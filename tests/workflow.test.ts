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
  policy_version: 3,
  target: {
    origin: "owner/repo",
    base_ref: "main",
    destination_ref: "main",
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
  it("preserves stale-spec classification from preparation failures", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"]]);
    vi.mocked(fake.prepare).mockRejectedValue(
      new Error("STALE_SPEC: existing PR head changed after task approval"),
    );

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("STALE_SPEC");
    expect(store.get(claim.job.id)?.errorMessage).toMatch(/existing PR head changed/i);
    expect(store.getAttempt(claim.attempt.id)?.status).toBe("FAILED");
    expect(store.getAttempt(claim.attempt.id)?.errorMessage)
      .toMatch(/existing PR head changed/i);
    expect(fake.publish).not.toHaveBeenCalled();
  });

  it("rejects a prepared worktree whose durable Git configuration identity changed", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"]]);
    vi.mocked(fake.prepare).mockResolvedValueOnce({
      worktree: "/worktree",
      baseSha: task.target.base_sha,
      pushBranch: "codex/cursor/task-demo",
      localBranch: "codex/cursor/task-demo",
      gitIdentity: {
        gitFileContent: "gitdir: /repo/.git/worktrees/job\n",
        gitDir: "/repo/.git/worktrees/job",
        commonGitDir: "/repo/.git",
        configDigest: `sha256:${"2".repeat(64)}`,
      },
    });
    const resumedClaim = {
      ...claim,
      attempt: {
        ...claim.attempt,
        gitConfigDigest: `sha256:${"1".repeat(64)}`,
      },
    } as ClaimedWork;

    await executeWorkflow(store, resumedClaim, task, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("STALE_SPEC");
    expect(store.get(claim.job.id)?.errorMessage)
      .toMatch(/Git configuration identity changed/i);
    expect(fake.runImplementer).not.toHaveBeenCalled();
  });

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
    expect(vi.mocked(fake.writeAttestation).mock.calls[0]?.[0].attempts.at(-1)?.status)
      .toBe("COMPLETED");
    expect(vi.mocked(fake.writeReport).mock.calls[0]?.[0].attempts?.at(-1)?.status)
      .toBe("COMPLETED");
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

  it("repairs a candidate that omits the Task's required test change", async () => {
    const { store, claim } = await fixture();
    const taskRequiringTests = {
      ...task,
      allowed_paths: ["src/**", "tests/**"],
      required_new_tests: ["Add a regression test for the changed behavior."],
    };
    const fake = adapter(
      [
        ["src/demo.ts"],
        ["src/demo.ts"],
        ["src/demo.ts", "tests/demo.test.ts"],
        ["src/demo.ts", "tests/demo.test.ts"],
      ],
      ["failed", "passed"],
    );

    await executeWorkflow(
      store,
      claim,
      taskRequiringTests,
      repository,
      fake,
    );

    expect(store.get(claim.job.id)?.status).toBe("DELIVERED_REVIEW_REQUIRED");
    expect(fake.runImplementer).toHaveBeenCalledTimes(2);
    expect(fake.runImplementer).toHaveBeenLastCalledWith(
      expect.anything(),
      taskRequiringTests,
      expect.objectContaining({ ordinal: 2 }),
      expect.stringMatching(/(?=[\s\S]*failing assertion)(?=[\s\S]*required test)/i),
    );
    expect(fake.publish).toHaveBeenCalledOnce();
  });

  it("does not publish a candidate tree that changed during independent verification", async () => {
    const { store, claim } = await fixture();
    const fake = adapter(
      [["src/demo.ts"], ["src/demo.ts"], ["src/demo.ts"], ["src/demo.ts"]],
      ["passed", "passed"],
    );
    const beforeVerification = {
      treeHash: "1".repeat(40),
      patchHash: `sha256:${"2".repeat(64)}`,
    };
    const changedDuringVerification = {
      treeHash: "3".repeat(40),
      patchHash: `sha256:${"4".repeat(64)}`,
    };
    vi.mocked(fake.computeCandidateTree)
      .mockResolvedValueOnce(beforeVerification)
      .mockResolvedValue(changedDuringVerification);

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("DELIVERED_REVIEW_REQUIRED");
    expect(fake.runImplementer).toHaveBeenCalledTimes(2);
    expect(fake.runImplementer).toHaveBeenLastCalledWith(
      expect.anything(),
      task,
      expect.objectContaining({ ordinal: 2 }),
      expect.stringMatching(/candidate tree changed/i),
    );
    expect(vi.mocked(fake.publish).mock.calls[0]?.[3].tree)
      .toEqual(changedDuringVerification);
  });

  it("does not publish an empty implementation", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([[], [], [], []], ["passed", "passed"]);

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("FAILED");
    expect(store.get(claim.job.id)?.errorMessage)
      .toMatch(/candidate-change-presence/i);
    expect(fake.runImplementer).toHaveBeenCalledTimes(2);
    expect(fake.runImplementer).toHaveBeenLastCalledWith(
      expect.anything(),
      task,
      expect.objectContaining({ ordinal: 2 }),
      expect.stringMatching(/no changed files/i),
    );
    expect(fake.publish).not.toHaveBeenCalled();
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
    expect(store.get(claim.job.id)?.errorMessage)
      .toBe("A stop condition requires production access");
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
      {
        outcome: "completed",
        outcomeSummary: "persisted implementation summary",
      },
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
    expect(fake.writeReport).toHaveBeenCalledWith(
      expect.objectContaining({ cursorSummary: "persisted implementation summary" }),
    );
  });

  it("restores exact verifier evidence when a repair attempt is reclaimed", async () => {
    const { store, claim } = await fixture();
    const implementing = store.transitionAttempt(
      claim.attempt.id,
      claim.attempt.workerToken,
      ["PREPARING"],
      "IMPLEMENTING",
      { worktree: "/worktree", baseSha: task.target.base_sha },
    );
    const verifying = store.transitionAttempt(
      implementing.id,
      implementing.workerToken,
      ["IMPLEMENTING"],
      "VERIFYING",
      {
        outcome: "completed",
        outcomeSummary: "first implementation",
      },
    );
    const repairEvidence = [
      "Independent verification failed.",
      "Command: pnpm test",
      "Output: exact failing assertion",
    ].join("\n");
    const repair = store.beginRepairAttempt(
      claim.job.id,
      verifying.id,
      verifying.workerToken,
      1_000,
      repairEvidence,
      new Date("2026-07-23T00:00:00.000Z"),
    );
    expect(repair.errorMessage).toBe(repairEvidence);
    const reclaimed = store.claimNext(
      "replacement-worker",
      60_000,
      new Date("2026-07-23T00:00:02.000Z"),
    )!;
    const fake = adapter([["src/demo.ts"], ["src/demo.ts"]]);

    await executeWorkflow(store, reclaimed, task, repository, fake);

    expect(fake.runImplementer).toHaveBeenCalledWith(
      expect.anything(),
      task,
      expect.objectContaining({ ordinal: 2 }),
      repairEvidence,
    );
    expect(store.get(claim.job.id)?.status).toBe("DELIVERED_REVIEW_REQUIRED");
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

  it("preserves a prepared worktree when cancellation races with preparation", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"]]);
    vi.mocked(fake.prepare).mockImplementationOnce(async () => {
      store.requestCancellation(claim.job.id);
      return {
        worktree: "/worktree",
        baseSha: task.target.base_sha,
        pushBranch: "codex/cursor/task-demo",
        localBranch: "codex/cursor/task-demo",
      };
    });

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("CANCELLED");
    expect(store.getAttempt(claim.attempt.id)).toMatchObject({
      status: "CANCELLED",
      worktree: "/worktree",
      baseSha: task.target.base_sha,
    });
    expect(fake.runImplementer).not.toHaveBeenCalled();
  });

  it("keeps cancellation pending when the implementer cannot confirm it stopped", async () => {
    const { store, claim } = await fixture();
    store.requestCancellation(claim.job.id);
    const fake = adapter([["src/demo.ts"]]);
    vi.mocked(fake.cancel).mockRejectedValue(
      new Error("Cursor run is still active; api_key=super-secret-value"),
    );

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("CANCEL_REQUESTED");
    expect(store.getAttempt(claim.attempt.id)?.status).toBe("PREPARING");
    const failure = store.listEvents(claim.job.id)
      .find((event) => event.type === "CANCELLATION_CONFIRMATION_FAILED");
    expect(failure?.data.error).toContain("[REDACTED]");
    expect(failure?.data.error).not.toContain("super-secret-value");
  });

  it("confirms cancellation raised while verification is running instead of starting repair", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"]], ["failed"]);
    vi.mocked(fake.runVerification).mockImplementationOnce(async () => {
      store.requestCancellation(claim.job.id);
      return [{
        command: "pnpm test",
        status: "failed",
        durationMs: 1,
        output: "The verifier was aborted.",
      }];
    });

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("CANCELLED");
    expect(store.listAttempts(claim.job.id)).toHaveLength(1);
    expect(fake.runImplementer).toHaveBeenCalledOnce();
    expect(fake.publish).not.toHaveBeenCalled();
    expect(fake.cancel).toHaveBeenCalledOnce();
  });

  it("finishes delivery when cancellation arrives after publication started", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"], ["src/demo.ts"]]);
    vi.mocked(fake.publish).mockImplementationOnce(async (
      _prepared,
      _task,
      _repository,
      input,
    ) => {
      expect(store.requestCancellation(claim.job.id).status).toBe("PUBLISHING");
      return {
        prUrl: "https://github.com/owner/repo/pull/1",
        headSha: "3".repeat(40),
        remoteHeadSha: "3".repeat(40),
        treeHash: input.tree.treeHash,
        isDraft: true,
      };
    });

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("DELIVERED_REVIEW_REQUIRED");
    expect(fake.cancel).not.toHaveBeenCalled();
  });

  it("redacts cleanup failures persisted after successful delivery", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"], ["src/demo.ts"]]);
    vi.mocked(fake.cleanup).mockRejectedValue(
      new Error("cleanup failed with token: super-secret-value"),
    );

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)).toMatchObject({
      status: "DELIVERED_REVIEW_REQUIRED",
      cleanupStatus: "FAILED",
    });
    expect(store.get(claim.job.id)?.cleanupError).toContain("[REDACTED]");
    expect(store.get(claim.job.id)?.cleanupError).not.toContain("super-secret-value");
    const failure = store.listEvents(claim.job.id)
      .find((event) => event.type === "CLEANUP_FAILED");
    expect(failure?.data.error).not.toContain("super-secret-value");
  });

  it("keeps a recorded publication recoverable when local delivery artifacts fail", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"], ["src/demo.ts"]]);
    vi.mocked(fake.writeAttestation).mockRejectedValueOnce(
      new Error("temporary attestation storage failure"),
    );

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)).toMatchObject({
      status: "PUBLISHING",
      prUrl: "https://github.com/owner/repo/pull/1",
      headSha: "3".repeat(40),
      treeHash: "1".repeat(40),
    });
    expect(store.getAttempt(claim.attempt.id)?.status).toBe("PUBLISHING");
    expect(store.listEvents(claim.job.id))
      .toContainEqual(expect.objectContaining({
        type: "DELIVERY_FINALIZATION_DEFERRED",
      }));
    expect(fake.writeReport).not.toHaveBeenCalled();
  });

  it("does not deliver an existing pull request that is no longer a draft", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"], ["src/demo.ts"]]);
    vi.mocked(fake.publish).mockImplementationOnce(async (
      _prepared,
      _task,
      _repository,
      input,
    ) => ({
      prUrl: "https://github.com/owner/repo/pull/7",
      headSha: "3".repeat(40),
      remoteHeadSha: "3".repeat(40),
      treeHash: input.tree.treeHash,
      isDraft: false,
    }));
    const existingTask = {
      ...task,
      pull_request: { mode: "existing_pr" as const, number: 7 },
    };

    await executeWorkflow(store, claim, existingTask, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("FAILED");
    expect(store.get(claim.job.id)?.errorMessage).toMatch(/draft/i);
    expect(fake.writeAttestation).not.toHaveBeenCalled();
  });

  it("does not let a stale worker fail an attempt after its lease was reclaimed", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"], ["src/demo.ts"]]);
    vi.mocked(fake.publish).mockImplementationOnce(async () => {
      const reclaimed = store.claimNext(
        "replacement-worker",
        60_000,
        new Date(Date.now() + 120_000),
      );
      expect(reclaimed?.attempt.workerToken).toBe("replacement-worker");
      throw new Error("Original publisher lost its lease");
    });

    await executeWorkflow(store, claim, task, repository, fake);

    expect(store.get(claim.job.id)?.status).toBe("PUBLISHING");
    expect(store.getAttempt(claim.attempt.id)).toMatchObject({
      status: "PUBLISHING",
      workerToken: "replacement-worker",
    });
  });

  it("does not prepare a worktree for a claim whose lease was already reclaimed", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"], ["src/demo.ts"]]);
    const replacement = store.claimNext(
      "replacement-worker",
      60_000,
      new Date(Date.now() + 120_000),
    );

    await executeWorkflow(store, claim, task, repository, fake);

    expect(replacement?.attempt.workerToken).toBe("replacement-worker");
    expect(fake.prepare).not.toHaveBeenCalled();
    expect(store.get(claim.job.id)?.status).toBe("PREPARING");
  });

  it("does not write a stale failure report when the lease changes during failure CAS", async () => {
    const { store, claim } = await fixture();
    const fake = adapter([["src/demo.ts"], ["src/demo.ts"]]);
    vi.mocked(fake.publish).mockRejectedValueOnce(new Error("publication failed"));
    const originalTransition = store.transitionAttempt.bind(store);
    let replacementToken: string | undefined;
    vi.spyOn(store, "transitionAttempt").mockImplementation((...args) => {
      if (args[3] === "FAILED") {
        replacementToken = store.claimNext(
          "replacement-worker",
          60_000,
          new Date(Date.now() + 120_000),
        )?.attempt.workerToken;
      }
      return originalTransition(...args);
    });

    await executeWorkflow(store, claim, task, repository, fake);

    expect(replacementToken).toBe("replacement-worker");
    expect(store.get(claim.job.id)?.status).toBe("PUBLISHING");
    expect(store.get(claim.job.id)?.reportPath).toBeUndefined();
    expect(store.getAttempt(claim.attempt.id)).toMatchObject({
      status: "PUBLISHING",
      workerToken: "replacement-worker",
    });
    expect(fake.writeReport).not.toHaveBeenCalled();
  });
});
