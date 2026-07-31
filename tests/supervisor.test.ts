import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimePaths } from "../src/domain/configuration.js";
import { JobStore } from "../src/state.js";
import { runSupervisor, supervisorBackoffMs } from "../src/supervisor.js";

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

describe("durable supervisor recovery", () => {
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
