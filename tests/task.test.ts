import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { approveTaskFile, computeSpecHash, parseTask } from "../src/task.js";

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
  verification: { commands: [{ command: "pnpm", args: ["test"] }] },
  required_new_tests: ["Regression test"],
  limits: { max_changed_files: 8, max_diff_lines: 500, allow_test_deletion: false },
  stop_conditions: ["Schema change required"],
  pull_request: { mode: "new_draft" },
};

describe("task contract", () => {
  it("produces a stable hash that excludes only spec_hash", () => {
    const first = computeSpecHash({ ...task, status: "approved" });
    const second = computeSpecHash({ ...task, status: "approved", spec_hash: "sha256:old" });
    expect(first).toBe(second);
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

    const approved = await approveTaskFile(file);
    expect(approved.status).toBe("approved");
    expect(approved.spec_hash).toBe(computeSpecHash(approved));
    expect(await readFile(file, "utf8")).toContain("status: approved");
  });
});
