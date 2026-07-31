import type { Run, SDKAgent } from "@cursor/sdk";
import type { ImplementerOutcome, PublicationStatePort } from "../application/workflow-ports.js";
import type { Attempt } from "../domain/job.js";
import { redactSensitiveText, safeErrorMessage } from "../application/redaction.js";
import { eventKey, stableEventValue } from "./cursor-run-recovery.js";
import {
  CursorRunEventDeliveryUncertainError,
  deliverRunEvent,
  drainPendingRunEvents,
} from "./cursor-run-event-outbox.js";

type SubmittedOutcome = {
  status: "completed" | "blocked" | "needs_input";
  summary: string;
  reason?: string | undefined;
};

type CursorRunWaitState = Pick<
  PublicationStatePort,
  "isCancellationRequested"
  | "beginRunEvent"
  | "completeRunEvent"
  | "listPendingRunEvents"
>;

function eventSummary(event: { type: string; name?: string; status?: string }): string {
  return [event.type, event.name, event.status].filter(Boolean).join(" ");
}

export async function waitForOutcome(
  run: Run,
  agent: SDKAgent,
  attempt: Attempt,
  jobId: string,
  store: CursorRunWaitState,
  submitted: () => SubmittedOutcome | undefined,
  logSafely: (message: string) => Promise<void>,
  logEvent: (eventKey: string, message: string) => Promise<void>,
): Promise<ImplementerOutcome> {
  let cancellationCheckActive = false;
  const cancellationTimer = setInterval(() => {
    if (cancellationCheckActive || !store.isCancellationRequested(jobId)) return;
    cancellationCheckActive = true;
    void run.cancel()
      .catch((error: unknown) => logSafely(`Cursor cancellation failed: ${safeErrorMessage(error)}`))
      .finally(() => {
        cancellationCheckActive = false;
      });
  }, 500);
  cancellationTimer.unref();
  try {
    await drainPendingRunEvents(jobId, attempt, store, logEvent, logSafely, run.id);
    const occurrences = new Map<string, number>();
    for await (const event of run.stream()) {
      const signature = stableEventValue(event);
      const occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);
      await deliverRunEvent(
        jobId,
        attempt,
        store,
        run.id,
        eventKey(event, occurrence),
        redactSensitiveText(eventSummary(event)),
        logEvent,
        logSafely,
      );
    }
    if (!await drainPendingRunEvents(jobId, attempt, store, logEvent, logSafely, run.id)) {
      throw new CursorRunEventDeliveryUncertainError(run.id);
    }
    const result = await run.wait();
    if (result.status === "cancelled" && store.isCancellationRequested(jobId)) {
      return {
        status: "blocked",
        agentId: agent.agentId,
        runId: run.id,
        ...(result.requestId ? { requestId: result.requestId } : {}),
        summary: "Cancelled by user request.",
        reason: "Cancellation was requested by the bridge.",
        ...(result.usage ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        } : {}),
      };
    }
    if (result.status !== "finished") {
      throw new Error(result.error?.message ?? `Cursor run ended with ${result.status}`);
    }
    const structured = submitted() ?? {
      status: "needs_input" as const,
      summary: redactSensitiveText(result.result ?? "Cursor did not submit a structured outcome."),
      reason: "Cursor completed without calling submit_bridge_outcome.",
    };
    return {
      status: structured.status,
      agentId: agent.agentId,
      runId: run.id,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      summary: redactSensitiveText(structured.summary),
      ...(structured.reason ? { reason: redactSensitiveText(structured.reason) } : {}),
      ...(result.usage ? {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      } : {}),
    };
  } finally {
    clearInterval(cancellationTimer);
  }
}
