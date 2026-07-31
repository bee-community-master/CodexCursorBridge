import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  destinationRef: "release",
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
        destination_ref: approval.destinationRef,
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

  it("does not make approval hashes depend on the machine locale comparator", () => {
    const verification = {
      commands: [{
        command: "tool",
        args: [] as string[],
        env: { ZED: "1", ALPHA: "2" },
        timeout_seconds: 900,
      }],
    };
    const baseline = computeVerificationProfileHash(verification);
    const localeCompare = vi.spyOn(String.prototype, "localeCompare")
      .mockImplementation(function reverse(this: string, other) {
        const left = String(this);
        const right = String(other);
        return left < right ? 1 : left > right ? -1 : 0;
      });

    try {
      expect(computeVerificationProfileHash(verification)).toBe(baseline);
    } finally {
      localeCompare.mockRestore();
    }
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
      destination_ref: approval.destinationRef,
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

  it("rejects a symlinked Task file instead of following machine-local content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-task-link-"));
    const target = path.join(dir, "outside.yaml");
    const file = path.join(dir, "TASK-001.yaml");
    const { stringify } = await import("yaml");
    await writeFile(target, stringify(task), "utf8");
    await symlink(target, file);

    await expect(approveTaskFile(file, approval)).rejects.toThrow(/plain|symlink/i);
  });

  it("rejects a Task reached through a symlinked directory below the project root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-task-parent-link-"));
    const outside = await mkdtemp(path.join(tmpdir(), "cursor-task-outside-"));
    const tasks = path.join(root, "tasks");
    const linkedRepository = path.join(tasks, "demo");
    const file = path.join(linkedRepository, "TASK-001.yaml");
    const { stringify } = await import("yaml");
    await mkdir(tasks);
    await writeFile(path.join(outside, "TASK-001.yaml"), stringify(task), "utf8");
    await symlink(outside, linkedRepository);

    await expect(approveTaskFile(file, approval, root)).rejects.toThrow(/linked|symlink/i);
    expect(await readFile(path.join(outside, "TASK-001.yaml"), "utf8")).toContain("status: draft");
  });

  it("atomically replaces an approved Task without modifying another hard link", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-task-link-"));
    const target = path.join(dir, "outside.yaml");
    const file = path.join(dir, "TASK-001.yaml");
    const { stringify } = await import("yaml");
    await writeFile(target, stringify(task), "utf8");
    await link(target, file);

    await approveTaskFile(file, approval);

    expect(await readFile(file, "utf8")).toContain("status: approved");
    expect(await readFile(target, "utf8")).toContain("status: draft");
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
        destination_ref: approval.destinationRef,
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

  it.each([
    "HOME",
    "CI",
    "LANG",
    "COREPACK_HOME",
    "COREPACK_ROOT",
    "COREPACK_CUSTOM_FLAG",
    "COREPACK_DEFAULT_TO_LATEST",
    "DYLD_INSERT_LIBRARIES",
    "LD_PRELOAD",
  ])(
    "rejects verification overrides for sandbox control variable %s",
    (name) => {
      expect(() => parseTask({
        ...task,
        verification: {
          commands: [{
            command: "pnpm",
            args: ["test"],
            env: { [name]: "/tmp/untrusted-value" },
          }],
        },
      })).toThrow(/reserved/i);
    },
  );

  it("rejects path patterns that cannot round-trip as literal macOS Git paths", () => {
    expect(() => parseTask({
      ...task,
      allowed_paths: ["src\\**"],
    })).toThrow(/path/i);
  });

  it.each([
    {
      ...task,
      forbidden_path: [".env"],
    },
    {
      ...task,
      limits: {
        ...task.limits,
        max_diff_line: 100,
      },
    },
    {
      ...task,
      verification: {
        commands: [{
          command: "pnpm",
          args: ["test"],
          timeout_second: 30,
        }],
      },
    },
  ])("rejects unknown Task fields instead of discarding a misspelled constraint", (candidate) => {
    expect(() => parseTask(candidate)).toThrow(/unrecognized|unknown/i);
  });

  it.each(["-f", "pnpm test", ".hidden-tool"])(
    "rejects an unsafe verification executable name: %s",
    (command) => {
      expect(() => parseTask({
        ...task,
        verification: {
          commands: [{ command, args: [] }],
        },
      })).toThrow(/command|executable/i);
    },
  );
});
