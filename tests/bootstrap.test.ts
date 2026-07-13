import { describe, expect, it } from "vitest";
import { renderCursorAgentConfig } from "../src/bootstrap.js";

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
});
