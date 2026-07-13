export type ToolStatus = "success" | "warning" | "error";

export interface ToolResponse {
  status: ToolStatus;
  summary: string;
  next_actions: string[];
  artifacts: Record<string, string>;
  error?: { root_cause: string; safe_retry: string; stop_condition: string };
  [key: string]: unknown;
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
