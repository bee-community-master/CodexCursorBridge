import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import {
  approvedTaskSchema,
  computeSpecHash,
  computeVerificationProfileHash,
  CURRENT_POLICY_VERSION,
  EMPTY_TASK_HASH,
  parseTask,
  type ApprovedTask,
  type Task,
} from "./domain/task.js";

export {
  computeSpecHash,
  computeVerificationProfileHash,
  CURRENT_POLICY_VERSION,
  parseTask,
  taskSchema,
} from "./domain/task.js";
export type { ApprovedTask, Task, VerificationCommand } from "./domain/task.js";

export interface TaskApprovalContext {
  origin: string;
  baseRef: string;
  destinationRef: string;
  baseSha: string;
  contextDigest: string;
  approvedAt?: string;
  approvedBy?: string;
}

async function assertUnlinkedPathBelowRoot(file: string, trustedRoot: string): Promise<void> {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(file);
  const relative = path.relative(root, target);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Task file must be located below the trusted project root");
  }

  let current = root;
  for (const component of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("Task file path must not contain linked directories");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Task file parent must be a directory");
    }
  }
}

export async function loadTaskFile(file: string, trustedRoot?: string): Promise<Task> {
  if (trustedRoot) await assertUnlinkedPathBelowRoot(file, trustedRoot);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Task file must be a plain file, not a symbolic link", { cause: error });
    }
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Task file must be a plain file");
    return parseTask(parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

export async function approveTaskFile(
  file: string,
  context: TaskApprovalContext,
  trustedRoot?: string,
): Promise<ApprovedTask> {
  const current = await loadTaskFile(file, trustedRoot);
  if (current.status !== "draft") throw new Error(`Task ${current.id} is not draft`);
  const verification = {
    ...current.verification,
    profile_hash: computeVerificationProfileHash(current.verification),
  };
  const approved = approvedTaskSchema.parse({
    ...current,
    status: "approved",
    spec_hash: EMPTY_TASK_HASH,
    policy_version: CURRENT_POLICY_VERSION,
    target: {
      origin: context.origin,
      base_ref: context.baseRef,
      destination_ref: context.destinationRef,
      base_sha: context.baseSha,
      context_digest: context.contextDigest,
    },
    approval: {
      approved_at: context.approvedAt ?? new Date().toISOString(),
      approved_by: context.approvedBy ?? process.env.USER ?? "local-user",
    },
    verification,
  });
  const withHash = approvedTaskSchema.parse({ ...approved, spec_hash: computeSpecHash(approved) });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, stringify(withHash, { lineWidth: 100 }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return withHash;
}

export function assertApprovedTask(
  task: Task,
  expectedVersion: number,
  expectedHash: string,
  expectedTarget?: { origin: string; baseSha?: string },
): asserts task is ApprovedTask {
  if (task.status !== "approved") throw new Error(`Task ${task.id} is not approved`);
  if (task.spec_version !== expectedVersion) throw new Error("STALE_SPEC: spec version does not match");
  if (task.spec_hash !== expectedHash || computeSpecHash(task) !== expectedHash) {
    throw new Error("STALE_SPEC: spec hash does not match");
  }
  if (Number(task.policy_version) !== CURRENT_POLICY_VERSION) {
    throw new Error(`STALE_SPEC: unsupported policy version ${task.policy_version}`);
  }
  if (task.verification.profile_hash !== computeVerificationProfileHash(task.verification)) {
    throw new Error("STALE_SPEC: verification profile hash does not match");
  }
  if (expectedTarget && task.target.origin !== expectedTarget.origin) {
    throw new Error("STALE_SPEC: target origin does not match registered repository");
  }
  if (expectedTarget?.baseSha && task.target.base_sha !== expectedTarget.baseSha) {
    throw new Error("STALE_SPEC: target base does not match");
  }
}
