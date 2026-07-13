import { describe, expect, it } from "vitest";
import { assertCleanSuccessfulSmoke } from "../src/live-smoke.js";

describe("assertCleanSuccessfulSmoke", () => {
  it("accepts a finished run that left the disposable repository clean", () => {
    expect(() => assertCleanSuccessfulSmoke("finished", "")).not.toThrow();
  });

  it("rejects incomplete or modifying smoke runs", () => {
    expect(() => assertCleanSuccessfulSmoke("failed", "")).toThrow(/failed/);
    expect(() => assertCleanSuccessfulSmoke("finished", " M README.md")).toThrow(/modified/);
  });
});
