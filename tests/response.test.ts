import { describe, expect, it } from "vitest";
import { errorResponse, successResponse, warningResponse } from "../src/response.js";

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
});
