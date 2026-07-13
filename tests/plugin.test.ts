import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("Cursor Bridge plugin delegation contract", () => {
  it("instructs the main Codex agent to start an asynchronous job directly", async () => {
    const skill = await readFile(
      path.join(root, "plugins", "cursor-bridge", "skills", "cursor-delegation", "SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("Call `cursor_start_task` directly");
    expect(skill).toContain("returns a job ID without waiting for Cursor");
    expect(skill).not.toMatch(/spawn the `cursor` role/i);
    expect(skill).not.toMatch(/custom agent/i);
  });
});
