import { createHash } from "node:crypto";
import type { Attempt } from "../domain/job.js";
import type { PublicationStatePort } from "../application/workflow-ports.js";
import { safeErrorMessage } from "../application/redaction.js";

export class CursorRunEventDeliveryUncertainError extends Error {
  constructor(runId: string) {
    super(`CURSOR_TRANSPORT_UNCERTAIN: Cursor run event delivery remains pending for run ${runId}.`);
    this.name = "CursorRunEventDeliveryUncertainError";
  }
}

type RunEventStore = Pick<
  PublicationStatePort,
  "beginRunEvent" | "completeRunEvent" | "listPendingRunEvents"
>;

export function runEventLogKey(runId: string, eventKey: string): string {
  const canonical = `${runId.length}:${runId}${eventKey.length}:${eventKey}`;
  return `run-event:${createHash("sha256").update(canonical).digest("hex")}`;
}

export async function deliverRunEvent(
  jobId: string,
  attempt: Attempt,
  store: RunEventStore,
  runId: string,
  eventKey: string,
  eventSummary: string,
  logEvent: (eventKey: string, message: string) => Promise<void>,
  logSafely: (message: string) => Promise<void>,
): Promise<boolean> {
  const state = store.beginRunEvent(
    jobId,
    attempt.id,
    attempt.workerToken,
    runId,
    eventKey,
    eventSummary,
  );
  if (state === "LOGGED") return true;
  const logKey = runEventLogKey(runId, eventKey);
  try {
    await logEvent(logKey, eventSummary);
  } catch (error) {
    await logSafely(
      `Cursor run event delivery remains pending key=${logKey} error=${safeErrorMessage(error)}`,
    );
    return false;
  }
  store.completeRunEvent(
    jobId,
    attempt.id,
    attempt.workerToken,
    runId,
    eventKey,
  );
  return true;
}

export async function drainPendingRunEvents(
  jobId: string,
  attempt: Attempt,
  store: RunEventStore,
  logEvent: (eventKey: string, message: string) => Promise<void>,
  logSafely: (message: string) => Promise<void>,
  runId = attempt.cursorRunId ?? "",
): Promise<boolean> {
  if (!runId) return true;
  const pending = store.listPendingRunEvents(
    jobId,
    attempt.id,
    attempt.workerToken,
    runId,
  );
  let allDelivered = true;
  for (const event of pending) {
    const delivered = await deliverRunEvent(
      jobId,
      attempt,
      store,
      event.runId,
      event.eventKey,
      event.eventSummary,
      logEvent,
      logSafely,
    );
    allDelivered = delivered && allDelivered;
  }
  return allDelivered;
}
