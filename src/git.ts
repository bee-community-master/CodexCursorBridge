import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertRelativeRepoPath } from "./paths.js";

const exec = promisify(execFile);

export interface CommandResult { stdout: string; stderr: string }

export async function runFile(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<CommandResult> {
  const result = await exec(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    signal: options.signal,
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runFile("git", ["-C", cwd, ...args])).stdout.trim();
}

function splitZero(value: string): string[] {
  return value.split("\0").filter(Boolean).map(assertRelativeRepoPath);
}

async function countUntrackedLines(root: string, files: readonly string[]): Promise<number> {
  let lines = 0;
  for (const file of files) {
    const content = await readFile(path.join(root, file));
    const text = content.toString("utf8");
    lines += text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  }
  return lines;
}

export interface CollectedChanges {
  files: string[];
  deletedFiles: string[];
  diffLines: number;
}

export interface CandidateTree {
  treeHash: string;
  patchHash: string;
}

export async function collectChanges(root: string, baseSha: string): Promise<CollectedChanges> {
  const tracked = splitZero(await git(root, "diff", "--name-only", "-z", baseSha));
  const untracked = splitZero(await git(root, "ls-files", "--others", "--exclude-standard", "-z"));
  const deletedFiles = splitZero(await git(root, "diff", "--diff-filter=D", "--name-only", "-z", baseSha));
  const numstat = await git(root, "diff", "--numstat", baseSha);
  let diffLines = numstat.split("\n").filter(Boolean).reduce((total, line) => {
    const [added = "0", deleted = "0"] = line.split("\t");
    return total + (added === "-" ? 0 : Number(added)) + (deleted === "-" ? 0 : Number(deleted));
  }, 0);
  diffLines += await countUntrackedLines(root, untracked);
  return { files: [...new Set([...tracked, ...untracked])].sort(), deletedFiles, diffLines };
}

export async function computeCandidateTree(root: string, approvedBaseSha?: string): Promise<CandidateTree> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cursor-bridge-index-"));
  const indexFile = path.join(temporary, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await runFile("git", ["-C", root, "read-tree", "HEAD"], { env });
    await runFile("git", ["-C", root, "add", "-A"], { env });
    const treeHash = (await runFile("git", ["-C", root, "write-tree"], { env })).stdout.trim();
    const baseSha = approvedBaseSha ?? await git(root, "rev-parse", "HEAD");
    const patchHash = `sha256:${createHash("sha256")
      .update(`${baseSha}\0${treeHash}`)
      .digest("hex")}`;
    return { treeHash, patchHash };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function computeContextDigest(
  root: string,
  baseSha: string,
  files: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const input of [...files].sort()) {
    const file = assertRelativeRepoPath(input);
    const blobSha = await git(root, "rev-parse", `${baseSha}:${file}`);
    hash.update(file).update("\0").update(blobSha).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function githubOriginSlug(originUrl: string): string {
  const match = originUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match?.[1]) throw new Error(`Origin is not a GitHub repository: ${originUrl}`);
  return match[1];
}
