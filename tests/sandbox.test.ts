import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVerificationSandbox } from "../src/sandbox.js";

describe("verification sandbox", () => {
  it("scrubs ambient credentials, denies network, and limits writable roots", () => {
    const input = {
      worktree: "/tmp/bridge-worktree",
      scratchDir: "/tmp/bridge-scratch",
      command: "pnpm",
      args: ["verify"],
      taskEnv: {
        CI: "true",
        NODE_ENV: "test",
        HOME: "/tmp/attacker-home",
        TMPDIR: "/tmp/attacker-tmp",
        PATH: "/tmp/attacker-bin",
      },
      baseEnv: {
        PATH: [
          "",
          "relative-bin",
          "/tmp/bridge-worktree/bin",
          "/tmp/bridge-scratch/bin",
          "/opt/homebrew/bin",
          "/usr/bin",
          "/bin",
        ].join(":"),
        HOME: "/Users/private",
        GH_TOKEN: "secret",
        CURSOR_BRIDGE_API_KEY: "secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        LANG: "en_US.UTF-8",
      },
    };

    if (process.platform !== "darwin") {
      expect(() => createVerificationSandbox(input)).toThrow(/macOS/);
      return;
    }
    const invocation = createVerificationSandbox(input);

    expect(invocation.command).toBe("/usr/bin/sandbox-exec");
    expect(invocation.args[0]).toBe("-p");
    expect(invocation.args[1]).toContain("(deny network*)");
    expect(invocation.args[1]).toContain("com.apple.securityd");
    expect(invocation.args[1]).toContain(path.resolve("/tmp/bridge-worktree"));
    expect(invocation.args[1]).not.toContain("/Users/private");
    expect(invocation.args[1]).not.toMatch(/\(subpath "\/tmp"\)/);
    expect(invocation.env).toMatchObject({
      HOME: path.resolve("/tmp/bridge-scratch/home"),
      TMPDIR: path.resolve("/tmp/bridge-scratch/tmp"),
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      CI: "true",
      NODE_ENV: "test",
    });
    expect(invocation.env).not.toHaveProperty("GH_TOKEN");
    expect(invocation.env).not.toHaveProperty("CURSOR_BRIDGE_API_KEY");
    expect(invocation.env).not.toHaveProperty("SSH_AUTH_SOCK");
  });

  it("binds Corepack to the verifier-owned scratch cache", () => {
    if (process.platform !== "darwin") return;
    const invocation = createVerificationSandbox({
      worktree: "/tmp/bridge-worktree",
      scratchDir: "/tmp/bridge-scratch",
      command: "pnpm",
      args: ["test"],
      taskEnv: { COREPACK_HOME: "/tmp/attacker-cache" },
      corepackHome: "/tmp/bridge-scratch/corepack",
    });

    expect(invocation.env.COREPACK_HOME).toBe("/tmp/bridge-scratch/corepack");
    expect(invocation.env.COREPACK_ENABLE_PROJECT_SPEC).toBe("1");
    expect(invocation.env.COREPACK_DEFAULT_TO_LATEST).toBe("0");
  });

  it("removes a PATH entry located in the writable worktree even when it resolves outside", async () => {
    if (process.platform !== "darwin") return;
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-sandbox-path-"));
    const worktree = path.join(directory, "worktree");
    const scratchDir = path.join(directory, "scratch");
    await mkdir(worktree);
    await mkdir(scratchDir);
    const linkedBin = path.join(worktree, "bin");
    await symlink("/usr/bin", linkedBin);

    const invocation = createVerificationSandbox({
      worktree,
      scratchDir,
      command: "node",
      args: [],
      baseEnv: { PATH: `${linkedBin}:/usr/bin` },
    });

    expect(invocation.env.PATH).toBe("/usr/bin");
  });

  it("fails closed when a sandbox root cannot be canonicalized", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-sandbox-loop-"));
    const worktree = path.join(directory, "worktree");
    await symlink("worktree", worktree);

    let failure: unknown;
    try {
      createVerificationSandbox({
        worktree,
        scratchDir: path.join(directory, "scratch"),
        command: "node",
        args: [],
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "ELOOP" });
  });
});
