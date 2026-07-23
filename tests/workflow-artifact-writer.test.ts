import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowArtifactWriter } from "../src/adapters/workflow-artifact-writer.js";
import type { Job } from "../src/domain/job.js";
import {
  approvedTask,
  fixedNow,
  paths,
} from "./helpers/workflow-fixtures.js";

describe("workflow artifact writer", () => {
  it("includes redacted verifier diagnostics in a failure report", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-report-"));
    const writer = new WorkflowArtifactWriter({
      ...paths,
      home: directory,
      reportsDir: path.join(directory, "reports"),
    });
    const job: Job = {
      id: "job",
      repositoryAlias: "demo",
      taskId: "TASK-DEMO",
      specVersion: 2,
      specHash: `sha256:${"a".repeat(64)}`,
      taskCommitSha: "b".repeat(40),
      taskBlobSha: "c".repeat(40),
      targetOrigin: "owner/repo",
      targetBaseSha: "d".repeat(40),
      policyVersion: 2,
      maxAttempts: 2,
      status: "FAILED",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };

    const report = await writer.writeReport({
      job,
      task: approvedTask({ mode: "new_draft" }),
      verification: [{
        command: "pnpm test",
        status: "failed",
        durationMs: 10,
        output: "failing assertion\napi_key=super-secret-value",
      }],
      error: "Verification failed with token: another-secret-value",
    });
    const content = await readFile(report, "utf8");

    expect(content).toContain("failing assertion");
    expect(content).not.toContain("super-secret-value");
    expect(content).not.toContain("another-secret-value");
  });
});
