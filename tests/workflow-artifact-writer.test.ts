import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowArtifactWriter } from "../src/adapters/workflow-artifact-writer.js";
import type { Job } from "../src/domain/job.js";
import {
  approvedTask,
  fixedNow,
  paths,
  publicationInput,
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
        packageManager: {
          name: "pnpm",
          version: "11.10.0",
          digest: "sha512.abc123",
          source: "verifier-owned-corepack-cache",
          network: "denied",
        },
      }],
      error: "Verification failed with token: another-secret-value",
    });
    const content = await readFile(report, "utf8");

    expect(content).toContain("failing assertion");
    expect(content).toContain("pnpm@11.10.0 digest=sha512.abc123");
    expect(content).toContain("network=denied");
    expect(content).not.toContain("super-secret-value");
    expect(content).not.toContain("another-secret-value");
  });

  it("replaces existing report and attestation files with owner-only permissions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-artifacts-"));
    const reportsDir = path.join(directory, "reports");
    await mkdir(reportsDir);
    const writer = new WorkflowArtifactWriter({
      ...paths,
      home: directory,
      reportsDir,
    });
    const task = approvedTask({ mode: "new_draft" });
    const input = publicationInput();
    const job: Job = {
      id: "job",
      repositoryAlias: "demo",
      taskId: task.id,
      specVersion: task.spec_version,
      specHash: task.spec_hash,
      taskCommitSha: "b".repeat(40),
      taskBlobSha: "c".repeat(40),
      targetOrigin: task.target.origin,
      targetBaseSha: task.target.base_sha,
      policyVersion: task.policy_version,
      maxAttempts: 2,
      status: "DELIVERED_REVIEW_REQUIRED",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const reportPath = path.join(reportsDir, `${job.id}.md`);
    const attestationPath = path.join(
      reportsDir,
      `${job.id}.attestation.json`,
    );
    for (const file of [reportPath, attestationPath]) {
      await writeFile(file, "stale", { encoding: "utf8", mode: 0o644 });
      await chmod(file, 0o644);
    }
    const publication = {
      prUrl: "https://github.com/owner/repo/pull/1",
      headSha: "f".repeat(40),
      remoteHeadSha: "f".repeat(40),
      treeHash: input.tree.treeHash,
      isDraft: true,
    };

    await writer.writeReport({ job, task, attempts: input.attempts });
    await writer.writeAttestation({
      job,
      task,
      publication,
      ...input,
      verification: [{
        command: "pnpm test",
        status: "failed",
        durationMs: 10,
        output: "api_key=attestation-secret-value",
        packageManager: {
          name: "pnpm",
          version: "11.10.0",
          digest: "sha512.attestation",
          source: "verifier-owned-corepack-cache",
          network: "denied",
        },
      }],
    });

    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect((await stat(attestationPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(attestationPath, "utf8"))
      .not.toContain("attestation-secret-value");
    expect(await readFile(attestationPath, "utf8"))
      .toContain("sha512.attestation");
  });
});
