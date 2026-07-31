import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
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
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`child heartbeat proof timed out: ${stderr}`));
      }, 3_000);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    expect(result, `child stderr: ${stderr}\nchild stdout: ${stdout}`).toMatchObject({ code: 0, signal: null });
    const payload = JSON.parse(stdout.trim()) as { before: string; after?: string };
    expect(payload.after).toBeDefined();
    expect(payload.after).not.toBe(payload.before);
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
