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
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
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
});
