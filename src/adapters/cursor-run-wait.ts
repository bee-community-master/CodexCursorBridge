import type { Run, SDKAgent } from "@cursor/sdk";
import type { ImplementerOutcome, PublicationStatePort } from "../application/workflow-ports.js";
import type { Attempt } from "../domain/job.js";
import { redactSensitiveText, safeErrorMessage } from "../application/redaction.js";
import {
  cancellationRecoveryOutcome,
  detachedRunOutcome,
  eventKey,
  stableEventValue,
  supportsRunOperation,
} from "./cursor-run-recovery.js";
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

const cancellationPollMs = 50;

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

type RunStreamEvent = { type: string; name?: string; status?: string };
type StreamConsumeResult = "completed" | "cancellation-recovery";

async function consumeRunStream(
  run: Run,
  jobId: string,
  attempt: Attempt,
  store: CursorRunWaitState,
  logSafely: (message: string) => Promise<void>,
  logEvent: (eventKey: string, message: string) => Promise<void>,
  cancellationRecovery: Promise<void>,
): Promise<StreamConsumeResult> {
  const iterator = run.stream()[Symbol.asyncIterator]();
  const occurrences = new Map<string, number>();
  for (;;) {
    const nextResult = iterator.next().then(
      (result) => ({ kind: "event" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const winner = await Promise.race([
      nextResult,
      cancellationRecovery.then(() => ({ kind: "cancellation-recovery" as const })),
    ]);
    if (winner.kind === "cancellation-recovery") {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // The SDK iterator may not support local shutdown after a detached run.
      }
      return "cancellation-recovery";
    }
    if (winner.kind === "error") throw winner.error;
    if (winner.result.done) return "completed";
    const event = winner.result.value as RunStreamEvent;
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
  if (!supportsRunOperation(run, "wait")) {
    return detachedRunOutcome(run, attempt, agent.agentId, "wait");
  }
  if (!supportsRunOperation(run, "stream")) {
    return detachedRunOutcome(run, attempt, agent.agentId, "stream");
  }

  let cancellationCheckActive = false;
  let cancellationRecoveryRequested = false;
  let resolveCancellationRecovery!: () => void;
  const cancellationRecovery = new Promise<void>((resolve) => {
    resolveCancellationRecovery = resolve;
  });
  const cancellationTimer = setInterval(() => {
    if (
      cancellationCheckActive
      || cancellationRecoveryRequested
      || !store.isCancellationRequested(jobId)
    ) return;
    cancellationCheckActive = true;
    if (!supportsRunOperation(run, "cancel")) {
      cancellationRecoveryRequested = true;
      void logSafely(`RECOVERY_REQUIRED: Cursor cancellation is unavailable for run ${run.id}; no cancel mutation was attempted.`);
      resolveCancellationRecovery();
      cancellationCheckActive = false;
      return;
    }
    void run.cancel()
      .catch((error: unknown) => logSafely(`Cursor cancellation failed: ${safeErrorMessage(error)}`))
      .finally(() => {
        cancellationCheckActive = false;
      });
  }, cancellationPollMs);
  cancellationTimer.unref();
  try {
    await drainPendingRunEvents(jobId, attempt, store, logEvent, logSafely, run.id);
    try {
      const streamResult = await consumeRunStream(
        run,
        jobId,
        attempt,
        store,
        logSafely,
        logEvent,
        cancellationRecovery,
      );
      if (streamResult === "cancellation-recovery") {
        if (!await drainPendingRunEvents(jobId, attempt, store, logEvent, logSafely, run.id)) {
          throw new CursorRunEventDeliveryUncertainError(run.id);
        }
        return cancellationRecoveryOutcome(run, attempt, agent.agentId);
      }
    } catch (error) {
      if (!await drainPendingRunEvents(jobId, attempt, store, logEvent, logSafely, run.id)) {
        throw new CursorRunEventDeliveryUncertainError(run.id);
      }
      throw error;
    }
    if (!await drainPendingRunEvents(jobId, attempt, store, logEvent, logSafely, run.id)) {
      throw new CursorRunEventDeliveryUncertainError(run.id);
    }
    const result = await run.wait();
    if (store.isCancellationRequested(jobId) && !supportsRunOperation(run, "cancel")) {
      return cancellationRecoveryOutcome(run, attempt, agent.agentId);
    }
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
