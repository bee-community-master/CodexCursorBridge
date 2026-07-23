import path from "node:path";
import { parse } from "yaml";
import type { RepositoryConfig, RuntimePaths } from "./config.js";
import { computeContextDigest, git, githubOriginSlug } from "./git.js";
import type { CreateJobInput, Job } from "./state.js";
import { assertApprovedTask, loadTaskFile, parseTask, type ApprovedTask } from "./task.js";

export interface ResolvedCommittedTask {
  task: ApprovedTask;
  createJobInput: CreateJobInput;
}

type JobTaskSource = Pick<
  Job,
  | "id"
  | "repositoryAlias"
  | "taskId"
  | "specVersion"
  | "specHash"
  | "taskCommitSha"
  | "taskBlobSha"
  | "targetOrigin"
  | "targetBaseSha"
  | "policyVersion"
>;

export async function resolveCommittedTask(
  paths: RuntimePaths,
  repository: RepositoryConfig,
  repositoryAlias: string,
  taskId: string,
  specVersion: number,
  specHash: string,
): Promise<ResolvedCommittedTask> {
  const taskFile = path.join(paths.tasksDir, repositoryAlias, `${taskId}.yaml`);
  const task = await loadTaskFile(taskFile);
  if (task.id !== taskId || task.repository !== repositoryAlias) {
    throw new Error("Task identity does not match the request");
  }
  const actualOrigin = githubOriginSlug(await git(repository.root, "remote", "get-url", "origin"));
  if (actualOrigin !== repository.origin) {
    throw new Error("Registered repository origin no longer matches its Git remote");
  }
  assertApprovedTask(task, specVersion, specHash, { origin: repository.origin });
  await git(repository.root, "cat-file", "-e", `${task.target.base_sha}^{commit}`);
  const contextDigest = await computeContextDigest(
    repository.root,
    task.target.base_sha,
    task.context_files,
  );
  if (contextDigest !== task.target.context_digest) {
    throw new Error("STALE_SPEC: approved target context digest does not match");
  }

  const relativeTask = path.relative(paths.projectRoot, taskFile);
  await git(paths.projectRoot, "ls-files", "--error-unmatch", relativeTask);
  if (await git(paths.projectRoot, "status", "--porcelain", "--", relativeTask)) {
    throw new Error("Approved task file must be committed and clean");
  }
  const taskCommitSha = await git(paths.projectRoot, "rev-parse", "HEAD");
  const taskBlobSha = await git(paths.projectRoot, "rev-parse", `HEAD:${relativeTask}`);
  return {
    task,
    createJobInput: {
      repositoryAlias,
      taskId,
      specVersion,
      specHash,
      taskCommitSha,
      taskBlobSha,
      targetOrigin: task.target.origin,
      targetBaseSha: task.target.base_sha,
      policyVersion: task.policy_version,
      maxAttempts: task.limits.max_repair_attempts + 1,
    },
  };
}

export async function loadJobTask(
  paths: RuntimePaths,
  repository: RepositoryConfig,
  job: JobTaskSource,
): Promise<ApprovedTask> {
  const actualOrigin = githubOriginSlug(await git(
    repository.root,
    "remote",
    "get-url",
    "origin",
  ));
  if (actualOrigin !== repository.origin || actualOrigin !== job.targetOrigin) {
    throw new Error("STALE_SPEC: runtime repository origin does not match the queued target");
  }
  const relativeTask = path.join("tasks", job.repositoryAlias, `${job.taskId}.yaml`);
  const committedBlob = await git(
    paths.projectRoot,
    "rev-parse",
    `${job.taskCommitSha}:${relativeTask}`,
  );
  if (committedBlob !== job.taskBlobSha) {
    throw new Error("STALE_SPEC: committed task blob does not match the queued job");
  }
  const content = await git(paths.projectRoot, "show", `${job.taskCommitSha}:${relativeTask}`);
  const task = parseTask(parse(content));
  if (task.id !== job.taskId || task.repository !== job.repositoryAlias) {
    throw new Error("STALE_SPEC: committed task identity does not match the queued job");
  }
  assertApprovedTask(task, job.specVersion, job.specHash, {
    origin: repository.origin,
    baseSha: job.targetBaseSha,
  });
  if (
    task.policy_version !== job.policyVersion
    || task.target.origin !== job.targetOrigin
  ) {
    throw new Error("STALE_SPEC: queued policy or target origin does not match the committed task");
  }
  const contextDigest = await computeContextDigest(
    repository.root,
    task.target.base_sha,
    task.context_files,
  );
  if (contextDigest !== task.target.context_digest) {
    throw new Error("STALE_SPEC: approved target context digest does not match");
  }
  return task;
}
