import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CandidateTree,
  CollectedChanges,
} from "../application/workflow-ports.js";
import { assertRelativeRepoPath } from "../domain/repository-path.js";
import { runFile } from "./command-runner.js";
import {
  git,
  gitEnvironment,
  gitOutput,
} from "./git-runtime.js";

function splitZero(value: string): string[] {
  return value.split("\0").filter(Boolean).map(assertRelativeRepoPath);
}

async function countUntrackedLines(
  root: string,
  files: readonly string[],
): Promise<number> {
  let lines = 0;
  for (const file of files) {
    const absolute = path.join(root, file);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      lines += 1;
      continue;
    }
    if (!metadata.isFile()) continue;
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) continue;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytes = 0;
      let newlines = 0;
      let lastByte: number | undefined;
      let binary = false;
      for (;;) {
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (result.bytesRead === 0) break;
        bytes += result.bytesRead;
        const chunk = buffer.subarray(0, result.bytesRead);
        if (chunk.includes(0)) {
          binary = true;
          break;
        }
        for (const byte of chunk) {
          if (byte === 0x0a) newlines += 1;
        }
        lastByte = chunk.at(-1);
      }
      if (!binary && bytes > 0) lines += newlines + (lastByte === 0x0a ? 0 : 1);
    } finally {
      await handle.close();
    }
  }
  return lines;
}

function countNumstatLines(numstat: string): number {
  return numstat.split("\n").filter(Boolean).reduce((total, line) => {
    const [added = "0", deleted = "0"] = line.split("\t");
    return total
      + (added === "-" ? 0 : Number(added))
      + (deleted === "-" ? 0 : Number(deleted));
  }, 0);
}

async function neutralizedFilterArguments(root: string): Promise<string[]> {
  let configured = "";
  try {
    configured = (await runFile("git", [
      "-C",
      root,
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ], {
      env: gitEnvironment(),
    })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: number }).code !== 1) throw error;
  }
  const drivers = new Set<string>();
  for (const key of configured.split("\0").filter(Boolean)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
    if (!match?.[1] || /[\0\r\n]/.test(match[1])) {
      throw new Error("Git filter configuration contains an unsafe driver name");
    }
    drivers.add(match[1]);
  }
  const args = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
  ];
  for (const driver of [...drivers].sort()) {
    args.push(
      "-c",
      `filter.${driver}.clean=`,
      "-c",
      `filter.${driver}.smudge=`,
      "-c",
      `filter.${driver}.process=`,
      "-c",
      `filter.${driver}.required=false`,
    );
  }
  return args;
}

async function assertNoActiveFilters(
  root: string,
  files: readonly string[],
): Promise<void> {
  const present: string[] = [];
  for (const file of files) {
    try {
      await lstat(path.join(root, file));
      present.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (present.length === 0) return;
  const output = (await runFile("git", [
    "-C",
    root,
    "check-attr",
    "-z",
    "filter",
    "--",
    ...present,
  ], {
    env: gitEnvironment(),
  })).stdout.split("\0");
  const filtered: string[] = [];
  for (let index = 0; index + 2 < output.length; index += 3) {
    const file = output[index];
    const attribute = output[index + 1];
    const value = output[index + 2];
    if (
      file
      && attribute === "filter"
      && value
      && value !== "unspecified"
      && value !== "unset"
    ) {
      filtered.push(file);
    }
  }
  if (filtered.length > 0) {
    throw new Error(
      `Changed paths with active Git filters cannot be safely attested: ${filtered.join(", ")}`,
    );
  }
}

async function assertCandidateBlobsMatchWorkingFiles(
  root: string,
  files: readonly string[],
  treeHash: string,
): Promise<void> {
  for (const file of files) {
    let metadata;
    try {
      metadata = await lstat(path.join(root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    const rawBlob = (await gitOutput(root, [
      "hash-object",
      "--no-filters",
      "--",
      file,
    ])).trim();
    const candidateBlob = (await gitOutput(root, [
      "rev-parse",
      `${treeHash}:${file}`,
    ])).trim();
    if (rawBlob !== candidateBlob) {
      throw new Error(
        `Git attributes transform verified file bytes before publication: ${file}`,
      );
    }
  }
}

export async function collectChanges(
  root: string,
  baseSha: string,
): Promise<CollectedChanges> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cursor-bridge-collect-"));
  const environment = { GIT_INDEX_FILE: path.join(temporary, "index") };
  try {
    await gitOutput(root, ["read-tree", baseSha], environment);
    const tracked = splitZero(await gitOutput(root, [
      "diff",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      baseSha,
    ], environment));
    const untracked = splitZero(await gitOutput(
      root,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      environment,
    ));
    const deletedFiles = splitZero(await gitOutput(root, [
      "diff",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--diff-filter=D",
      "--name-only",
      "-z",
      baseSha,
    ], environment));
    const numstat = await gitOutput(root, [
      "diff",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      baseSha,
    ], environment);
    let diffLines = countNumstatLines(numstat);
    diffLines += await countUntrackedLines(root, untracked);
    return {
      files: [...new Set([...tracked, ...untracked])].sort(),
      deletedFiles,
      diffLines,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function collectTreeChanges(
  root: string,
  baseSha: string,
  treeHash: string,
): Promise<CollectedChanges> {
  const files = splitZero(await gitOutput(root, [
    "diff",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    baseSha,
    treeHash,
  ]));
  const deletedFiles = splitZero(await gitOutput(root, [
    "diff",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--diff-filter=D",
    "--name-only",
    "-z",
    baseSha,
    treeHash,
  ]));
  const numstat = await gitOutput(root, [
    "diff",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--numstat",
    baseSha,
    treeHash,
  ]);
  return {
    files: [...new Set(files)].sort(),
    deletedFiles,
    diffLines: countNumstatLines(numstat),
  };
}

export async function computeCandidateTree(
  root: string,
  approvedBaseSha?: string,
): Promise<CandidateTree> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cursor-bridge-index-"));
  const indexFile = path.join(temporary, "index");
  const env = gitEnvironment({ GIT_INDEX_FILE: indexFile });
  try {
    const baseSha = approvedBaseSha ?? await git(root, "rev-parse", "HEAD");
    const changes = await collectChanges(root, baseSha);
    await assertNoActiveFilters(root, changes.files);
    await runFile("git", ["-C", root, "read-tree", baseSha], { env });
    const safeFilterArgs = await neutralizedFilterArguments(root);
    if (changes.files.length > 0) {
      await runFile("git", [
        "-C",
        root,
        ...safeFilterArgs,
        "add",
        "-A",
        "--",
        ...changes.files,
      ], { env });
    }
    const treeHash = (await runFile(
      "git",
      ["-C", root, "write-tree"],
      { env },
    )).stdout.trim();
    await assertCandidateBlobsMatchWorkingFiles(root, changes.files, treeHash);
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
