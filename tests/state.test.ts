import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { JobStore, STATE_SCHEMA_VERSION } from "../src/state.js";

const stores: JobStore[] = [];

afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe("job state", () => {
  it("deduplicates the same approved task and hash", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const store = new JobStore(path.join(dir, "jobs.sqlite"));
    stores.push(store);
    const input = {
      repositoryAlias: "demo",
      taskId: "TASK-1",
      specVersion: 1,
      specHash: "sha256:a",
      taskCommitSha: "a".repeat(40),
      taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo",
      targetBaseSha: "c".repeat(40),
      policyVersion: 2,
      maxAttempts: 2,
    };
    const first = store.createOrGet(input);
    const second = store.createOrGet(input);
    expect(second.id).toBe(first.id);
    expect(() => store.createOrGet({
      ...input,
      taskBlobSha: "d".repeat(40),
    })).toThrow(/immutable/);
  });

  it("claims work with a lease and atomically compares state transitions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const store = new JobStore(path.join(dir, "jobs.sqlite"));
    stores.push(store);
    const job = store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-1", specVersion: 1, specHash: "sha256:a",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 2,
    });
    const claimed = store.claimNext("worker-1", 60_000, new Date("2026-07-23T00:00:00.000Z"));
    expect(claimed?.job.id).toBe(job.id);
    expect(claimed?.attempt.ordinal).toBe(1);
    expect(store.claimNext("worker-2", 60_000, new Date("2026-07-23T00:00:01.000Z"))).toBeUndefined();

    const implementing = store.transitionAttempt(
      claimed!.attempt.id,
      "worker-1",
      ["PREPARING"],
      "IMPLEMENTING",
    );
    const withOutcome = store.updateAttempt(implementing.id, "worker-1", {
      outcome: "completed",
      outcomeSummary: "implementation complete",
    });
    expect(withOutcome.outcomeSummary).toBe("implementation complete");
    expect(() => store.transitionAttempt(
      claimed!.attempt.id,
      "worker-1",
      ["PREPARING"],
      "VERIFYING",
    )).toThrow(/changed concurrently/);
    expect(() => store.transitionAttempt(
      implementing.id,
      "worker-1",
      ["IMPLEMENTING"],
      "PUBLISHING",
    )).toThrow(/illegal/i);
    expect(store.get(job.id)?.status).toBe("IMPLEMENTING");
    expect(store.get("missing")).toBeUndefined();
  });

  it("reclaims an expired lease without creating a duplicate attempt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const databaseFile = path.join(dir, "jobs.sqlite");
    const first = new JobStore(databaseFile);
    const second = new JobStore(databaseFile);
    stores.push(first, second);
    first.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-1", specVersion: 1, specHash: "sha256:a",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 2,
    });

    const original = first.claimNext("worker-1", 1_000, new Date("2026-07-23T00:00:00.000Z"));
    const reclaimed = second.claimNext("worker-2", 60_000, new Date("2026-07-23T00:00:02.000Z"));
    expect(reclaimed?.attempt.id).toBe(original?.attempt.id);
    expect(reclaimed?.attempt.workerToken).toBe("worker-2");
    expect(second.listAttempts(original!.job.id)).toHaveLength(1);
  });

  it("uses a confirmed cancellation state and prevents later state overwrite", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const store = new JobStore(path.join(dir, "jobs.sqlite"));
    stores.push(store);
    const job = store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-1", specVersion: 1, specHash: "sha256:a",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 2,
    });
    const claimed = store.claimNext("worker-1", 60_000)!;
    const requested = store.requestCancellation(job.id);
    expect(requested.status).toBe("CANCEL_REQUESTED");
    expect(store.isCancellationRequested(job.id)).toBe(true);
    expect(() => store.transitionAttempt(
      claimed.attempt.id,
      "worker-1",
      ["PREPARING"],
      "IMPLEMENTING",
    )).toThrow(/cancel/i);
    const reclaimed = store.claimNext(
      "worker-2",
      60_000,
      new Date(Date.now() + 120_000),
    );
    expect(reclaimed?.attempt.id).toBe(claimed.attempt.id);
    store.confirmCancellation(job.id, claimed.attempt.id, "worker-2");
    expect(store.get(job.id)?.status).toBe("CANCELLED");
  });

  it("records idempotent effects and append-only events", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const store = new JobStore(path.join(dir, "jobs.sqlite"));
    stores.push(store);
    const job = store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-1", specVersion: 1, specHash: "sha256:a",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 2,
    });
    const claimed = store.claimNext("worker-1", 60_000)!;
    const first = store.beginEffect(job.id, claimed.attempt.id, "push", "push:demo:head");
    const second = store.beginEffect(job.id, claimed.attempt.id, "push", "push:demo:head");
    expect(second.id).toBe(first.id);
    store.completeEffect(first.id, { headSha: "d".repeat(40) });
    expect(store.getEffect("push:demo:head")?.status).toBe("COMPLETED");
    expect(store.listEvents(job.id).map((event) => event.type)).toContain("JOB_CLAIMED");
  });

  it("summarizes local delivery and first-attempt effectiveness", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const store = new JobStore(path.join(dir, "jobs.sqlite"));
    stores.push(store);
    const job = store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-1", specVersion: 1, specHash: "sha256:a",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 2,
    });
    let attempt = store.claimNext("worker", 60_000)!.attempt;
    attempt = store.transitionAttempt(attempt.id, "worker", ["PREPARING"], "IMPLEMENTING");
    attempt = store.transitionAttempt(attempt.id, "worker", ["IMPLEMENTING"], "VERIFYING");
    attempt = store.transitionAttempt(attempt.id, "worker", ["VERIFYING"], "PUBLISHING");
    store.transitionAttempt(attempt.id, "worker", ["PUBLISHING"], "COMPLETED");
    store.transitionJob(job.id, ["PUBLISHING"], "DELIVERED_REVIEW_REQUIRED");

    expect(store.metrics()).toEqual({
      totalJobs: 1,
      activeJobs: 0,
      deliveredJobs: 1,
      firstAttemptDeliveries: 1,
      repairedDeliveries: 0,
      blockedJobs: 0,
      failedJobs: 0,
      cancelledJobs: 0,
      firstAttemptDeliveryRate: 1,
    });
  });

  it("covers lease renewal, queued cancellation, and failed effect bookkeeping", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const store = new JobStore(path.join(dir, "jobs.sqlite"));
    stores.push(store);
    expect(store.metrics().firstAttemptDeliveryRate).toBe(0);

    const queued = store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-CANCEL", specVersion: 1, specHash: "sha256:cancel",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 1,
    });
    expect(store.requestCancellation(queued.id).status).toBe("CANCELLED");
    expect(store.requestCancellation(queued.id).status).toBe("CANCELLED");

    const active = store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-ACTIVE", specVersion: 1, specHash: "sha256:active",
      taskCommitSha: "d".repeat(40), taskBlobSha: "e".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "f".repeat(40),
      policyVersion: 2, maxAttempts: 1,
    });
    const claim = store.claimNext("worker", 1_000, new Date("2026-07-23T00:00:00.000Z"));
    expect(claim?.job.id).toBe(active.id);
    expect(store.heartbeat(
      claim!.attempt.id,
      "worker",
      1_000,
      new Date("2026-07-23T00:00:00.500Z"),
    ).heartbeatAt).toBe("2026-07-23T00:00:00.500Z");
    expect(() => store.heartbeat(claim!.attempt.id, "other-worker", 1_000)).toThrow(/lease/);

    const effect = store.beginEffect(active.id, claim!.attempt.id, "push", "push:failed");
    store.failEffect(effect.id, { reason: "network" });
    expect(store.getEffect("push:failed")?.status).toBe("FAILED");
    store.update(active.id, {});
  });

  it("migrates the legacy jobs table forward without losing rows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const databaseFile = path.join(dir, "jobs.sqlite");
    const legacy = new DatabaseSync(databaseFile);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, repository_alias TEXT NOT NULL, task_id TEXT NOT NULL,
        spec_version INTEGER NOT NULL, spec_hash TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pid INTEGER,
        cursor_agent_id TEXT, cursor_run_id TEXT, worktree TEXT, base_sha TEXT,
        report_path TEXT, log_path TEXT, pr_url TEXT, error_message TEXT,
        UNIQUE(repository_alias, task_id, spec_hash)
      );
      INSERT INTO jobs (
        id, repository_alias, task_id, spec_version, spec_hash, status, created_at, updated_at
      ) VALUES (
        'legacy', 'demo', 'TASK-1', 1, 'sha256:a', 'FAILED',
        '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
      );
      INSERT INTO jobs (
        id, repository_alias, task_id, spec_version, spec_hash, status, created_at, updated_at
      ) VALUES (
        'legacy-active', 'demo', 'TASK-2', 1, 'sha256:b', 'RUNNING',
        '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
      );
    `);
    legacy.close();

    const store = new JobStore(databaseFile);
    stores.push(store);
    expect(store.get("legacy")?.status).toBe("FAILED");
    expect(store.get("legacy-active")?.status).toBe("FAILED");
    expect(store.get("legacy-active")?.errorMessage).toMatch(/cannot be resumed/);
    expect(store.schemaVersion()).toBe(STATE_SCHEMA_VERSION);
  });
});
