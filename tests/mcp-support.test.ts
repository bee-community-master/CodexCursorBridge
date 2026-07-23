import { describe, expect, it, vi } from "vitest";
import { readReportText, wakeJobSupervisor } from "../src/mcp-support.js";

describe("MCP supervisor wake support", () => {
  it("preserves a queued job and returns a redacted warning when wakeup fails", async () => {
    const recordEvent = vi.fn();
    const wake = vi.fn(async () => {
      throw new Error("launchctl failed with token: abcdefghijklmnopqrstuvwxyz");
    });

    const warning = await wakeJobSupervisor(
      { recordEvent },
      {
        id: "11111111-1111-4111-8111-111111111111",
        status: "QUEUED",
      },
      wake,
    );

    expect(warning).toBe("launchctl failed with token: [REDACTED]");
    expect(recordEvent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      undefined,
      "SUPERVISOR_WAKE_FAILED",
      { error: "launchctl failed with token: [REDACTED]" },
    );
  });

  it("does not wake the supervisor for a terminal job", async () => {
    const wake = vi.fn(async () => undefined);

    await expect(wakeJobSupervisor(
      { recordEvent: vi.fn() },
      {
        id: "11111111-1111-4111-8111-111111111111",
        status: "FAILED",
        currentAttemptId: "attempt",
      },
      wake,
    )).resolves.toBeUndefined();

    expect(wake).not.toHaveBeenCalled();
  });

  it("returns a redacted report-read failure instead of throwing a protocol error", async () => {
    const result = await readReportText("/reports/job.md", async () => {
      throw new Error("read failed with token: abcdefghijklmnopqrstuvwxyz");
    });

    expect(result).toEqual({
      ok: false,
      error: "read failed with token: [REDACTED]",
    });
  });
});
