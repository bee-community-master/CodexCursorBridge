import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_POLICY_VERSION,
  approveTaskFile,
  assertApprovedTask,
  computeSpecHash,
  computeVerificationProfileHash,
  parseTask,
} from "../src/task.js";

const task = {
  id: "TASK-001",
  repository: "demo",
  title: "Fix the demo",
  spec_version: 1,
  status: "draft",
  goal: "Make the demo reliable",
  context_files: ["src/demo.ts"],
  allowed_paths: ["src/**", "tests/**"],
  forbidden_paths: [".env", "infra/**"],
  non_goals: ["No migration"],
  acceptance_criteria: ["Tests pass"],
  implementation_constraints: ["No new runtime dependency"],
  verification: { commands: [{ command: "pnpm", args: ["test"], timeout_seconds: 900 }] },
  required_new_tests: ["Regression test"],
  limits: {
    max_changed_files: 8,
    max_diff_lines: 500,
    allow_test_deletion: false,
    max_repair_attempts: 1,
  },
  stop_conditions: ["Schema change required"],
  pull_request: { mode: "new_draft" },
};

const approval = {
  origin: "owner/demo",
  baseRef: "main",
  baseSha: "a".repeat(40),
  contextDigest: `sha256:${"b".repeat(64)}`,
  approvedAt: "2026-07-23T00:00:00.000Z",
  approvedBy: "local-user",
};

describe("task contract", () => {
  it("produces a stable hash that excludes only spec_hash", () => {
    const approved = {
      ...task,
      status: "approved",
      spec_hash: `sha256:${"0".repeat(64)}`,
      policy_version: CURRENT_POLICY_VERSION,
      target: {
        origin: approval.origin,
        base_ref: approval.baseRef,
        base_sha: approval.baseSha,
        context_digest: approval.contextDigest,
      },
      approval: {
        approved_at: approval.approvedAt,
        approved_by: approval.approvedBy,
      },
      verification: {
        ...task.verification,
        profile_hash: computeVerificationProfileHash(task.verification),
      },
    } as const;
    const first = computeSpecHash(approved);
    const second = computeSpecHash({ ...approved, spec_hash: `sha256:${"f".repeat(64)}` });
    const withoutHash = computeSpecHash({ ...approved, spec_hash: undefined });
    expect(first).toBe(second);
    expect(withoutHash).toBe(first);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("requires a PR number for existing_pr", () => {
    expect(() => parseTask({ ...task, pull_request: { mode: "existing_pr" } })).toThrow();
  });

  it("approves a draft task and persists a matching hash", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-task-"));
    const file = path.join(dir, "TASK-001.yaml");
    const { stringify } = await import("yaml");
    await writeFile(file, stringify(task), "utf8");

    const approved = await approveTaskFile(file, approval);
    expect(approved.status).toBe("approved");
    expect(approved.spec_hash).toBe(computeSpecHash(approved));
    expect(approved.policy_version).toBe(CURRENT_POLICY_VERSION);
    expect(approved.target).toEqual({
      origin: approval.origin,
      base_ref: approval.baseRef,
      base_sha: approval.baseSha,
      context_digest: approval.contextDigest,
    });
    expect(approved.approval).toEqual({
      approved_at: approval.approvedAt,
      approved_by: approval.approvedBy,
    });
    expect(approved.verification.profile_hash).toBe(
      computeVerificationProfileHash(approved.verification),
    );
    expect(await readFile(file, "utf8")).toContain("status: approved");
    await expect(approveTaskFile(file, approval)).rejects.toThrow(/not draft/);
  });

  it("rejects draft and stale approved specs", () => {
    const unhashed = {
      ...task,
      status: "approved",
      spec_hash: `sha256:${"0".repeat(64)}`,
      policy_version: CURRENT_POLICY_VERSION,
      target: {
        origin: approval.origin,
        base_ref: approval.baseRef,
        base_sha: approval.baseSha,
        context_digest: approval.contextDigest,
      },
      approval: {
        approved_at: approval.approvedAt,
        approved_by: approval.approvedBy,
      },
      verification: {
        ...task.verification,
        profile_hash: computeVerificationProfileHash(task.verification),
      },
    } as const;
    const hash = computeSpecHash(unhashed);
    const approved = parseTask({ ...unhashed, spec_hash: hash });
    expect(() => assertApprovedTask(parseTask(task), 1, hash)).toThrow(/not approved/);
    expect(() => assertApprovedTask(approved, 2, hash)).toThrow(/version/);
    expect(() => assertApprovedTask(approved, 1, `sha256:${"b".repeat(64)}`)).toThrow(/hash/);
    expect(() => assertApprovedTask(approved, 1, hash)).not.toThrow();
    expect(() => assertApprovedTask(
      approved,
      1,
      hash,
      { origin: "other/repo", baseSha: approval.baseSha },
    )).toThrow(/origin/);
    expect(() => assertApprovedTask(
      approved,
      1,
      hash,
      { origin: approval.origin, baseSha: "c".repeat(40) },
    )).toThrow(/base/);
  });

  it("rejects secret-shaped verification environment variables", () => {
    expect(() => parseTask({
      ...task,
      verification: {
        commands: [{
          command: "pnpm",
          args: ["test"],
          env: { GITHUB_TOKEN: "must-not-enter-a-task" },
        }],
      },
    })).toThrow(/secret/i);
  });

  it("rejects verification overrides for sandbox control variables", () => {
    expect(() => parseTask({
      ...task,
      verification: {
        commands: [{
          command: "pnpm",
          args: ["test"],
          env: { HOME: "/tmp/untrusted-home" },
        }],
      },
    })).toThrow(/reserved/i);
  });
});
