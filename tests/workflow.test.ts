import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryConfig } from "../src/config.js";
import { JobStore } from "../src/state.js";
import type { Task } from "../src/task.js";
import { executeWorkflow, type WorkflowAdapter } from "../src/workflow.js";

const stores: JobStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

const task = {
  id: "TASK-DEMO", repository: "demo", title: "Demo", spec_version: 1, status: "approved",
  spec_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  goal: "demo", context_files: [], allowed_paths: ["src/**"], forbidden_paths: ["infra/**"],
  non_goals: [], acceptance_criteria: ["done"], implementation_constraints: [],
  verification: { commands: [{ command: "pnpm", args: ["test"], timeout_seconds: 30 }] },
  required_new_tests: [], limits: { max_changed_files: 3, max_diff_lines: 50, allow_test_deletion: false },
  stop_conditions: [], pull_request: { mode: "new_draft" },
} satisfies Task;

const repository: RepositoryConfig = { root: "/repo", origin: "owner/repo", defaultBranch: "main" };

async function fixture(): Promise<{ store: JobStore; jobId: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cursor-workflow-"));
  const store = new JobStore(path.join(dir, "jobs.sqlite"));
  stores.push(store);
  const job = store.createOrGet({ repositoryAlias: "demo", taskId: task.id, specVersion: 1, specHash: task.spec_hash });
  return { store, jobId: job.id };
}

function adapter(files: string[]): WorkflowAdapter {
  return {
    prepare: vi.fn(async () => ({ worktree: "/worktree", baseSha: "base", pushBranch: "codex/cursor/task-demo", localBranch: "codex/cursor/task-demo" })),
    runCursor: vi.fn(async () => ({ agentId: "agent", runId: "run", summary: "implemented" })),
    collectChanges: vi.fn(async () => ({ files, deletedFiles: [], diffLines: 10 })),
    runVerification: vi.fn(async () => [{ command: "pnpm test", status: "passed" as const, durationMs: 1 }]),
    publish: vi.fn(async () => ({ prUrl: "https://github.com/owner/repo/pull/1" })),
    writeReport: vi.fn(async () => "/report.md"),
    cleanup: vi.fn(async () => undefined),
  };
}

describe("workflow orchestration", () => {
  it("publishes only after independent verification", async () => {
    const { store, jobId } = await fixture();
    const fake = adapter(["src/demo.ts"]);
    await executeWorkflow(store, jobId, task, repository, fake);
    expect(store.get(jobId)?.status).toBe("DONE");
    expect(fake.publish).toHaveBeenCalledOnce();
    expect(fake.cleanup).toHaveBeenCalledOnce();
  });

  it("stops with SCOPE_VIOLATION and preserves the worktree", async () => {
    const { store, jobId } = await fixture();
    const fake = adapter(["infra/main.tf"]);
    await executeWorkflow(store, jobId, task, repository, fake);
    expect(store.get(jobId)?.status).toBe("SCOPE_VIOLATION");
    expect(fake.publish).not.toHaveBeenCalled();
    expect(fake.cleanup).not.toHaveBeenCalled();
  });
});
