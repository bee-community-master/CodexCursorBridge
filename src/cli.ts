import { Cursor } from "@cursor/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, uninstall } from "./bootstrap.js";
import { addRepository, loadMachineConfig, runtimePaths, saveMachineConfig } from "./config.js";
import {
  assertGitHubRemote,
  computeContextDigest,
  git,
  githubOriginSlug,
  runFile,
} from "./git.js";
import { readCursorApiKey } from "./keychain.js";
import { safeErrorMessage } from "./redaction.js";
import { JobStore } from "./state.js";
import { approveTaskFile, loadTaskFile } from "./task.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

async function addRepo(args: string[]): Promise<void> {
  const alias = option(args, "--alias");
  const root = path.resolve(option(args, "--path"));
  if (await git(root, "rev-parse", "--is-inside-work-tree") !== "true") throw new Error("Path is not a Git repository");
  const originUrl = await git(root, "remote", "get-url", "origin");
  const origin = githubOriginSlug(originUrl);
  await assertGitHubRemote(root, origin);
  let defaultBranch: string;
  try {
    defaultBranch = (await git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "");
  } catch {
    defaultBranch = (await runFile("gh", ["repo", "view", origin, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).stdout.trim();
  }
  if (!defaultBranch) throw new Error("Could not determine the remote default branch");
  const paths = runtimePaths(projectRoot);
  const config = await loadMachineConfig(paths.configFile);
  await saveMachineConfig(paths.configFile, addRepository(config, alias, { root, origin, defaultBranch }));
  process.stdout.write(`Registered ${alias}: ${origin} (${defaultBranch}) at ${root}\n`);
}

async function approve(args: string[]): Promise<void> {
  const alias = option(args, "--repository");
  const taskId = option(args, "--task");
  const paths = runtimePaths(projectRoot);
  const config = await loadMachineConfig(paths.configFile);
  const repository = config.repositories[alias];
  if (!repository) throw new Error(`Repository alias is not registered: ${alias}`);
  const taskFile = path.join(paths.tasksDir, alias, `${taskId}.yaml`);
  const draft = await loadTaskFile(taskFile, paths.projectRoot);
  if (draft.id !== taskId || draft.repository !== alias) {
    throw new Error("Task identity does not match the approval request");
  }
  await assertGitHubRemote(repository.root, repository.origin);
  await git(repository.root, "fetch", "--prune", "origin");
  let baseRef = repository.defaultBranch;
  let destinationRef = repository.defaultBranch;
  let baseSha: string;
  if (draft.pull_request.mode === "existing_pr") {
    const output = await runFile("gh", [
      "pr",
      "view",
      String(draft.pull_request.number),
      "--repo",
      repository.origin,
      "--json",
      "state,isDraft,baseRefName,headRefName,headRefOid,headRepository",
    ]);
    const info = JSON.parse(output.stdout) as {
      state: string;
      isDraft: boolean;
      baseRefName: string;
      headRefName: string;
      headRefOid: string;
      headRepository: { nameWithOwner: string };
    };
    if (info.state !== "OPEN") throw new Error("Existing pull request is not open");
    if (!info.isDraft) throw new Error("Existing pull request must be a draft");
    if (info.headRepository.nameWithOwner !== repository.origin) {
      throw new Error("Existing pull request head must be in the registered repository");
    }
    baseRef = info.headRefName;
    destinationRef = info.baseRefName;
    baseSha = info.headRefOid;
  } else {
    baseSha = await git(repository.root, "rev-parse", `origin/${baseRef}`);
  }
  const contextDigest = await computeContextDigest(
    repository.root,
    baseSha,
    draft.context_files,
  );
  const task = await approveTaskFile(taskFile, {
    origin: repository.origin,
    baseRef,
    destinationRef,
    baseSha,
    contextDigest,
  }, paths.projectRoot);
  process.stdout.write(`${task.id} approved at v${task.spec_version}: ${task.spec_hash}\nCommit this Task file before dispatch.\n`);
}

async function listModels(): Promise<void> {
  const apiKey = await readCursorApiKey();
  const models = await Cursor.models.list({ apiKey });
  for (const model of models) process.stdout.write(`${model.id}\t${model.displayName}\n`);
}

function printStats(): void {
  const paths = runtimePaths(projectRoot);
  const store = new JobStore(paths.databaseFile);
  try {
    process.stdout.write(`${JSON.stringify(store.metrics(), null, 2)}\n`);
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "bootstrap": await bootstrap(projectRoot); break;
    case "uninstall": await uninstall(projectRoot, args.includes("--delete-key")); break;
    case "repo:add": await addRepo(args); break;
    case "task:approve": await approve(args); break;
    case "models:list": await listModels(); break;
    case "stats": printStats(); break;
    default: throw new Error("Usage: cli.ts <bootstrap|uninstall|repo:add|task:approve|models:list|stats>");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
