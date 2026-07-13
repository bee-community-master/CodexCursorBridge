import { describe, expect, it } from "vitest";
import { errorResponse, successResponse } from "../src/response.js";

describe("tool responses", () => {
  it("uses the deterministic observation contract", () => {
    expect(successResponse("ok", ["next"], { report: "/tmp/report" })).toEqual({
      status: "success",
      summary: "ok",
      next_actions: ["next"],
      artifacts: { report: "/tmp/report" },
    });
    expect(errorResponse("bad", "root", "retry", "stop").status).toBe("error");
  });
});
