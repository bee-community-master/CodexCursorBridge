import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimePaths } from "../src/domain/configuration.js";
import { JobStore } from "../src/state.js";
import {
  runSupervisor,
  SupervisorShutdownError,
  supervisorBackoffMs,
} from "../src/supervisor.js";

// Under full-file parallelism, worker startup can be CPU-starved for several
// seconds. Keep the shutdown contract strict below; this watchdog only covers
// child readiness and teardown scheduling under that measured contention.
const childLifecycleTimeoutMs = 10_000;
const shutdownTestTimeoutMs = 30_000;

const stores: JobStore[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});

function runtimePaths(root: string): RuntimePaths {
  return {
    projectRoot: root,
    home: root,
    configFile: path.join(root, "config.json"),
    databaseFile: path.join(root, "jobs.sqlite"),
    logsDir: path.join(root, "logs"),
    reportsDir: path.join(root, "reports"),
    worktreesDir: path.join(root, "worktrees"),
    tasksDir: path.join(root, "tasks"),
  };
}

async function runPendingClaimShutdownChild(
  signal: "SIGTERM" | "SIGINT",
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  shutdownElapsedMs: number;
  stderr: string;
  stdout: string;
  root: string;
}> {
  const script = `
    import { mkdtemp } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    const { JobStore } = await import("./src/state.ts");
    const { runSupervisor, SupervisorShutdownError } = await import("./src/supervisor.ts");
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-supervisor-shutdown-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-SHUTDOWN", specVersion: 1, specHash: "sha256:shutdown",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 1,
    });
    const independentHandle = setInterval(() => undefined, 1_000);
    void independentHandle;
    const paths = {
      projectRoot: root, home: root, configFile: path.join(root, "config.json"),
      databaseFile: path.join(root, "jobs.sqlite"), logsDir: path.join(root, "logs"),
      reportsDir: path.join(root, "reports"), worktreesDir: path.join(root, "worktrees"),
      tasksDir: path.join(root, "tasks"),
    };
    let forceExit = false;
    try {
      await runSupervisor(store, paths, {
        workerToken: "shutdown-worker",
        claimLeaseMs: 100,
        heartbeatIntervalMs: 20,
        processClaim: async () => {
          process.stdout.write("READY " + root + "\\n");
          await new Promise(() => undefined);
        },
      });
    } catch (error) {
      if (error instanceof SupervisorShutdownError) forceExit = true;
      else throw error;
    } finally {
      store.close();
      process.stdout.write("CLEANUP\\n");
    }
    if (forceExit) process.exit(0);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let signalled = false;
    let settled = false;
    let root = "";
    let signalSentAt: number | undefined;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      void new Promise<void>((finish) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          finish();
          return;
        }
        child.once("exit", () => finish());
      }).finally(() => {
        reject(new Error(`shutdown child timed out for ${signal}; stderr=${stderr}`));
      });
    }, childLifecycleTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!signalled && stdout.includes("READY ")) {
        signalled = true;
        root = stdout.match(/READY ([^\n]+)/)?.[1] ?? "";
        signalSentAt = Date.now();
        child.kill(signal);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const finishedAt = Date.now();
      resolve({
        code,
        signal: childSignal,
        elapsedMs: finishedAt - startedAt,
        shutdownElapsedMs: finishedAt - (signalSentAt ?? startedAt),
        stderr,
        stdout,
        root,
      });
    });
  });
}

describe("durable supervisor recovery", () => {
  it("clears the claim heartbeat on SIGTERM and SIGINT while processClaim is unresolved", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const result = await runPendingClaimShutdownChild(signal);
      expect(result, `${signal} stderr: ${result.stderr}`).toMatchObject({
        code: 0,
        signal: null,
      });
      expect(result.shutdownElapsedMs).toBeLessThan(1_000);
      expect(result.stdout.indexOf("READY ")).toBeGreaterThanOrEqual(0);
      expect(result.stdout.indexOf("CLEANUP")).toBeGreaterThan(result.stdout.indexOf("READY "));
      expect(result.stdout).toContain("CLEANUP");
      const replacement = new JobStore(path.join(result.root, "jobs.sqlite"));
      stores.push(replacement);
      const reclaimed = replacement.claimNext("replacement-worker", 60_000);
      expect(reclaimed?.resumed).toBe(true);
      expect(reclaimed?.attempt.status).toBe("PREPARING");
    }
  }, shutdownTestTimeoutMs);

  it("keeps a pending claim alive long enough for a referenced heartbeat to advance the lease", async () => {
    const script = `
      import { mkdtemp } from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";
      const { JobStore } = await import("./src/state.ts");
      const { runSupervisor } = await import("./src/supervisor.ts");
      const root = await mkdtemp(path.join(os.tmpdir(), "cursor-supervisor-child-"));
      const store = new JobStore(path.join(root, "jobs.sqlite"));
      const job = store.createOrGet({
        repositoryAlias: "demo", taskId: "TASK-CHILD", specVersion: 1, specHash: "sha256:child",
        taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
        targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
        policyVersion: 2, maxAttempts: 1,
      });
      const claim = store.claimNext("child-worker", 100);
      const before = claim.attempt.heartbeatAt;
      const paths = {
        projectRoot: root, home: root, configFile: path.join(root, "config.json"),
        databaseFile: path.join(root, "jobs.sqlite"), logsDir: path.join(root, "logs"),
        reportsDir: path.join(root, "reports"), worktreesDir: path.join(root, "worktrees"),
        tasksDir: path.join(root, "tasks"),
      };
      await runSupervisor(store, paths, {
        workerToken: "child-worker",
        claimLeaseMs: 100,
        heartbeatIntervalMs: 20,
        processClaim: async () => {
          const timer = setTimeout(() => {
            const current = store.getAttempt(claim.attempt.id);
            process.stdout.write(JSON.stringify({ before, after: current?.heartbeatAt }) + "\\n", () => process.exit(0));
          }, 140);
          timer.unref();
          await new Promise(() => undefined);
        },
      });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        child.kill("SIGKILL");
        void new Promise<void>((finish) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            finish();
            return;
          }
          child.once("exit", () => finish());
        }).finally(() => {
          reject(new Error(`child heartbeat proof timed out: ${stderr}`));
        });
      }, childLifecycleTimeoutMs);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    expect(result, `child stderr: ${stderr}\nchild stdout: ${stdout}`).toMatchObject({ code: 0, signal: null });
    const payload = JSON.parse(stdout.trim()) as { before: string; after?: string };
    expect(payload.after).toBeDefined();
    expect(payload.after).not.toBe(payload.before);
  }, shutdownTestTimeoutMs);

  it("reclaims one expired active claim while a primary workflow is still running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-supervisor-reclaim-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    stores.push(store);
    const primaryJob = store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-748", specVersion: 1, specHash: "sha256:primary",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 2,
    });
    let staleJobId: string | undefined;
    let staleAttemptId: string | undefined;
    let stopping = false;
    let recovered!: () => void;
    const recoveredPromise = new Promise<void>((resolve) => {
      recovered = resolve;
    });
    const processClaims: string[] = [];

    await runSupervisor(store, runtimePaths(root), {
      workerToken: "supervisor-test",
      claimLeaseMs: 60,
      heartbeatIntervalMs: 10,
      reclaimIntervalMs: 5,
      shouldStop: () => stopping,
      processClaim: async (_state, claim) => {
        processClaims.push(claim.job.id);
        if (claim.job.id === primaryJob.id) {
          const staleJob = store.createOrGet({
            repositoryAlias: "demo", taskId: "TASK-718", specVersion: 1, specHash: "sha256:stale",
            taskCommitSha: "d".repeat(40), taskBlobSha: "e".repeat(40),
            targetOrigin: "owner/demo", targetBaseSha: "f".repeat(40),
            policyVersion: 2, maxAttempts: 2,
          });
          staleJobId = staleJob.id;
          const staleClaim = store.claimNext(
            "dead-worker",
            10,
            new Date(Date.now() - 1_000),
          )!;
          staleAttemptId = staleClaim.attempt.id;
          const queuedJob = store.createOrGet({
            repositoryAlias: "demo", taskId: "TASK-QUEUED", specVersion: 1, specHash: "sha256:queued",
            taskCommitSha: "1".repeat(40), taskBlobSha: "2".repeat(40),
            targetOrigin: "owner/demo", targetBaseSha: "3".repeat(40),
            policyVersion: 2, maxAttempts: 2,
          });

          await recoveredPromise;
          expect(store.get(queuedJob.id)?.status).toBe("QUEUED");
          return;
        }

        expect(claim.job.id).toBe(staleJobId);
        expect(claim.attempt.id).toBe(staleAttemptId);
        expect(claim.attempt.workerToken).toBe("supervisor-test");
        stopping = true;
        recovered();
      },
    });

    expect(processClaims).toEqual([primaryJob.id, staleJobId]);
    expect(staleJobId).toBeDefined();
    expect(staleAttemptId).toBeDefined();
    expect(store.get(staleJobId!)?.status).toBe("PREPARING");
    expect(store.getAttempt(staleAttemptId!)?.workerToken).toBe("supervisor-test");
    expect(() => store.transitionAttempt(
      staleAttemptId!,
      "dead-worker",
      ["PREPARING"],
      "IMPLEMENTING",
    )).toThrow(/changed concurrently|lease/i);
  });

  it("does not reclaim a still-running recovery from the foreground loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-supervisor-reclaim-duplicate-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    stores.push(store);
    const primaryJob = store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-PRIMARY-TERMINAL", specVersion: 1, specHash: "sha256:primary-terminal",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 2,
    });
    let recoveryJobId: string | undefined;
    let recoveryAttemptId: string | undefined;
    let queuedJobId: string | undefined;
    let stopping = false;
    let recoveryStarted!: () => void;
    const recoveryStartedPromise = new Promise<void>((resolve) => {
      recoveryStarted = resolve;
    });
    let releaseRecovery!: () => void;
    const recoveryReleasePromise = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const processClaims: string[] = [];
    const recoveryEffects: string[] = [];

    await runSupervisor(store, runtimePaths(root), {
      workerToken: "supervisor-duplicate-test",
      claimLeaseMs: 30,
      heartbeatIntervalMs: 100,
      reclaimIntervalMs: 5,
      idlePollMs: 5,
      shouldStop: () => stopping,
      processClaim: async (_state, claim) => {
        processClaims.push(claim.job.id);
        if (claim.job.id === primaryJob.id) {
          const recoveryJob = store.createOrGet({
            repositoryAlias: "demo", taskId: "TASK-RECOVERY-PENDING", specVersion: 1, specHash: "sha256:recovery-pending",
            taskCommitSha: "d".repeat(40), taskBlobSha: "e".repeat(40),
            targetOrigin: "owner/demo", targetBaseSha: "f".repeat(40),
            policyVersion: 2, maxAttempts: 2,
          });
          recoveryJobId = recoveryJob.id;
          const staleClaim = store.claimNext(
            "dead-worker",
            10,
            new Date(Date.now() - 1_000),
          )!;
          recoveryAttemptId = staleClaim.attempt.id;
          const queuedJob = store.createOrGet({
            repositoryAlias: "demo", taskId: "TASK-QUEUED-AFTER-RECOVERY", specVersion: 1, specHash: "sha256:queued-after-recovery",
            taskCommitSha: "1".repeat(40), taskBlobSha: "2".repeat(40),
            targetOrigin: "owner/demo", targetBaseSha: "3".repeat(40),
            policyVersion: 2, maxAttempts: 2,
          });
          queuedJobId = queuedJob.id;

          await recoveryStartedPromise;
          await new Promise((resolve) => setTimeout(resolve, 50));
          store.transitionAttempt(
            claim.attempt.id,
            claim.attempt.workerToken,
            ["PREPARING"],
            "FAILED",
            { errorMessage: "primary terminal" },
          );
          return;
        }

        if (claim.job.id === recoveryJobId) {
          recoveryEffects.push("recovery-effect");
          store.recordEvent(claim.job.id, claim.attempt.id, "RECOVERY_EFFECT", {});
          if (recoveryEffects.length === 1) {
            recoveryStarted();
            await recoveryReleasePromise;
          } else {
            stopping = true;
            releaseRecovery();
          }
          return;
        }

        expect(claim.job.id).toBe(queuedJobId);
        store.transitionAttempt(
          claim.attempt.id,
          claim.attempt.workerToken,
          ["PREPARING"],
          "FAILED",
          { errorMessage: "queued terminal" },
        );
        stopping = true;
        releaseRecovery();
      },
    });

    expect(processClaims).toEqual([primaryJob.id, recoveryJobId, queuedJobId]);
    expect(recoveryEffects).toHaveLength(1);
    expect(store.listEvents(recoveryJobId!).filter((event) => event.type === "ATTEMPT_RECLAIMED"))
      .toHaveLength(1);
    expect(store.listEvents(recoveryJobId!).filter((event) => event.type === "RECOVERY_EFFECT"))
      .toHaveLength(1);
    expect(store.getAttempt(recoveryAttemptId!)?.workerToken).toBe("supervisor-duplicate-test");
  });

  it("stops detached recovery heartbeats before forced shutdown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-supervisor-reclaim-shutdown-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    stores.push(store);
    const primaryJob = store.createOrGet({
      repositoryAlias: "demo", taskId: "TASK-PRIMARY", specVersion: 1, specHash: "sha256:primary-shutdown",
      taskCommitSha: "a".repeat(40), taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo", targetBaseSha: "c".repeat(40),
      policyVersion: 2, maxAttempts: 2,
    });
    let staleAttemptId: string | undefined;
    let stopping = false;
    let detachedStarted!: () => void;
    const detachedStartedPromise = new Promise<void>((resolve) => {
      detachedStarted = resolve;
    });

    const startedAt = Date.now();
    await expect(runSupervisor(store, runtimePaths(root), {
      workerToken: "supervisor-shutdown-test",
      claimLeaseMs: 60,
      heartbeatIntervalMs: 10,
      reclaimIntervalMs: 5,
      shouldStop: () => stopping,
      processClaim: async (_state, claim) => {
        if (claim.job.id === primaryJob.id) {
          const staleJob = store.createOrGet({
            repositoryAlias: "demo", taskId: "TASK-STALE-SHUTDOWN", specVersion: 1, specHash: "sha256:stale-shutdown",
            taskCommitSha: "d".repeat(40), taskBlobSha: "e".repeat(40),
            targetOrigin: "owner/demo", targetBaseSha: "f".repeat(40),
            policyVersion: 2, maxAttempts: 2,
          });
          const staleClaim = store.claimNext(
            "dead-worker",
            10,
            new Date(Date.now() - 1_000),
          )!;
          expect(staleClaim.job.id).toBe(staleJob.id);
          staleAttemptId = staleClaim.attempt.id;
          await new Promise<void>(() => undefined);
        }
        detachedStarted();
        stopping = true;
        await new Promise<void>(() => undefined);
      },
    })).rejects.toBeInstanceOf(SupervisorShutdownError);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    await detachedStartedPromise;
    expect(staleAttemptId).toBeDefined();
    expect(store.getAttempt(staleAttemptId!)?.workerToken).toBe("supervisor-shutdown-test");
  });

  it("uses a bounded exponential backoff for repeated runtime failures", () => {
    expect(supervisorBackoffMs(1)).toBe(250);
    expect(supervisorBackoffMs(2)).toBe(500);
    expect(supervisorBackoffMs(8)).toBe(30_000);
    expect(supervisorBackoffMs(100)).toBe(30_000);
  });

  it("contains a transient claim failure and wakes the next supervisor cycle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-supervisor-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    stores.push(store);
    const claimNext = vi.spyOn(store, "claimNext")
      .mockImplementation(() => {
        throw new Error("ConnectError: 503 Service Unavailable");
      });
    let stopping = false;
    const sleeps: number[] = [];

    await runSupervisor(store, runtimePaths(root), {
      workerToken: "supervisor-test",
      shouldStop: () => stopping,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        stopping = true;
      },
    });

    expect(claimNext).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([250]);
  });

  it("keeps a claimed job reclaimable when an unexpected process error escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-supervisor-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    stores.push(store);
    const job = store.createOrGet({
      repositoryAlias: "demo",
      taskId: "TASK-DEMO",
      specVersion: 1,
      specHash: "sha256:a",
      taskCommitSha: "a".repeat(40),
      taskBlobSha: "b".repeat(40),
      targetOrigin: "owner/demo",
      targetBaseSha: "c".repeat(40),
      policyVersion: 2,
      maxAttempts: 1,
    });
    let stopping = false;
    const sleeps: number[] = [];

    await runSupervisor(store, runtimePaths(root), {
      workerToken: "supervisor-test",
      shouldStop: () => stopping,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        stopping = true;
      },
      processClaim: async () => {
        throw new Error("ConnectError: 504 Gateway Timeout");
      },
    });

    expect(sleeps).toEqual([250]);
    expect(store.get(job.id)?.status).toBe("PREPARING");
    expect(store.getAttempt(store.get(job.id)!.currentAttemptId!)?.status).toBe("PREPARING");
  });

  it("interrupts idle polling promptly when shutdown is requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-supervisor-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    stores.push(store);
    let stopping = false;
    const stopTimer = setTimeout(() => {
      stopping = true;
    }, 20);
    const startedAt = Date.now();

    await runSupervisor(store, runtimePaths(root), {
      shouldStop: () => stopping,
      idlePollMs: 30_000,
    });

    clearTimeout(stopTimer);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("interrupts failure backoff promptly when shutdown is requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-supervisor-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    stores.push(store);
    vi.spyOn(store, "claimNext").mockImplementation(() => {
      throw new Error("ConnectError: 503 Service Unavailable");
    });
    let stopping = false;
    const stopTimer = setTimeout(() => {
      stopping = true;
    }, 20);
    const startedAt = Date.now();

    await runSupervisor(store, runtimePaths(root), {
      shouldStop: () => stopping,
    });

    clearTimeout(stopTimer);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
