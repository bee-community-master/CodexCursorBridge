import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installCodexRegistration, loadBootstrapConfig } from "../src/bootstrap.js";

describe("portable main Codex MCP registration", () => {
  it("initializes only a missing machine config and rejects malformed existing data", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-bootstrap-config-"));
    const configFile = path.join(directory, "config.json");

    await expect(loadBootstrapConfig(configFile, {
      id: "grok-new",
      params: [{ id: "effort", value: "high" }],
    })).resolves.toEqual({
      cursorModelId: "grok-new",
      cursorModelParams: [{ id: "effort", value: "high" }],
      repositories: {},
    });

    await writeFile(configFile, "{not-json", "utf8");
    await expect(loadBootstrapConfig(configFile, {
      id: "grok-new",
      params: [{ id: "effort", value: "high" }],
    })).rejects.toThrow();

    await writeFile(configFile, JSON.stringify({
      cursorModelId: "grok-old",
      repositories: {
        demo: { root: "/repo", origin: "owner/demo", defaultBranch: "main" },
      },
    }), "utf8");
    await expect(loadBootstrapConfig(configFile, {
      id: "grok-new",
      params: [{ id: "effort", value: "high" }],
    })).resolves.toMatchObject({
      cursorModelId: "grok-new",
      cursorModelParams: [{ id: "effort", value: "high" }],
      repositories: { demo: { root: "/repo" } },
    });
  });

  it("preserves existing config and updates absolute clone paths idempotently", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "cursor-codex-home-"));
    await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n', "utf8");

    await installCodexRegistration("/first/clone", codexHome);
    await installCodexRegistration("/second/clone", codexHome);

    const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config.match(/\[mcp_servers\.cursor_bridge\]/g)).toHaveLength(1);
    expect(config).toContain('/second/clone/dist/mcp.js');
    expect(config).not.toContain("[agents.cursor]");
  });

  it("keeps the managed Codex config and its backup owner-readable only", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "cursor-codex-home-"));
    const configFile = path.join(codexHome, "config.toml");
    await writeFile(configFile, 'model = "gpt-5.6-sol"\n', { mode: 0o644 });
    await chmod(configFile, 0o644);

    await installCodexRegistration("/clone", codexHome);

    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    const backup = (await readdir(codexHome))
      .find((name) => name.startsWith("config.toml.cursor-bridge-backup-"));
    expect(backup).toBeDefined();
    expect((await stat(path.join(codexHome, backup!))).mode & 0o777).toBe(0o600);
  });

  it("migrates and removes the obsolete CURSOR custom-agent file", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "cursor-codex-home-"));
    const agentsDir = path.join(codexHome, "agents");
    const agentFile = path.join(agentsDir, "cursor.toml");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(agentFile, "# Managed by codex-cursor-bridge bootstrap\nname = \"cursor\"\n", "utf8");
    await writeFile(
      path.join(codexHome, "config.toml"),
      "# BEGIN cursor-bridge managed CURSOR agent\n[agents.cursor]\nconfig_file = \"/tmp/cursor.toml\"\n# END cursor-bridge managed CURSOR agent\n",
      "utf8",
    );

    await installCodexRegistration("/clone", codexHome);

    await expect(access(agentFile)).rejects.toThrow();
    const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(config).not.toContain("[agents.cursor]");
    expect(config).toContain("[mcp_servers.cursor_bridge]");
  });

  it("refuses to overwrite an unmanaged MCP registration", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "cursor-codex-home-"));
    await writeFile(
      path.join(codexHome, "config.toml"),
      '[mcp_servers.cursor_bridge]\ncommand = "custom"\n',
      "utf8",
    );

    await expect(installCodexRegistration("/clone", codexHome)).rejects.toThrow(/unmanaged/);
  });

  it("does not treat an unreadable Codex config as a new installation", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "cursor-codex-home-"));
    const configFile = path.join(codexHome, "config.toml");
    await writeFile(configFile, 'model = "keep-me"\n', "utf8");
    await chmod(configFile, 0o000);

    try {
      await expect(installCodexRegistration("/clone", codexHome)).rejects.toThrow();
    } finally {
      await chmod(configFile, 0o600);
    }
    expect(await readFile(configFile, "utf8")).toContain("keep-me");
  });

  it("rejects a symlinked Codex config instead of modifying its target", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "cursor-codex-home-"));
    const target = path.join(codexHome, "outside.toml");
    const configFile = path.join(codexHome, "config.toml");
    await writeFile(target, 'model = "keep-me"\n', "utf8");
    await symlink(target, configFile);

    await expect(installCodexRegistration("/clone", codexHome))
      .rejects.toThrow(/plain|symbolic|symlink/i);
    expect(await readFile(target, "utf8")).toBe('model = "keep-me"\n');
  });

  it("atomically replaces a hard-linked Codex config without modifying its peer", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "cursor-codex-home-"));
    const target = path.join(codexHome, "shared.toml");
    const configFile = path.join(codexHome, "config.toml");
    await writeFile(target, 'model = "keep-me"\n', "utf8");
    await link(target, configFile);

    await installCodexRegistration("/clone", codexHome);

    expect(await readFile(target, "utf8")).toBe('model = "keep-me"\n');
    expect(await readFile(configFile, "utf8")).toContain("[mcp_servers.cursor_bridge]");
  });
});
