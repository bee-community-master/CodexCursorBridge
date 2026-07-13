import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installCodexRegistration, renderCursorAgentConfig } from "../src/bootstrap.js";

describe("portable CURSOR role", () => {
  it("pins Luna medium and exposes only four Cursor Bridge tools", () => {
    const config = renderCursorAgentConfig("/clone/codingAgent");
    expect(config).toContain('model = "gpt-5.6-luna"');
    expect(config).toContain('model_reasoning_effort = "medium"');
    expect(config).toContain('sandbox_mode = "read-only"');
    expect(config).toContain('"cursor_start_task"');
    expect(config).toContain('"cursor_get_task"');
    expect(config).toContain('"cursor_cancel_task"');
    expect(config).toContain('"cursor_get_report"');
    expect(config).not.toContain("CURSOR_API_KEY");
  });

  it("preserves existing Codex config and is idempotent across clone paths", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "cursor-codex-home-"));
    await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n', "utf8");
    await installCodexRegistration("/first/clone", codexHome);
    await installCodexRegistration("/second/clone", codexHome);
    const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
    const agent = await readFile(path.join(codexHome, "agents", "cursor.toml"), "utf8");
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config.match(/\[agents\.cursor\]/g)).toHaveLength(1);
    expect(agent).toContain("/second/clone/dist/mcp.js");
  });
});
