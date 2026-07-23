import { terminalJobStatuses, type JobStatus } from "./state.js";

export type ToolStatus = "success" | "warning" | "error";

export interface ToolResponse {
  status: ToolStatus;
  summary: string;
  next_actions: string[];
  artifacts: Record<string, string>;
  error?: { root_cause: string; safe_retry: string; stop_condition: string };
  [key: string]: unknown;
}

export function cancellationSummary(before: JobStatus, after: JobStatus): string {
  if (after === "PUBLISHING") {
    return "Cursor task has reached publication and can no longer be safely cancelled.";
  }
  if (before === "QUEUED" && after === "CANCELLED") {
    return "Queued Cursor task was cancelled.";
  }
  if (terminalJobStatuses.has(after)) {
    return `Cursor task reached terminal state ${after} before cancellation could be requested.`;
  }
  return "Cursor task cancellation was requested and awaits worker confirmation.";
}

export function cancellationToolStatus(
  before: JobStatus,
  after: JobStatus,
  wakeFailed = false,
): ToolStatus {
  return wakeFailed
    || after === "PUBLISHING"
    || (terminalJobStatuses.has(after) && !(before === "QUEUED" && after === "CANCELLED"))
    ? "warning"
    : "success";
}

export function jobNextActions(
  status: JobStatus,
  hasReport: boolean,
  hasAttempt: boolean,
): string[] {
  if (status === "DELIVERED_REVIEW_REQUIRED") {
    return ["Review the Draft PR, report, and attestation before marking it ready."];
  }
  if (terminalJobStatuses.has(status)) {
    if (hasReport || (status === "CANCELLED" && !hasAttempt)) return [];
    return [
      "Retry cursor_get_report once; if it remains unavailable, inspect the job error and log.",
    ];
  }
  return ["Call cursor_get_task with this jobId to continue monitoring."];
}

export function missingReportResponse(
  status: JobStatus,
  hasAttempt: boolean,
  logPath?: string,
): ToolResponse {
  return warningResponse(
    terminalJobStatuses.has(status)
      ? "Terminal Cursor task has no report artifact."
      : "Report is not available yet.",
    jobNextActions(status, false, hasAttempt),
    logPath ? { log: logPath } : {},
  );
}

export function successResponse(
  summary: string,
  nextActions: string[] = [],
  artifacts: Record<string, string> = {},
): ToolResponse {
  return { status: "success", summary, next_actions: nextActions, artifacts };
}

export function warningResponse(
  summary: string,
  nextActions: string[] = [],
  artifacts: Record<string, string> = {},
): ToolResponse {
  return { status: "warning", summary, next_actions: nextActions, artifacts };
}

export function errorResponse(
  summary: string,
  rootCause: string,
  safeRetry: string,
  stopCondition: string,
  artifacts: Record<string, string> = {},
): ToolResponse {
  return {
    status: "error",
    summary,
    next_actions: [safeRetry],
    artifacts,
    error: { root_cause: rootCause, safe_retry: safeRetry, stop_condition: stopCondition },
  };
}
