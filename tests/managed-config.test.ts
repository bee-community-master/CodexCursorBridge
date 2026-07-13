import { describe, expect, it } from "vitest";
import {
  removeManagedRegistrationBlocks,
  upsertManagedMcpBlock,
} from "../src/managed-config.js";

describe("managed Codex config", () => {
  it("adds and updates only the main Cursor Bridge MCP block", () => {
    const original = 'model = "gpt-5.6-sol"\n\n[agents]\nmax_threads = 6\n';
    const once = upsertManagedMcpBlock(original, "/first/clone");
    const twice = upsertManagedMcpBlock(once, "/second/clone");

    expect(twice).toContain("[mcp_servers.cursor_bridge]");
    expect(twice).toContain('args = ["/second/clone/dist/mcp.js"]');
    expect(twice).toContain('cwd = "/second/clone"');
    expect(twice).toContain('CURSOR_BRIDGE_ROOT = "/second/clone"');
    expect(twice).toContain('enabled_tools = ["cursor_start_task", "cursor_get_task", "cursor_cancel_task", "cursor_get_report"]');
    expect(twice.match(/BEGIN cursor-bridge managed main MCP/g)).toHaveLength(1);
    expect(removeManagedRegistrationBlocks(twice)).toBe(original);
  });

  it("removes the legacy CURSOR role block during migration", () => {
    const legacy = [
      'model = "x"',
      "",
      "# BEGIN cursor-bridge managed CURSOR agent",
      "[agents.cursor]",
      'config_file = "/tmp/cursor.toml"',
      "# END cursor-bridge managed CURSOR agent",
      "",
    ].join("\n");

    expect(removeManagedRegistrationBlocks(legacy)).toBe('model = "x"\n');
  });

  it("is idempotent for absent blocks and rejects malformed managed blocks", () => {
    expect(removeManagedRegistrationBlocks('model = "x"\n')).toBe('model = "x"\n');
    expect(() => removeManagedRegistrationBlocks("# BEGIN cursor-bridge managed main MCP\n")).toThrow(/Malformed/);
    expect(upsertManagedMcpBlock("", "/tmp/bridge")).toMatch(/^# BEGIN/);
  });
});
