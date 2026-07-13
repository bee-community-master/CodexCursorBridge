import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installCodexRegistration } from "../src/bootstrap.js";

describe("portable main Codex MCP registration", () => {
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
});
