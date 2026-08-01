import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../src/git.js", () => ({ runFile: mocks.runFile }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

const { inspectCursorApiKey, storeCursorApiKey } = await import("../src/keychain.js");

function successfulChild(): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

describe("macOS Keychain bootstrap integration", () => {
  const platform = vi.spyOn(process, "platform", "get");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, get: () => true });
  const isTTY = vi.spyOn(process.stdin, "isTTY", "get");

  beforeEach(() => {
    platform.mockReturnValue("darwin");
    isTTY.mockReturnValue(true);
    mocks.runFile.mockReset();
    mocks.spawn.mockReset().mockImplementation(() => successfulChild());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses an existing non-empty item without invoking the store", async () => {
    isTTY.mockReturnValue(false);
    mocks.runFile.mockResolvedValue({ stdout: "existing-secret\n", stderr: "" });

    await expect(storeCursorApiKey()).resolves.toBeUndefined();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.runFile).toHaveBeenCalledTimes(1);
  });

  it("stores a missing item without an update flag or secret argument", async () => {
    const missing = Object.assign(new Error("item missing"), { code: 44 });
    mocks.runFile.mockRejectedValue(missing);

    await expect(storeCursorApiKey()).resolves.toBeUndefined();
    const [command, args, options] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; stdio: string },
    ];
    expect(command).toBe(process.execPath);
    expect(options.stdio).toBe("inherit");
    expect(options.env.CURSOR_BRIDGE_CHILD_COMMAND).toBe("/usr/bin/security");
    expect(JSON.parse(options.env.CURSOR_BRIDGE_CHILD_ARGS ?? "[]")).toEqual([
      "add-generic-password", "-s", "codex-cursor-bridge", "-a", "cursor-api-key", "-w",
    ]);
    expect(options.env.CURSOR_BRIDGE_CHILD_LOCK_DATABASE).toMatch(/\.security-child\.sqlite$/);
    expect(args).not.toContain("-U");
    expect(args).not.toContain("existing-secret");
  });

  it("removes only a confirmed empty item before prompting for a replacement", async () => {
    const calls: string[] = [];
    mocks.runFile.mockImplementation(async (_command: string, args: readonly string[]) => {
      calls.push(args[0] ?? "");
      if (args[0] === "find-generic-password") return { stdout: "\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    await expect(storeCursorApiKey()).resolves.toBeUndefined();
    expect(calls).toEqual(["find-generic-password", "delete-generic-password"]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("classifies an empty item without exposing a credential", async () => {
    mocks.runFile.mockResolvedValue({ stdout: "\n", stderr: "" });

    await expect(inspectCursorApiKey()).resolves.toEqual({ kind: "empty" });
  });
});
