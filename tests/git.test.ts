import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertGitHubRemote,
  assertWorktreeIdentity,
  captureWorktreeIdentity,
  collectChanges,
  collectTreeChanges,
  computeCandidateTree,
  git,
  githubOriginSlug,
} from "../src/git.js";

const exec = promisify(execFile);

describe("Git change collection", () => {
  it("disables interactive terminal prompts for durable Git commands", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-git-env-"));
    const fakeGit = path.join(directory, "git");
    await writeFile(fakeGit, "#!/bin/sh\nprintf '%s' \"$GIT_TERMINAL_PROMPT\"\n", "utf8");
    await chmod(fakeGit, 0o700);
    const previousPath = process.env.PATH;
    const previousPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.PATH = directory;
    process.env.GIT_TERMINAL_PROMPT = "1";

    try {
      await expect(git(directory, "status")).resolves.toBe("0");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = previousPrompt;
    }
  });

  it("accepts only exact GitHub remotes without embedded credentials", () => {
    expect(githubOriginSlug("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(githubOriginSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(githubOriginSlug("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
    expect(() => githubOriginSlug("https://evilgithub.com/owner/repo.git"))
      .toThrow(/GitHub repository/i);
    expect(() => githubOriginSlug("git@notgithub.com:owner/repo.git"))
      .toThrow(/GitHub repository/i);
    expect(() => githubOriginSlug("https://user:token@github.com/owner/repo.git"))
      .toThrow(/credentials/i);
  });

  it("rejects additional fetch or push URLs on the registered remote", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-remote-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "git@github.com:owner/repo.git",
    ]);
    await expect(assertGitHubRemote(root, "owner/repo")).resolves.toBeUndefined();

    await exec("git", [
      "-C",
      root,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "git@github.com:owner/repo.git",
    ]);
    await exec("git", [
      "-C",
      root,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "git@github.com:attacker/repo.git",
    ]);
    await expect(assertGitHubRemote(root, "owner/repo"))
      .rejects.toThrow(/push remote/i);

    await exec("git", ["-C", root, "config", "--unset-all", "remote.origin.pushurl"]);
    await exec("git", [
      "-C",
      root,
      "remote",
      "set-url",
      "--add",
      "origin",
      "git@github.com:attacker/repo.git",
    ]);
    await expect(assertGitHubRemote(root, "owner/repo"))
      .rejects.toThrow(/fetch remote/i);
  }, 15_000);

  it("includes tracked edits, deletions, and untracked files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "a.ts"), "one\n", "utf8");
    await writeFile(path.join(root, "gone.test.ts"), "test\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    await writeFile(path.join(root, "a.ts"), "one\ntwo\n", "utf8");
    await exec("git", ["-C", root, "rm", "-q", "gone.test.ts"]);
    await writeFile(path.join(root, "new.ts"), "new\n", "utf8");

    const changes = await collectChanges(root, base.trim());
    expect(changes.files.sort()).toEqual(["a.ts", "gone.test.ts", "new.ts"]);
    expect(changes.deletedFiles).toEqual(["gone.test.ts"]);
    expect(changes.diffLines).toBeGreaterThanOrEqual(3);

    const candidate = await computeCandidateTree(root);
    expect(candidate.treeHash).toMatch(/^[a-f0-9]{40,64}$/);
    expect(candidate.patchHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await git(root, "status", "--porcelain")).toContain("?? new.ts");
  }, 15_000);

  it("counts an untracked symbolic link without reading its target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "base.ts"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    await symlink("../secret-that-does-not-exist", path.join(root, "link.ts"));

    const changes = await collectChanges(root, base.trim());

    expect(changes.files).toEqual(["link.ts"]);
    expect(changes.diffLines).toBe(1);
  }, 15_000);

  it("counts each line in an untracked text file exactly once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "base.ts"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    await writeFile(path.join(root, "new.ts"), "one\ntwo\nthree\n", "utf8");

    const changes = await collectChanges(root, base.trim());

    expect(changes.diffLines).toBe(3);
  }, 15_000);

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "does not let index flag %s hide a tracked worktree change",
    async (flag) => {
      const root = await mkdtemp(path.join(tmpdir(), "cursor-git-index-"));
      await exec("git", ["init", "-q", root]);
      await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
      await exec("git", ["-C", root, "config", "user.name", "Test"]);
      await writeFile(path.join(root, "tracked.ts"), "base\n", "utf8");
      await exec("git", ["-C", root, "add", "."]);
      await exec("git", ["-C", root, "commit", "-qm", "base"]);
      const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
      await exec("git", ["-C", root, "update-index", flag, "tracked.ts"]);
      await writeFile(path.join(root, "tracked.ts"), "hidden candidate\n", "utf8");

      const changes = await collectChanges(root, base.trim());
      const candidate = await computeCandidateTree(root, base.trim());
      const snapshot = await collectTreeChanges(root, base.trim(), candidate.treeHash);

      expect(changes.files).toEqual(["tracked.ts"]);
      expect(snapshot.files).toEqual(["tracked.ts"]);
      expect(await git(root, "show", `${candidate.treeHash}:tracked.ts`))
        .toBe("hidden candidate");
    },
    15_000,
  );

  it("assesses the immutable candidate tree rather than later worktree mutations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "base.ts"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    await writeFile(path.join(root, "candidate.ts"), "candidate\n", "utf8");
    const candidate = await computeCandidateTree(root, base.trim());

    await writeFile(path.join(root, "candidate.ts"), "mutated\nafter\nsnapshot\n", "utf8");
    const snapshot = await collectTreeChanges(root, base.trim(), candidate.treeHash);

    expect(snapshot.files).toEqual(["candidate.ts"]);
    expect(snapshot.diffLines).toBe(1);
  }, 15_000);

  it("seeds a resumed candidate from the approved base instead of a prior Bridge commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-resume-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "base.ts"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);

    await writeFile(path.join(root, "base.ts"), "prior candidate\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "bridge candidate"]);
    await writeFile(path.join(root, "base.ts"), "base\n", "utf8");
    await writeFile(path.join(root, "new.ts"), "current candidate\n", "utf8");

    const candidate = await computeCandidateTree(root, base.trim());
    const changes = await collectTreeChanges(root, base.trim(), candidate.treeHash);

    expect(changes.files).toEqual(["new.ts"]);
    expect(await git(root, "show", `${candidate.treeHash}:base.ts`)).toBe("base");
  }, 15_000);

  it("treats a rename as a deletion and addition for scope enforcement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-rename-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "service.test.ts"), "test\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    await exec("git", ["-C", root, "mv", "service.test.ts", "service.ts"]);

    const changes = await collectChanges(root, base.trim());

    expect(changes.files).toEqual(["service.test.ts", "service.ts"]);
    expect(changes.deletedFiles).toEqual(["service.test.ts"]);
  }, 15_000);

  it("fails closed before a repository clean filter can change the attested candidate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-filter-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, ".gitattributes"), "*.txt filter=evil\n", "utf8");
    await writeFile(path.join(root, "candidate.txt"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    await exec("git", [
      "-C",
      root,
      "config",
      "filter.evil.clean",
      "sed s/safe/unsafe/g",
    ]);
    await writeFile(path.join(root, "candidate.txt"), "safe\n", "utf8");

    await expect(computeCandidateTree(root, base.trim()))
      .rejects.toThrow(/filter/i);
  }, 15_000);

  it("rejects built-in Git attribute transforms that change verified file bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-transform-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, ".gitattributes"), "*.txt text eol=lf\n", "utf8");
    await writeFile(path.join(root, "message.txt"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    await writeFile(path.join(root, "message.txt"), "changed\r\n", "utf8");

    await expect(computeCandidateTree(root, base.trim()))
      .rejects.toThrow(/transform|candidate blob/i);
  }, 15_000);

  it("treats changed filenames as literal paths when creating the candidate tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-pathspec-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "base.ts"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    const pathspecShapedFile = ":(exclude)**";
    await writeFile(path.join(root, pathspecShapedFile), "candidate\n", "utf8");

    const candidate = await computeCandidateTree(root, base.trim());
    const changes = await collectTreeChanges(root, base.trim(), candidate.treeHash);

    expect(changes.files).toEqual([pathspecShapedFile]);
  }, 15_000);

  it("preserves leading and trailing spaces in NUL-delimited Git paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-git-whitespace-"));
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "base.ts"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout: base } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    const whitespaceFile = " leading-and-trailing.ts ";
    await writeFile(path.join(root, whitespaceFile), "candidate\n", "utf8");

    const changes = await collectChanges(root, base.trim());
    const candidate = await computeCandidateTree(root, base.trim());
    const snapshot = await collectTreeChanges(root, base.trim(), candidate.treeHash);

    expect(changes.files).toEqual([whitespaceFile]);
    expect(snapshot.files).toEqual([whitespaceFile]);
  }, 15_000);

  it("pins a linked worktree to the registered repository Git metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-git-identity-"));
    const root = path.join(directory, "main");
    const worktree = path.join(directory, "linked");
    const otherWorktree = path.join(directory, "other");
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "base.ts"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    await exec("git", ["-C", root, "worktree", "add", "-qb", "feature", worktree]);
    await exec("git", ["-C", root, "worktree", "add", "-qb", "other", otherWorktree]);
    const identity = await captureWorktreeIdentity(worktree, root);
    const otherIdentity = await captureWorktreeIdentity(otherWorktree, root);

    await expect(assertWorktreeIdentity(worktree, identity)).resolves.toBeUndefined();
    expect(identity.configDigest).not.toBe(otherIdentity.configDigest);

    const commonConfigFile = path.join(identity.commonGitDir, "config");
    const commonConfig = await readFile(commonConfigFile, "utf8");
    await writeFile(
      commonConfigFile,
      `${commonConfig}\n[credential]\n\thelper = !attacker\n`,
      "utf8",
    );
    await expect(assertWorktreeIdentity(worktree, identity))
      .rejects.toThrow(/configuration|metadata|identity/i);
    await writeFile(commonConfigFile, commonConfig, "utf8");

    const backPointerFile = path.join(identity.gitDir, "gitdir");
    const backPointer = await readFile(backPointerFile, "utf8");
    await writeFile(backPointerFile, `${path.join(otherWorktree, ".git")}\n`, "utf8");
    await expect(assertWorktreeIdentity(worktree, identity))
      .rejects.toThrow(/metadata|identity/i);
    await writeFile(backPointerFile, backPointer, "utf8");

    const commonDirFile = path.join(identity.gitDir, "commondir");
    const commonDirPointer = await readFile(commonDirFile, "utf8");
    await writeFile(commonDirFile, "../other\n", "utf8");
    await expect(assertWorktreeIdentity(worktree, identity))
      .rejects.toThrow(/metadata|identity/i);
    await writeFile(commonDirFile, commonDirPointer, "utf8");

    await writeFile(
      path.join(worktree, ".git"),
      await readFile(path.join(otherWorktree, ".git"), "utf8"),
      "utf8",
    );
    await expect(captureWorktreeIdentity(worktree, root))
      .rejects.toThrow(/metadata|identity|owned/i);

    await writeFile(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(directory, "attacker.git")}\n`,
      "utf8",
    );
    await expect(assertWorktreeIdentity(worktree, identity))
      .rejects.toThrow(/metadata|identity/i);
  }, 15_000);

  it("detects changes in an included Git configuration file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-git-config-include-"));
    const root = path.join(directory, "main");
    const worktree = path.join(directory, "linked");
    const includedConfig = path.join(directory, "included.config");
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "base.ts"), "base\n", "utf8");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    await writeFile(includedConfig, "[credential]\n\thelper = first\n", "utf8");
    await exec("git", ["-C", root, "config", "include.path", includedConfig]);
    await exec("git", ["-C", root, "worktree", "add", "-qb", "feature", worktree]);
    const identity = await captureWorktreeIdentity(worktree, root);

    await writeFile(includedConfig, "[credential]\n\thelper = second\n", "utf8");

    await expect(assertWorktreeIdentity(worktree, identity))
      .rejects.toThrow(/configuration|metadata|identity/i);
  }, 15_000);
});
