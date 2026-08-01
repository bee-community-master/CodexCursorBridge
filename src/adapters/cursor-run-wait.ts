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
const cancellationObservationMs = 1_000;

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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type RunStreamEvent = { type: string; name?: string; status?: string };
type StreamConsumeResult = "completed" | "cancellation-recovery";
type RunWaitResult = Awaited<ReturnType<Run["wait"]>>;
type RunWaitRaceResult =
  | { kind: "result"; result: RunWaitResult }
  | { kind: "error"; error: unknown }
  | { kind: "cancellation-recovery" };

async function cancellationOutcomeAfterDrain(
  run: Run,
  attempt: Attempt,
  agentId: string,
  jobId: string,
  store: CursorRunWaitState,
  logEvent: (eventKey: string, message: string) => Promise<void>,
  logSafely: (message: string) => Promise<void>,
  detail: string | undefined,
): Promise<ImplementerOutcome> {
  if (!await drainPendingRunEvents(jobId, attempt, store, logEvent, logSafely, run.id)) {
    throw new CursorRunEventDeliveryUncertainError(run.id);
  }
  return cancellationRecoveryOutcome(run, attempt, agentId, detail);
}

async function waitForRunResult(
  run: Run,
  cancellationRecovery: Promise<void>,
  getCancellationSettlement: () => Promise<void> | undefined,
  cancellationAttemptStarted: Promise<void>,
  cancellationRequested: () => boolean,
): Promise<RunWaitRaceResult> {
  const waitResult = await Promise.race<RunWaitRaceResult>([
    run.wait().then(
      (result) => ({ kind: "result" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    cancellationRecovery.then(() => ({ kind: "cancellation-recovery" as const })),
  ]);
  if (cancellationRequested()) {
    if (!getCancellationSettlement()) {
      await Promise.race([cancellationAttemptStarted, delay(cancellationPollMs * 2)]);
    }
    const cancellationSettlement = getCancellationSettlement();
    if (cancellationSettlement) await Promise.race([cancellationSettlement, cancellationRecovery]);
  }
  return waitResult;
}

async function settleCancellationAfterError(
  getCancellationSettlement: () => Promise<void> | undefined,
): Promise<void> {
  const cancellationSettlement = getCancellationSettlement();
  if (cancellationSettlement) await Promise.race([cancellationSettlement, delay(cancellationObservationMs)]);
}

interface StreamFailureCancellation {
  attempt: () => void;
  attempted: () => boolean;
  recoveryRequested: () => boolean;
  requestRecovery: (detail: string) => void;
  settle: () => Promise<void>;
  detail: () => string | undefined;
  fence: Set<string> | undefined;
  fenceKey: string;
}

async function recoverCancellationAfterError(
  run: Run,
  attempt: Attempt,
  agentId: string,
  jobId: string,
  store: CursorRunWaitState,
  logEvent: (eventKey: string, message: string) => Promise<void>,
  logSafely: (message: string) => Promise<void>,
  cancellation: StreamFailureCancellation,
  failureDetail: string,
  drainWithoutCancellation: boolean,
): Promise<ImplementerOutcome | undefined> {
  cancellation.attempt();
  if (
    !cancellation.attempted()
    && !cancellation.recoveryRequested()
    && !cancellation.fence?.has(cancellation.fenceKey)
  ) {
    if (drainWithoutCancellation && !await drainPendingRunEvents(jobId, attempt, store, logEvent, logSafely, run.id)) {
      throw new CursorRunEventDeliveryUncertainError(run.id);
    }
    return undefined;
  }
  if (!cancellation.recoveryRequested()) {
    cancellation.requestRecovery(
      `CURSOR_TRANSPORT_UNCERTAIN: ${failureDetail} after cancellation was requested for run ${run.id}; RECOVERY_REQUIRED: no further cancel mutation was attempted.`,
    );
  }
  await cancellation.settle();
  return cancellationOutcomeAfterDrain(
    run,
    attempt,
    agentId,
    jobId,
    store,
    logEvent,
    logSafely,
    cancellation.detail(),
  );
}

function finalizeRunOutcome(
  run: Run,
  agent: SDKAgent,
  attempt: Attempt,
  jobId: string,
  store: CursorRunWaitState,
  submitted: () => SubmittedOutcome | undefined,
  result: RunWaitResult,
  cancellationSupported: boolean,
  cancellationDetail: string | undefined,
): ImplementerOutcome {
  if (store.isCancellationRequested(jobId) && !cancellationSupported) {
    return cancellationRecoveryOutcome(run, attempt, agent.agentId, cancellationDetail);
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
}

async function consumeRunStream(
  run: Run,
  jobId: string,
  attempt: Attempt,
  store: CursorRunWaitState,
  logSafely: (message: string) => Promise<void>,
  logEvent: (eventKey: string, message: string) => Promise<void>,
  cancellationRecovery: Promise<void>,
  cancellationSupported: boolean,
  requestCancellationRecovery: (detail?: string) => void,
): Promise<StreamConsumeResult> {
  const iterator = run.stream()[Symbol.asyncIterator]();
  const occurrences = new Map<string, number>();
  for (;;) {
    if (!cancellationSupported && store.isCancellationRequested(jobId)) {
      requestCancellationRecovery();
      return "cancellation-recovery";
    }
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
  cancellationFence?: Set<string>,
): Promise<ImplementerOutcome> {
  if (!supportsRunOperation(run, "wait")) {
    return detachedRunOutcome(run, attempt, agent.agentId, "wait");
  }
  if (!supportsRunOperation(run, "stream")) {
    return detachedRunOutcome(run, attempt, agent.agentId, "stream");
  }

  let cancellationCheckActive = false;
  let cancellationRecoveryRequested = false;
  let cancellationAttempted = false;
  let cancellationRecoveryDetail: string | undefined;
  let cancellationSettlement: Promise<void> | undefined;
  let cancellationObservationTimer: NodeJS.Timeout | undefined;
  let resolveCancellationAttempt!: () => void;
  let resolveCancellationRecovery!: () => void;
  const cancellationAttemptStarted = new Promise<void>((resolve) => {
    resolveCancellationAttempt = resolve;
  });
  const cancellationRecovery = new Promise<void>((resolve) => {
    resolveCancellationRecovery = resolve;
  });
  const cancellationSupported = supportsRunOperation(run, "cancel");
  const cancellationFenceKey = attempt.id;
  const clearCancellationObservation = (): void => {
    if (!cancellationObservationTimer) return;
    clearTimeout(cancellationObservationTimer);
    cancellationObservationTimer = undefined;
  };
  const requestCancellationRecovery = (detail?: string): void => {
    if (cancellationRecoveryRequested) return;
    cancellationRecoveryRequested = true;
    resolveCancellationAttempt();
    clearCancellationObservation();
    cancellationRecoveryDetail = detail
      ?? `RECOVERY_REQUIRED: Cursor cancellation is unavailable for run ${run.id}; no cancel mutation was attempted.`;
    void logSafely(cancellationRecoveryDetail);
    resolveCancellationRecovery();
  };
  const attemptCancellation = (): void => {
    if (
      cancellationCheckActive
      || cancellationAttempted
      || cancellationRecoveryRequested
      || !store.isCancellationRequested(jobId)
    ) return;
    cancellationCheckActive = true;
    if (cancellationFence?.has(cancellationFenceKey)) {
      requestCancellationRecovery(
        `CURSOR_TRANSPORT_UNCERTAIN: cancellation was already attempted for attempt ${attempt.id}; RECOVERY_REQUIRED: no second cancel mutation was attempted.`,
      );
      cancellationCheckActive = false;
      return;
    }
    if (!cancellationSupported) {
      requestCancellationRecovery(
        `RECOVERY_REQUIRED: Cursor cancellation is unavailable for run ${run.id}; no cancel mutation was attempted.`,
      );
      cancellationCheckActive = false;
      return;
    }
    cancellationAttempted = true;
    cancellationFence?.add(cancellationFenceKey);
    resolveCancellationAttempt();
    cancellationObservationTimer = setTimeout(() => requestCancellationRecovery(
      `CURSOR_TRANSPORT_UNCERTAIN: Cursor cancellation for run ${run.id} did not produce an authoritative terminal result within ${cancellationObservationMs}ms; RECOVERY_REQUIRED: no further cancel mutation was attempted.`,
    ), cancellationObservationMs);
    cancellationSettlement = Promise.resolve()
      .then(() => run.cancel())
      .catch((error: unknown) => requestCancellationRecovery(
        `CURSOR_TRANSPORT_UNCERTAIN: Cursor cancellation failed for run ${run.id}; RECOVERY_REQUIRED: no further cancel mutation was attempted: ${safeErrorMessage(error)}`,
      ));
    void cancellationSettlement.finally(() => {
      cancellationCheckActive = false;
    }).catch(() => undefined);
  };
  const cancellationTimer = setInterval(attemptCancellation, cancellationPollMs);
  cancellationTimer.unref();
  attemptCancellation();
  const recoverCancellationError = (failureDetail: string, drainWithoutCancellation: boolean): Promise<ImplementerOutcome | undefined> =>
    recoverCancellationAfterError(
      run, attempt, agent.agentId, jobId, store, logEvent, logSafely,
      {
        attempt: attemptCancellation, attempted: () => cancellationAttempted,
        recoveryRequested: () => cancellationRecoveryRequested,
        requestRecovery: requestCancellationRecovery,
        settle: () => settleCancellationAfterError(() => cancellationSettlement),
        detail: () => cancellationRecoveryDetail, fence: cancellationFence,
        fenceKey: cancellationFenceKey,
      }, failureDetail, drainWithoutCancellation,
    );
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
        cancellationSupported,
        requestCancellationRecovery,
      );
      if (streamResult === "cancellation-recovery") {
        return cancellationOutcomeAfterDrain(
          run,
          attempt,
          agent.agentId,
          jobId,
          store,
          logEvent,
          logSafely,
          cancellationRecoveryDetail,
        );
      }
    } catch (error) {
      const cancellationOutcome = await recoverCancellationError("Cursor stream failed", true);
      if (cancellationOutcome) return cancellationOutcome;
      throw error;
    }
    if (!await drainPendingRunEvents(jobId, attempt, store, logEvent, logSafely, run.id)) {
      throw new CursorRunEventDeliveryUncertainError(run.id);
    }
    const waitResult = await waitForRunResult(
      run,
      cancellationRecovery,
      () => cancellationSettlement,
      cancellationAttemptStarted,
      () => store.isCancellationRequested(jobId),
    );
    if (waitResult.kind === "cancellation-recovery" || cancellationRecoveryRequested) {
      return cancellationOutcomeAfterDrain(
        run,
        attempt,
        agent.agentId,
        jobId,
        store,
        logEvent,
        logSafely,
        cancellationRecoveryDetail,
      );
    }
    if (waitResult.kind === "error") {
      const cancellationOutcome = await recoverCancellationError("Cursor wait failed", false);
      if (cancellationOutcome) return cancellationOutcome;
      throw waitResult.error;
    }
    clearCancellationObservation();
    const result = waitResult.result;
    return finalizeRunOutcome(
      run,
      agent,
      attempt,
      jobId,
      store,
      submitted,
      result,
      cancellationSupported,
      cancellationRecoveryDetail,
    );
  } finally {
    clearInterval(cancellationTimer);
    clearCancellationObservation();
  }
}
