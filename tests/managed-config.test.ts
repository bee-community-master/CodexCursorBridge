import { describe, expect, it } from "vitest";
import { removeManagedAgentBlock, upsertManagedAgentBlock } from "../src/managed-config.js";

describe("managed Codex config", () => {
  it("adds and updates only the CURSOR role block", () => {
    const original = 'model = "gpt-5.6-sol"\n\n[agents]\nmax_threads = 6\n';
    const once = upsertManagedAgentBlock(original, "/Users/me/.codex/agents/cursor.toml");
    const twice = upsertManagedAgentBlock(once, "/Users/new/.codex/agents/cursor.toml");
    expect(twice).toContain('config_file = "/Users/new/.codex/agents/cursor.toml"');
    expect(twice.match(/BEGIN cursor-bridge/g)).toHaveLength(1);
    expect(removeManagedAgentBlock(twice)).toBe(original);
  });

  it("is idempotent for absent blocks and rejects malformed managed blocks", () => {
    expect(removeManagedAgentBlock("model = \"x\"\n")).toBe("model = \"x\"\n");
    expect(() => removeManagedAgentBlock("# BEGIN cursor-bridge managed CURSOR agent\n")).toThrow(/Malformed/);
    expect(upsertManagedAgentBlock("", "/tmp/cursor.toml")).toMatch(/^# BEGIN/);
  });
});
