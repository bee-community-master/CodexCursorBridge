import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    ensureCursorApiKey: vi.fn(),
    modelsList: vi.fn(),
    runFile: vi.fn(),
    loadBootstrapConfig: vi.fn(),
    loadMachineConfig: vi.fn(),
    saveMachineConfig: vi.fn(),
    runtimePaths: vi.fn(),
    installCodexRegistration: vi.fn(),
    installPlugin: vi.fn(),
    installSupervisor: vi.fn(),
    removeManagedRegistrationBlocks: vi.fn(),
    upsertManagedMcpBlock: vi.fn(),
    deleteCursorApiKey: vi.fn(),
    readCursorApiKey: vi.fn(),
    storeCursorApiKey: vi.fn(),
  };
});

vi.mock("@cursor/sdk", () => ({
  Cursor: { models: { list: mocks.modelsList } },
}));

vi.mock("node:readline/promises", () => ({
  createInterface: (): { question: () => Promise<string>; close: () => void } => ({
    question: async (): Promise<string> => "1",
    close: vi.fn(),
  }),
}));

vi.mock("../src/git.js", () => ({ runFile: mocks.runFile }));
vi.mock("../src/keychain.js", () => ({
  deleteCursorApiKey: mocks.deleteCursorApiKey,
  ensureCursorApiKey: mocks.ensureCursorApiKey,
  readCursorApiKey: mocks.readCursorApiKey,
  storeCursorApiKey: mocks.storeCursorApiKey,
}));
vi.mock("../src/config.js", () => ({
  emptyMachineConfig: vi.fn(),
  loadMachineConfig: mocks.loadMachineConfig,
  runtimePaths: mocks.runtimePaths,
  saveMachineConfig: mocks.saveMachineConfig,
}));
vi.mock("../src/launchd.js", () => ({
  installSupervisor: mocks.installSupervisor,
  uninstallSupervisor: vi.fn(),
}));
vi.mock("../src/managed-config.js", () => ({
  removeManagedRegistrationBlocks: mocks.removeManagedRegistrationBlocks,
  upsertManagedMcpBlock: mocks.upsertManagedMcpBlock,
}));

const { bootstrap } = await import("../src/bootstrap.js");

describe("bootstrap validation ordering", () => {
  const platform = vi.spyOn(process, "platform", "get");
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(async () => {
    platform.mockReturnValue("darwin");
    process.env.CODEX_HOME = await mkdtemp(path.join(tmpdir(), "cursor-bootstrap-ordering-"));
    mocks.events.length = 0;
    mocks.ensureCursorApiKey.mockReset().mockImplementation(async () => {
      mocks.events.push("credential");
      return "cursor-secret";
    });
    mocks.modelsList.mockReset().mockImplementation(async () => {
      mocks.events.push("model");
      return [{
        id: "grok-4.5",
        displayName: "Grok 4.5",
        variants: [{ params: [
          { id: "effort", value: "high" },
          { id: "fast", value: "false" },
        ] }],
      }];
    });
    mocks.runFile.mockReset().mockImplementation(async (_command: string, args: readonly string[]) => {
      const invocation = args.join(" ");
      if (invocation === "plugin marketplace list --json") {
        return { stdout: JSON.stringify({ marketplaces: [] }), stderr: "" };
      }
      if (invocation === "plugin list --json") {
        return { stdout: JSON.stringify({ installed: [] }), stderr: "" };
      }
      if (invocation === "build") {
        mocks.events.push("build");
      }
      if (invocation === "plugin add cursor-bridge@coding-agent") {
        mocks.events.push("plugin");
      }
      return { stdout: "", stderr: "" };
    });
    mocks.runtimePaths.mockReset().mockReturnValue({ configFile: "/tmp/config.json", home: "/tmp/bridge" });
    mocks.loadMachineConfig.mockReset().mockResolvedValue({ repositories: {} });
    mocks.loadBootstrapConfig.mockReset().mockResolvedValue({
      cursorModelId: "grok-4.5",
      cursorModelParams: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
      repositories: {},
    });
    mocks.saveMachineConfig.mockReset().mockImplementation(async () => { mocks.events.push("config"); });
    mocks.installCodexRegistration.mockReset().mockImplementation(async () => { mocks.events.push("codex"); });
    mocks.installPlugin.mockReset().mockImplementation(async () => { mocks.events.push("plugin"); });
    mocks.installSupervisor.mockReset().mockImplementation(async () => { mocks.events.push("launchd"); });
    mocks.removeManagedRegistrationBlocks.mockReset().mockReturnValue("");
    mocks.upsertManagedMcpBlock.mockReset().mockImplementation(() => {
      mocks.events.push("codex");
      return "[mcp_servers.cursor_bridge]\n";
    });
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    vi.restoreAllMocks();
  });

  it("validates the credential and live model before mutating config, plugin, or launchd", async () => {
    await bootstrap("/bridge");

    expect(mocks.events).toEqual(["build", "credential", "model", "config", "codex", "plugin", "launchd"]);
  });

  it("stops before all persistent registration changes when model validation fails", async () => {
    mocks.modelsList.mockReset().mockRejectedValue(new Error("model lookup failed"));

    await expect(bootstrap("/bridge")).rejects.toThrow(/model lookup failed/);
    expect(mocks.events).toEqual(["build", "credential"]);
    expect(mocks.saveMachineConfig).not.toHaveBeenCalled();
    expect(mocks.installPlugin).not.toHaveBeenCalled();
    expect(mocks.installSupervisor).not.toHaveBeenCalled();
  });
});
