import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import type { RepositoryConfig, RuntimePaths } from "../src/config.js";
import { loadJobTask, resolveCommittedTask } from "../src/dispatch.js";
import { computeContextDigest } from "../src/git.js";
import { approveTaskFile } from "../src/task.js";

const exec = promisify(execFile);

async function initRepository(root: string): Promise<void> {
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
}

describe("committed task dispatch boundary", () => {
  it("binds the job to committed task provenance and approved target context", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-dispatch-"));
    const bridge = path.join(directory, "bridge");
    const target = path.join(directory, "target");
    await initRepository(bridge);
    await initRepository(target);
    await exec("git", ["-C", target, "remote", "add", "origin", "git@github.com:owner/demo.git"]);
    await mkdir(path.join(target, "src"), { recursive: true });
    await writeFile(path.join(target, "src", "demo.ts"), "export const demo = true;\n", "utf8");
    await exec("git", ["-C", target, "add", "."]);
    await exec("git", ["-C", target, "commit", "-qm", "target base"]);
    const { stdout: baseOutput } = await exec("git", ["-C", target, "rev-parse", "HEAD"]);
    const baseSha = baseOutput.trim();
    const contextDigest = await computeContextDigest(target, baseSha, ["src/demo.ts"]);

    const taskDirectory = path.join(bridge, "tasks", "demo");
    const taskFile = path.join(taskDirectory, "TASK-DEMO.yaml");
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(taskFile, stringify({
      id: "TASK-DEMO",
      repository: "demo",
      title: "Demo",
      spec_version: 1,
      status: "draft",
      goal: "demo",
      context_files: ["src/demo.ts"],
      allowed_paths: ["src/**"],
      forbidden_paths: [],
      non_goals: [],
      acceptance_criteria: ["done"],
      implementation_constraints: [],
      verification: { commands: [{ command: "pnpm", args: ["test"] }] },
      required_new_tests: [],
      limits: {
        max_changed_files: 3,
        max_diff_lines: 100,
        allow_test_deletion: false,
        max_repair_attempts: 1,
      },
      stop_conditions: [],
      pull_request: { mode: "new_draft" },
    }), "utf8");
    const approved = await approveTaskFile(taskFile, {
      origin: "owner/demo",
      baseRef: "main",
      destinationRef: "main",
      baseSha,
      contextDigest,
      approvedAt: "2026-07-23T00:00:00.000Z",
      approvedBy: "test",
    });
    await exec("git", ["-C", bridge, "add", "."]);
    await exec("git", ["-C", bridge, "commit", "-qm", "approved task"]);

    const paths = {
      projectRoot: bridge,
      tasksDir: path.join(bridge, "tasks"),
    } as RuntimePaths;
    const repository: RepositoryConfig = {
      root: target,
      origin: "owner/demo",
      defaultBranch: "main",
    };
    const resolved = await resolveCommittedTask(
      paths,
      repository,
      "demo",
      "TASK-DEMO",
      approved.spec_version,
      approved.spec_hash,
    );

    expect(resolved.task).toEqual(approved);
    expect(resolved.createJobInput).toMatchObject({
      repositoryAlias: "demo",
      taskId: "TASK-DEMO",
      specVersion: 1,
      specHash: approved.spec_hash,
      targetOrigin: "owner/demo",
      targetBaseSha: baseSha,
      policyVersion: 3,
      maxAttempts: 2,
    });
    expect(resolved.createJobInput.taskCommitSha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(resolved.createJobInput.taskBlobSha).toMatch(/^[a-f0-9]{40,64}$/);

    await writeFile(taskFile, "status: draft\n", "utf8");
    const restored = await loadJobTask(paths, repository, {
      ...resolved.createJobInput,
      id: "job",
    });
    expect(restored).toEqual(approved);

    await exec("git", [
      "-C",
      target,
      "remote",
      "set-url",
      "--push",
      "origin",
      "git@github.com:attacker/demo.git",
    ]);
    await expect(loadJobTask(paths, repository, {
      ...resolved.createJobInput,
      id: "job",
    })).rejects.toThrow(/push remote/i);
  });
});
