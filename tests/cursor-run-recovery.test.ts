import { describe, expect, it } from "vitest";
import { eventKey } from "../src/adapters/cursor-run-recovery.js";

describe("Cursor run event identity", () => {
  it("bounds and redacts SDK offsets before persisting event keys", () => {
    const secret = `API_KEY=secret\n${"x".repeat(50_000)}\tmarker`;
    const key = eventKey({ offset: secret }, 0);

    expect(key).toMatch(/^offset:[0-9a-f]{64}$/);
    expect(key).not.toContain("secret");
    expect(key).not.toContain("\n");
    expect(key).not.toContain("\t");
  });
});
