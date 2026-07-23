import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertRelativeRepoPath } from "./paths.js";

const exec = promisify(execFile);

export interface CommandResult { stdout: string; stderr: string }

const unsafeInheritedGitEnvironment = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_ATTR_SOURCE",
  "GIT_REPLACE_REF_BASE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
]);

function gitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      unsafeInheritedGitEnvironment.has(key)
      || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
      || /^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)$/.test(key)
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    ...overrides,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export interface WorktreeIdentity {
  gitFileContent: string;
  gitDir: string;
  commonGitDir: string;
  configDigest: string;
}

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

async function gitOutput(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<string> {
  return (await runFile("git", [
    "-C",
    cwd,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    ...args,
  ], {
    env: gitEnvironment(environment),
  })).stdout;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitOutput(cwd, args)).trim();
}

export async function assertGitHubRemote(root: string, expectedOrigin: string): Promise<void> {
  const fetchUrls = (await git(root, "remote", "get-url", "--all", "origin"))
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    fetchUrls.length !== 1
    || fetchUrls.some((url) => {
      try {
        return githubOriginSlug(url) !== expectedOrigin;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("Git fetch remote does not match the registered repository");
  }
  const pushUrls = (await git(
    root,
    "remote",
    "get-url",
    "--push",
    "--all",
    "origin",
  )).split(/\r?\n/).filter(Boolean);
  if (
    pushUrls.length !== 1
    || pushUrls.some((url) => {
      try {
        return githubOriginSlug(url) !== expectedOrigin;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("Git push remote does not match the registered repository");
  }
}

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

function splitZero(value: string): string[] {
  return value.split("\0").filter(Boolean).map(assertRelativeRepoPath);
}

async function countUntrackedLines(root: string, files: readonly string[]): Promise<number> {
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

export interface CollectedChanges {
  files: string[];
  deletedFiles: string[];
  diffLines: number;
}

export interface CandidateTree {
  treeHash: string;
  patchHash: string;
}

function countNumstatLines(numstat: string): number {
  return numstat.split("\n").filter(Boolean).reduce((total, line) => {
    const [added = "0", deleted = "0"] = line.split("\t");
    return total + (added === "-" ? 0 : Number(added)) + (deleted === "-" ? 0 : Number(deleted));
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

async function assertNoActiveFilters(root: string, files: readonly string[]): Promise<void> {
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

export async function collectChanges(root: string, baseSha: string): Promise<CollectedChanges> {
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
    return { files: [...new Set([...tracked, ...untracked])].sort(), deletedFiles, diffLines };
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

export async function computeCandidateTree(root: string, approvedBaseSha?: string): Promise<CandidateTree> {
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
    const treeHash = (await runFile("git", ["-C", root, "write-tree"], { env })).stdout.trim();
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

export function githubOriginSlug(originUrl: string): string {
  const scp = originUrl.match(/^git@github\.com:([^?#]+)$/i);
  let repositoryPath: string;
  if (scp?.[1]) {
    repositoryPath = scp[1];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(originUrl);
    } catch {
      throw new Error("Origin is not a GitHub repository");
    }
    if (
      parsed.hostname.toLowerCase() !== "github.com"
      || !["https:", "ssh:"].includes(parsed.protocol)
      || parsed.search
      || parsed.hash
    ) {
      throw new Error("Origin is not a GitHub repository");
    }
    if (
      parsed.password
      || (parsed.protocol === "https:" && parsed.username)
      || (parsed.protocol === "ssh:" && parsed.username !== "git")
    ) {
      throw new Error("GitHub remote URLs may not contain embedded credentials");
    }
    repositoryPath = parsed.pathname;
  }
  const normalized = repositoryPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  const parts = normalized.split("/");
  if (
    parts.length !== 2
    || parts.some((part) => !part || part === "." || part === ".." || /\s/.test(part))
  ) {
    throw new Error("Origin is not a GitHub repository");
  }
  return normalized;
}
