import { describe, expect, it } from "vitest";
import { isTransientCursorTransportError } from "../src/adapters/cursor-transport.js";

describe("Cursor transport classification", () => {
  it("recognizes direct Node and undici socket failures", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "UND_ERR_SOCKET"]) {
      expect(isTransientCursorTransportError({ code })).toBe(true);
    }
  });

  it("recognizes transient causes nested under fetch failed", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    expect(isTransientCursorTransportError(error)).toBe(true);
    expect(isTransientCursorTransportError({
      message: "fetch failed",
      cause: { cause: { code: "HEADERS_TIMEOUT" } },
    })).toBe(true);
  });

  it("recognizes transient HTTP and Connect statuses through a cause chain", () => {
    expect(isTransientCursorTransportError({ cause: { status: 503 } })).toBe(true);
    expect(isTransientCursorTransportError({ code: 14 })).toBe(true);
  });

  it("classifies the SDK-wrapped fetch failure boundary as transient", () => {
    expect(isTransientCursorTransportError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientCursorTransportError({
      message: "fetch failed",
      isRetryable: false,
    })).toBe(true);
  });

  it("does not retry authentication or other ordinary 4xx failures", () => {
    expect(isTransientCursorTransportError({
      status: 401,
      cause: { code: "ECONNRESET" },
    })).toBe(false);
    expect(isTransientCursorTransportError({
      status: 404,
      message: "network error",
    })).toBe(false);
  });
});
