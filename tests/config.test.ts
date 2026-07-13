import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addRepository, loadMachineConfig, saveMachineConfig } from "../src/config.js";

describe("machine-local configuration", () => {
  it("persists with owner-only permissions and no secret field", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-config-"));
    await chmod(dir, 0o700);
    const file = path.join(dir, "config.json");
    await saveMachineConfig(file, { cursorModelId: "grok-4.5", repositories: {} });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadMachineConfig(file)).toEqual({ cursorModelId: "grok-4.5", repositories: {} });
  });

  it("adds repository aliases without overwriting an existing alias", () => {
    const initial = { cursorModelId: "grok-4.5", repositories: {} };
    const next = addRepository(initial, "demo", { root: "/repo", origin: "owner/repo", defaultBranch: "main" });
    expect(next.repositories.demo?.origin).toBe("owner/repo");
    expect(() => addRepository(next, "demo", { root: "/other", origin: "owner/other", defaultBranch: "main" })).toThrow();
  });
});
