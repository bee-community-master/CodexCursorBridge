import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  runFile: mocks.runFile,
}));

const { installPlugin, uninstallPlugin } = await import("../src/bootstrap.js");

afterEach(() => {
  mocks.runFile.mockReset();
});

describe("Codex plugin bootstrap", () => {
  it("recognizes the exact JSON marketplace root and reinstalls without adding a duplicate source", async () => {
    const projectRoot = "/Users/test/CodexCursorBridge";
    mocks.runFile.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args.join(" ") === "plugin marketplace list --json") {
        return {
          stdout: JSON.stringify({
            marketplaces: [{ name: "coding-agent", root: projectRoot }],
          }),
          stderr: "",
        };
      }
      if (args.join(" ") === "plugin list --json") {
        return {
          stdout: JSON.stringify({
            installed: [{ pluginId: "cursor-bridge@coding-agent" }],
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    await installPlugin(projectRoot);

    expect(mocks.runFile).toHaveBeenCalledWith(
      "codex",
      ["plugin", "remove", "cursor-bridge@coding-agent"],
    );
    expect(mocks.runFile).toHaveBeenCalledWith(
      "codex",
      ["plugin", "add", "cursor-bridge@coding-agent"],
    );
    expect(mocks.runFile).not.toHaveBeenCalledWith(
      "codex",
      ["plugin", "marketplace", "add", projectRoot],
    );
  });

  it("removes a conflicting marketplace only after checking the exact installed plugin id", async () => {
    const projectRoot = "/Users/test/CodexCursorBridge";
    mocks.runFile.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args.join(" ") === "plugin marketplace list --json") {
        return {
          stdout: JSON.stringify({
            marketplaces: [{ name: "coding-agent", root: "/old/clone" }],
          }),
          stderr: "",
        };
      }
      if (args.join(" ") === "plugin list --json") {
        return {
          stdout: JSON.stringify({
            installed: [{ pluginId: "cursor-bridge@coding-agent" }],
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    await installPlugin(projectRoot);

    expect(mocks.runFile.mock.calls).toEqual(expect.arrayContaining([
      ["codex", ["plugin", "remove", "cursor-bridge@coding-agent"]],
      ["codex", ["plugin", "marketplace", "remove", "coding-agent"]],
      ["codex", ["plugin", "marketplace", "add", projectRoot]],
      ["codex", ["plugin", "add", "cursor-bridge@coding-agent"]],
    ]));
  });

  it("propagates plugin removal failures instead of reporting a false uninstall", async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args.join(" ") === "plugin list --json") {
        return {
          stdout: JSON.stringify({
            installed: [{ pluginId: "cursor-bridge@coding-agent" }],
          }),
          stderr: "",
        };
      }
      if (args.join(" ") === "plugin marketplace list --json") {
        return {
          stdout: JSON.stringify({
            marketplaces: [{ name: "coding-agent", root: "/clone" }],
          }),
          stderr: "",
        };
      }
      if (args.join(" ") === "plugin remove cursor-bridge@coding-agent") {
        throw new Error("plugin config is unreadable");
      }
      return { stdout: "", stderr: "" };
    });

    await expect(uninstallPlugin()).rejects.toThrow(/unreadable/);
    expect(mocks.runFile).not.toHaveBeenCalledWith(
      "codex",
      ["plugin", "marketplace", "remove", "coding-agent"],
    );
  });
});
