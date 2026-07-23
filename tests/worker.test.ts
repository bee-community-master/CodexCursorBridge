import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowAdapter } from "../src/application/workflow-ports.js";
import type { RuntimePaths } from "../src/config.js";
import type { ApprovedTask } from "../src/domain/task.js";
import { JobStore } from "../src/state.js";
import type { WorkerDependencies } from "../src/worker.js";

const mocks = vi.hoisted(() => ({
  loadMachineConfig: vi.fn(),
  loadJobTask: vi.fn(),
}));

vi.mock("../src/config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/config.js")>(),
  loadMachineConfig: mocks.loadMachineConfig,
}));
vi.mock("../src/dispatch.js", () => ({
  loadJobTask: mocks.loadJobTask,
}));

const { processClaim } = await import("../src/worker.js");

const stores: JobStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  mocks.loadMachineConfig.mockReset();
  mocks.loadJobTask.mockReset();
});

describe("worker lease fencing", () => {
  it("confirms a pre-run cancellation even when machine config cannot be loaded", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-worker-"));
    const store = new JobStore(path.join(directory, "jobs.sqlite"));
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
      maxAttempts: 2,
    });
    const claim = store.claimNext("worker", 60_000)!;
    store.requestCancellation(job.id);
    mocks.loadMachineConfig.mockRejectedValue(new Error("configuration read failed"));
    const paths = {
      projectRoot: directory,
      home: directory,
      configFile: path.join(directory, "config.json"),
      databaseFile: path.join(directory, "jobs.sqlite"),
      logsDir: path.join(directory, "logs"),
      reportsDir: path.join(directory, "reports"),
      worktreesDir: path.join(directory, "worktrees"),
      tasksDir: path.join(directory, "tasks"),
    } satisfies RuntimePaths;

    await processClaim(store, claim, paths);

    expect(store.get(job.id)?.status).toBe("CANCELLED");
    expect(store.getAttempt(claim.attempt.id)?.status).toBe("CANCELLED");
  });

  it("does not let a stale worker overwrite the replacement worker report", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-worker-"));
    const store = new JobStore(path.join(directory, "jobs.sqlite"));
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
      maxAttempts: 2,
    });
    const staleClaim = store.claimNext(
      "stale-worker",
      1_000,
      new Date("2026-07-23T00:00:00.000Z"),
    )!;
    const replacement = store.claimNext(
      "replacement-worker",
      60_000,
      new Date("2026-07-23T00:00:02.000Z"),
    );
    expect(replacement?.attempt.workerToken).toBe("replacement-worker");
    mocks.loadMachineConfig.mockRejectedValue(new Error("configuration read failed"));
    const paths = {
      projectRoot: directory,
      home: directory,
      configFile: path.join(directory, "config.json"),
      databaseFile: path.join(directory, "jobs.sqlite"),
      logsDir: path.join(directory, "logs"),
      reportsDir: path.join(directory, "reports"),
      worktreesDir: path.join(directory, "worktrees"),
      tasksDir: path.join(directory, "tasks"),
    } satisfies RuntimePaths;

    await processClaim(store, staleClaim, paths);

    expect(store.get(job.id)).toMatchObject({
      status: "PREPARING",
      currentAttemptId: replacement?.attempt.id,
    });
    expect(store.get(job.id)?.reportPath).toBeUndefined();
    expect(store.getAttempt(staleClaim.attempt.id)?.workerToken)
      .toBe("replacement-worker");
  });

  it("does not let a stale preflight failure overwrite a replacement terminal report", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-worker-"));
    const store = new JobStore(path.join(directory, "jobs.sqlite"));
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
      maxAttempts: 2,
    });
    const staleClaim = store.claimNext(
      "stale-worker",
      1_000,
      new Date("2026-07-23T00:00:00.000Z"),
    )!;
    const paths = {
      projectRoot: directory,
      home: directory,
      configFile: path.join(directory, "config.json"),
      databaseFile: path.join(directory, "jobs.sqlite"),
      logsDir: path.join(directory, "logs"),
      reportsDir: path.join(directory, "reports"),
      worktreesDir: path.join(directory, "worktrees"),
      tasksDir: path.join(directory, "tasks"),
    } satisfies RuntimePaths;
    mocks.loadMachineConfig.mockResolvedValue({
      cursorModelId: "grok-4.5",
      repositories: {
        demo: { root: directory, origin: "owner/demo", defaultBranch: "main" },
      },
    });
    let rejectTask!: (error: Error) => void;
    let markTaskReadStarted!: () => void;
    const taskReadStarted = new Promise<void>((resolve) => {
      markTaskReadStarted = resolve;
    });
    mocks.loadJobTask.mockImplementation(async () => new Promise((_resolve, reject) => {
      rejectTask = reject;
      markTaskReadStarted();
    }));

    const staleProcessing = processClaim(store, staleClaim, paths);
    await taskReadStarted;
    const replacement = store.claimNext(
      "replacement-worker",
      60_000,
      new Date("2026-07-23T00:00:02.000Z"),
    )!;
    store.transitionAttempt(
      replacement.attempt.id,
      replacement.attempt.workerToken,
      ["PREPARING"],
      "FAILED",
      { errorMessage: "replacement failure" },
    );
    store.update(job.id, { reportPath: "/replacement-report.md" });
    rejectTask(new Error("stale task read failed"));
    await staleProcessing;

    expect(store.get(job.id)).toMatchObject({
      status: "FAILED",
      reportPath: "/replacement-report.md",
      errorMessage: "replacement failure",
    });
  });

  it("does not fall back to an unfenced Job failure when the lease changes during error handling", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-worker-"));
    const store = new JobStore(path.join(directory, "jobs.sqlite"));
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
      maxAttempts: 2,
    });
    const staleClaim = store.claimNext(
      "stale-worker",
      1_000,
      new Date("2026-07-23T00:00:00.000Z"),
    )!;
    const originalTransition = store.transitionAttempt.bind(store);
    let replacementToken: string | undefined;
    vi.spyOn(store, "transitionAttempt").mockImplementationOnce((...args) => {
      replacementToken = store.claimNext(
        "replacement-worker",
        60_000,
        new Date("2026-07-23T00:00:02.000Z"),
      )?.attempt.workerToken;
      return originalTransition(...args);
    });
    mocks.loadMachineConfig.mockRejectedValue(new Error("configuration read failed"));
    const paths = {
      projectRoot: directory,
      home: directory,
      configFile: path.join(directory, "config.json"),
      databaseFile: path.join(directory, "jobs.sqlite"),
      logsDir: path.join(directory, "logs"),
      reportsDir: path.join(directory, "reports"),
      worktreesDir: path.join(directory, "worktrees"),
      tasksDir: path.join(directory, "tasks"),
    } satisfies RuntimePaths;

    await processClaim(store, staleClaim, paths);

    expect(replacementToken).toBe("replacement-worker");
    expect(store.get(job.id)).toMatchObject({
      status: "PREPARING",
      currentAttemptId: staleClaim.attempt.id,
    });
    expect(store.get(job.id)?.reportPath).toBeUndefined();
    expect(store.getAttempt(staleClaim.attempt.id)?.workerToken)
      .toBe("replacement-worker");
  });

  it("preserves a terminal preflight failure without crashing when its report cannot be written", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-worker-"));
    const store = new JobStore(path.join(directory, "jobs.sqlite"));
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
      maxAttempts: 2,
    });
    const claim = store.claimNext("worker", 60_000)!;
    const reportsDir = path.join(directory, "reports");
    await writeFile(reportsDir, "not a directory", "utf8");
    mocks.loadMachineConfig.mockRejectedValue(new Error("configuration read failed"));
    const paths = {
      projectRoot: directory,
      home: directory,
      configFile: path.join(directory, "config.json"),
      databaseFile: path.join(directory, "jobs.sqlite"),
      logsDir: path.join(directory, "logs"),
      reportsDir,
      worktreesDir: path.join(directory, "worktrees"),
      tasksDir: path.join(directory, "tasks"),
    } satisfies RuntimePaths;

    await expect(processClaim(store, claim, paths)).resolves.toBeUndefined();

    expect(store.get(job.id)).toMatchObject({
      status: "FAILED",
      errorMessage: "configuration read failed",
    });
    expect(store.get(job.id)?.reportPath).toBeUndefined();
    expect(store.listEvents(job.id).at(-1)).toMatchObject({
      type: "REPORT_PERSISTENCE_FAILED",
    });
  });

  it("accepts explicit composition dependencies without module mocking", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-worker-"));
    const store = new JobStore(path.join(directory, "jobs.sqlite"));
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
      policyVersion: 3,
      maxAttempts: 2,
    });
    const claim = store.claimNext("worker", 60_000)!;
    const paths = {
      projectRoot: directory,
      home: directory,
      configFile: path.join(directory, "config.json"),
      databaseFile: path.join(directory, "jobs.sqlite"),
      logsDir: path.join(directory, "logs"),
      reportsDir: path.join(directory, "reports"),
      worktreesDir: path.join(directory, "worktrees"),
      tasksDir: path.join(directory, "tasks"),
    } satisfies RuntimePaths;
    const repository = {
      root: directory,
      origin: "owner/demo",
      defaultBranch: "main",
    };
    const fakeAdapter = {} as WorkflowAdapter;
    const fakeTask = { id: "TASK-DEMO" } as ApprovedTask;
    const dependencies = {
      loadMachineConfig: vi.fn(async () => ({
        cursorModelId: "grok-4.5",
        repositories: { demo: repository },
      })),
      loadJobTask: vi.fn(async () => fakeTask),
      createWorkflowAdapter: vi.fn(() => fakeAdapter),
      executeWorkflow: vi.fn(async () => undefined),
    } satisfies WorkerDependencies;

    await processClaim(store, claim, paths, dependencies);

    expect(dependencies.createWorkflowAdapter).toHaveBeenCalledWith(
      paths,
      expect.objectContaining({ repositories: { demo: repository } }),
      store,
      job.id,
    );
    expect(dependencies.executeWorkflow).toHaveBeenCalledWith(
      store,
      claim,
      fakeTask,
      repository,
      fakeAdapter,
    );
  });
});
