import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import type { WorktreeIdentity } from "../application/workflow-ports.js";
import { git } from "./git-runtime.js";

function gitDirFromPointer(worktree: string, content: string): string {
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(content);
  if (!match?.[1]) throw new Error("Worktree Git metadata pointer is malformed");
  return path.resolve(worktree, match[1]);
}

async function readPlainGitPointer(worktree: string): Promise<string> {
  const gitFile = path.join(worktree, ".git");
  const metadata = await lstat(gitFile);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Worktree Git metadata must be a plain pointer file");
  }
  return readFile(gitFile, "utf8");
}

async function readPlainMetadataPointer(file: string): Promise<string> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Worktree Git metadata must use plain pointer files");
  }
  const content = await readFile(file, "utf8");
  const match = /^([^\r\n]+)\r?\n?$/.exec(content);
  if (!match?.[1]) throw new Error("Worktree Git metadata pointer is malformed");
  return match[1];
}

async function assertWorktreeMetadataLinks(
  worktree: string,
  gitDir: string,
  commonGitDir: string,
): Promise<void> {
  const gitFile = await realpath(path.join(worktree, ".git"));
  const backPointer = await realpath(path.resolve(
    gitDir,
    await readPlainMetadataPointer(path.join(gitDir, "gitdir")),
  ));
  if (backPointer !== gitFile) {
    throw new Error("Worktree Git metadata does not point back to the prepared worktree");
  }

  const resolvedCommonGitDir = await realpath(path.resolve(
    gitDir,
    await readPlainMetadataPointer(path.join(gitDir, "commondir")),
  ));
  if (resolvedCommonGitDir !== commonGitDir) {
    throw new Error("Worktree Git metadata common directory changed after preparation");
  }
}

async function worktreeIdentityDigest(
  worktree: string,
  gitFileContent: string,
  gitDir: string,
  commonGitDir: string,
): Promise<string> {
  const hash = createHash("sha256");
  for (const [label, value] of [
    ["git-file", gitFileContent],
    ["git-dir", gitDir],
    ["common-git-dir", commonGitDir],
  ] as const) {
    hash.update(label).update("\0").update(value).update("\0");
  }
  for (const [label, file] of [
    ["common", path.join(commonGitDir, "config")],
    ["worktree", path.join(gitDir, "config.worktree")],
  ] as const) {
    hash.update(label).update("\0");
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Worktree Git configuration must use plain files");
      }
      hash.update(await readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  const effectiveConfig = await git(
    worktree,
    "config",
    "--null",
    "--show-origin",
    "--show-scope",
    "--list",
  );
  hash.update("effective").update("\0").update(effectiveConfig).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

export async function captureWorktreeIdentity(
  worktree: string,
  repositoryRoot: string,
): Promise<WorktreeIdentity> {
  const gitFileContent = await readPlainGitPointer(worktree);
  const gitDir = await realpath(gitDirFromPointer(worktree, gitFileContent));
  const commonGitDir = await realpath(await git(
    repositoryRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ));
  const worktreeMetadataRoot = path.join(commonGitDir, "worktrees");
  const relative = path.relative(worktreeMetadataRoot, gitDir);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Worktree Git metadata is not owned by the registered repository");
  }
  await assertWorktreeMetadataLinks(worktree, gitDir, commonGitDir);
  const configDigest = await worktreeIdentityDigest(
    worktree,
    gitFileContent,
    gitDir,
    commonGitDir,
  );
  return { gitFileContent, gitDir, commonGitDir, configDigest };
}

export async function assertWorktreeIdentity(
  worktree: string,
  identity: WorktreeIdentity,
): Promise<void> {
  try {
    const gitFileContent = await readPlainGitPointer(worktree);
    if (gitFileContent !== identity.gitFileContent) {
      throw new Error("Worktree Git metadata pointer changed after preparation");
    }
    const gitDir = await realpath(gitDirFromPointer(worktree, gitFileContent));
    if (gitDir !== identity.gitDir) {
      throw new Error("Worktree Git metadata identity changed after preparation");
    }
    await assertWorktreeMetadataLinks(worktree, gitDir, identity.commonGitDir);
    if (
      await worktreeIdentityDigest(
        worktree,
        gitFileContent,
        gitDir,
        identity.commonGitDir,
      )
      !== identity.configDigest
    ) {
      throw new Error("Worktree Git configuration changed after preparation");
    }
  } catch (error) {
    if (error instanceof Error && /Worktree Git metadata/.test(error.message)) throw error;
    throw new Error("Worktree Git metadata identity could not be verified");
  }
}
