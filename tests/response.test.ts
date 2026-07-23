import { describe, expect, it } from "vitest";
import {
  cancellationToolStatus,
  cancellationSummary,
  errorResponse,
  jobNextActions,
  missingReportResponse,
  successResponse,
  warningResponse,
} from "../src/response.js";

describe("tool responses", () => {
  it("uses the deterministic observation contract", () => {
    expect(successResponse("ok", ["next"], { report: "/tmp/report" })).toEqual({
      status: "success",
      summary: "ok",
      next_actions: ["next"],
      artifacts: { report: "/tmp/report" },
    });
    expect(warningResponse("wait").status).toBe("warning");
    expect(errorResponse("bad", "root", "retry", "stop")).toMatchObject({
      status: "error",
      error: { root_cause: "root", safe_retry: "retry", stop_condition: "stop" },
    });
  });

  it("describes cancellation outcomes without claiming publication was cancelled", () => {
    expect(cancellationSummary("QUEUED", "CANCELLED"))
      .toBe("Queued Cursor task was cancelled.");
    expect(cancellationSummary("VERIFYING", "CANCEL_REQUESTED"))
      .toBe("Cursor task cancellation was requested and awaits worker confirmation.");
    expect(cancellationSummary("PUBLISHING", "PUBLISHING"))
      .toBe("Cursor task has reached publication and can no longer be safely cancelled.");
    expect(cancellationSummary("VERIFYING", "FAILED"))
      .toBe("Cursor task reached terminal state FAILED before cancellation could be requested.");
    expect(cancellationToolStatus("VERIFYING", "PUBLISHING")).toBe("warning");
    expect(cancellationToolStatus("VERIFYING", "FAILED")).toBe("warning");
    expect(cancellationToolStatus("VERIFYING", "CANCEL_REQUESTED")).toBe("success");
    expect(cancellationToolStatus("VERIFYING", "CANCEL_REQUESTED", true)).toBe("warning");
    expect(cancellationToolStatus("QUEUED", "CANCELLED")).toBe("success");
  });

  it("does not promise that a missing terminal report will appear later", () => {
    expect(jobNextActions("CANCELLED", false, false)).toEqual([]);
    expect(jobNextActions("FAILED", false, true))
      .toEqual([
        "Retry cursor_get_report once; if it remains unavailable, inspect the job error and log.",
      ]);
    expect(jobNextActions("FAILED", true, true)).toEqual([]);
    expect(jobNextActions("VERIFYING", false, true))
      .toEqual(["Call cursor_get_task with this jobId to continue monitoring."]);
    expect(jobNextActions("DELIVERED_REVIEW_REQUIRED", true, true))
      .toEqual(["Review the Draft PR, report, and attestation before marking it ready."]);
    expect(missingReportResponse("FAILED", true, "/tmp/job.log")).toMatchObject({
      summary: "Terminal Cursor task has no report artifact.",
      next_actions: [
        "Retry cursor_get_report once; if it remains unavailable, inspect the job error and log.",
      ],
      artifacts: { log: "/tmp/job.log" },
    });
    expect(missingReportResponse("VERIFYING", true)).toMatchObject({
      summary: "Report is not available yet.",
      next_actions: ["Call cursor_get_task with this jobId to continue monitoring."],
    });
  });
});
