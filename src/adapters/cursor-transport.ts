import { safeErrorMessage } from "../application/redaction.js";

/**
 * Transport retries are deliberately separate from task repair attempts. A
 * transient SDK outage must not consume the task's bounded repair budget, and
 * an ambiguous send must never be retried without first reconciling the local
 * run store.
 */
export const CURSOR_TRANSPORT_MAX_ATTEMPTS = 3;
const cursorTransportRetryDelaysMs = [250, 1_000] as const;
const transientTransportCodes = new Set([
  "econnreset",
  "etimedout",
  "epipe",
  "econnrefused",
  "enetunreach",
  "ehostunreach",
  "und_err_socket",
  "connect_timeout",
  "headers_timeout",
  "body_timeout",
]);
const retryableHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

export function transportRetryDelayMs(attempt: number): number {
  return cursorTransportRetryDelaysMs[Math.min(
    attempt - 1,
    cursorTransportRetryDelaysMs.length - 1,
  )] ?? 1_000;
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const candidate = error as Error & {
    code?: unknown;
    status?: unknown;
    isRetryable?: unknown;
    cause?: unknown;
  };
  return [
    candidate.message,
    candidate.code,
    candidate.status,
    candidate.isRetryable === true ? "retryable" : undefined,
  ].filter(Boolean).join(" ");
}

export function isTransientCursorTransportError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    const candidate = current as {
      code?: unknown;
      status?: unknown;
      isRetryable?: unknown;
      cause?: unknown;
      message?: unknown;
    };
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const status = candidate.status;
    if (typeof status === "number" && status >= 400 && status < 500
      && !retryableHttpStatuses.has(status)) {
      return false;
    }
    if (candidate.isRetryable === true) return true;
    if (typeof status === "number" && retryableHttpStatuses.has(status)) return true;
    const code = typeof candidate.code === "string"
      ? candidate.code.toLowerCase()
      : "";
    if (typeof candidate.code === "number"
      && [4, 8, 10, 13, 14].includes(candidate.code)) {
      return true;
    }
    if (
      transientTransportCodes.has(code)
      || ["unavailable", "deadline_exceeded", "resource_exhausted", "internal", "aborted"].includes(code)
    ) {
      return true;
    }
    const message = typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : current instanceof Error
        ? current.message.toLowerCase()
        : "";
    if (/^fetch failed(?:$|:)/i.test(message.trim())) return true;
    if (/(?:connecterror|connect error|\bunavailable\b|temporarily unavailable|service unavailable|gateway timeout|\b503\b|\b504\b|\b429\b|deadline exceeded|timed? ?out|connection (?:reset|closed|refused)|network error)/i.test(message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export class CursorTransportUncertainError extends Error {
  constructor(message: string) {
    super(`CURSOR_TRANSPORT_UNCERTAIN: ${message}`);
    this.name = "CursorTransportUncertainError";
  }
}

export function transportFailureSummary(error: unknown): string {
  return safeErrorMessage(error);
}

export function transportFailureDetails(error: unknown): string {
  return errorDetails(error);
}
