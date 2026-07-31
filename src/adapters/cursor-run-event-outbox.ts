import type { Attempt } from "../domain/job.js";
import type { PublicationStatePort } from "../application/workflow-ports.js";
import { safeErrorMessage } from "../application/redaction.js";

type RunEventStore = Pick<
  PublicationStatePort,
  "beginRunEvent" | "completeRunEvent" | "listPendingRunEvents"
>;

export async function deliverRunEvent(
  jobId: string,
  attempt: Attempt,
  store: RunEventStore,
  runId: string,
  eventKey: string,
  eventSummary: string,
  logEvent: (eventKey: string, message: string) => Promise<void>,
  logSafely: (message: string) => Promise<void>,
): Promise<void> {
  const state = store.beginRunEvent(
    jobId,
    attempt.id,
    attempt.workerToken,
    runId,
    eventKey,
    eventSummary,
  );
  if (state === "LOGGED") return;
  try {
    await logEvent(eventKey, eventSummary);
  } catch (error) {
    await logSafely(
      `Cursor run event delivery remains pending key=${eventKey} error=${safeErrorMessage(error)}`,
    );
    return;
  }
  store.completeRunEvent(
    jobId,
    attempt.id,
    attempt.workerToken,
    runId,
    eventKey,
  );
}

export async function drainPendingRunEvents(
  jobId: string,
  attempt: Attempt,
  store: RunEventStore,
  logEvent: (eventKey: string, message: string) => Promise<void>,
  logSafely: (message: string) => Promise<void>,
): Promise<void> {
  if (!attempt.cursorRunId) return;
  const pending = store.listPendingRunEvents(
    jobId,
    attempt.id,
    attempt.workerToken,
    attempt.cursorRunId,
  );
  for (const event of pending) {
    await deliverRunEvent(
      jobId,
      attempt,
      store,
      event.runId,
      event.eventKey,
      event.eventSummary,
      logEvent,
      logSafely,
    );
  }
}
