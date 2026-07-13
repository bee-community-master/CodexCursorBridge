import { Cursor } from "@cursor/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, uninstall } from "./bootstrap.js";
import { addRepository, loadMachineConfig, runtimePaths, saveMachineConfig } from "./config.js";
import { git, githubOriginSlug, runFile } from "./git.js";
import { readCursorApiKey } from "./keychain.js";
import { approveTaskFile } from "./task.js";

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
  const task = await approveTaskFile(path.join(projectRoot, "tasks", alias, `${taskId}.yaml`));
  process.stdout.write(`${task.id} approved at v${task.spec_version}: ${task.spec_hash}\nCommit this Task file before dispatch.\n`);
}

async function listModels(): Promise<void> {
  const apiKey = await readCursorApiKey();
  const models = await Cursor.models.list({ apiKey });
  for (const model of models) process.stdout.write(`${model.id}\t${model.displayName}\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "bootstrap": await bootstrap(projectRoot); break;
    case "uninstall": await uninstall(projectRoot, args.includes("--delete-key")); break;
    case "repo:add": await addRepo(args); break;
    case "task:approve": await approve(args); break;
    case "models:list": await listModels(); break;
    default: throw new Error("Usage: cli.ts <bootstrap|uninstall|repo:add|task:approve|models:list>");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
