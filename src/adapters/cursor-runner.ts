import {
  Agent,
  Cursor,
  JsonlLocalAgentStore,
  type Run,
  type SDKAgent,
  type SDKCustomTool,
  type SDKJsonValue,
} from "@cursor/sdk";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import type {
  ImplementerOutcome,
  PreparedWorktree,
  PublicationStatePort,
} from "../application/workflow-ports.js";
import type {
  MachineConfig,
  RuntimePaths,
} from "../domain/configuration.js";
import type { Attempt } from "../domain/job.js";
import type { ApprovedTask } from "../domain/task.js";
import { readCursorApiKey } from "../keychain.js";
import { chooseConfiguredGrok } from "../model.js";
import {
  redactSensitiveText,
  safeErrorMessage,
} from "../application/redaction.js";
import {
  CURSOR_TRANSPORT_MAX_ATTEMPTS,
  CursorTransportUncertainError,
  isTransientCursorTransportError,
  transportFailureDetails,
  transportFailureSummary,
  transportRetryDelayMs,
} from "./cursor-transport.js";
import {
  detachedRunOutcome,
  recoveredRunMetadata,
  supportsRunOperation,
} from "./cursor-run-recovery.js";
import {
  CursorRunEventDeliveryUncertainError,
  drainPendingRunEvents,
} from "./cursor-run-event-outbox.js";
import { waitForOutcome } from "./cursor-run-wait.js";
import type { PreparedWorktreeGuard } from "./prepared-worktree-guard.js";
import type { WorkflowLogger } from "./workflow-logger.js";
type CursorRunStatePort = Pick<
  PublicationStatePort,
  "isCancellationRequested"
  | "updateAttempt"
  | "beginRunEvent"
  | "completeRunEvent"
  | "listPendingRunEvents"
>;
interface LocalCursorRunOptions {
  runtime: "local";
  cwd: string;
  store: JsonlLocalAgentStore;
}
type RecoveredCursorRun =
  | { kind: "active"; run: Run }
  | { kind: "outcome"; outcome: ImplementerOutcome }
  | { kind: "recovery-required"; outcome: ImplementerOutcome }
  | { kind: "new"; previousRunId?: string };
const outcomeSchema = z.object({
  status: z.enum(["completed", "blocked", "needs_input"]),
  summary: z.string().min(1).max(8_000),
  reason: z.string().min(1).max(4_000).optional(),
});
function hasPersistedOutcome(
  attempt: Attempt,
): attempt is Attempt & Required<Pick<Attempt, "outcome" | "outcomeSummary">> {
  return attempt.outcome !== undefined
    && attempt.outcomeSummary !== undefined;
}
function isForceSendMarker(error: unknown): boolean {
  const candidate = error as { message?: unknown; code?: unknown } | undefined;
  const values = [
    candidate?.message,
    candidate?.code,
    error instanceof Error ? error.message : undefined,
  ];
  return values.some((value) =>
    typeof value === "string" && /\bforce[_ -]?send\b/i.test(value));
}

function isRecoverableCursorRunError(error: unknown): boolean {
  return error instanceof CursorRunEventDeliveryUncertainError
    || isTransientCursorTransportError(error)
    || isForceSendMarker(error);
}

function restoredOutcome(
  run: Run,
  attempt: Attempt,
  agentId: string,
  runId: string,
): ImplementerOutcome | undefined {
  const metadata = recoveredRunMetadata(run);
  if (hasPersistedOutcome(attempt)) {
    return {
      status: attempt.outcome,
      agentId,
      runId,
      ...metadata,
      summary: redactSensitiveText(attempt.outcomeSummary),
      ...(attempt.outcomeReason
        ? { reason: redactSensitiveText(attempt.outcomeReason) }
        : {}),
    };
  }
  if (run.status === "finished") {
    return {
      status: "needs_input",
      agentId,
      runId,
      ...metadata,
      summary: redactSensitiveText(
        run.result ?? "Cursor finished without a persisted structured outcome.",
      ),
      reason: "Cursor finished without submitting a durable structured outcome.",
    };
  }
  if (run.status === "error" && isRecoverableCursorRunError(run.error)) {
    return undefined;
  }
  if (run.status === "error" || run.status === "cancelled") {
    throw new Error(run.error?.message ?? `Cursor run ended with ${run.status}`);
  }
  return undefined;
}

function outputTool(setOutcome: (outcome: z.infer<typeof outcomeSchema>) => void): SDKCustomTool {
  return {
    description: "Submit the final structured outcome for this approved implementation attempt. Call exactly once after stopping work.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary"],
      properties: {
        status: { type: "string", enum: ["completed", "blocked", "needs_input"] },
        summary: { type: "string", minLength: 1, maxLength: 8_000 },
        reason: { type: "string", minLength: 1, maxLength: 4_000 },
      },
    },
    execute: (args: Record<string, SDKJsonValue>): SDKJsonValue => {
      const outcome = outcomeSchema.parse(args);
      setOutcome(outcome);
      return { accepted: true, status: outcome.status };
    },
  };
}

export class CursorImplementer {
  readonly #config: MachineConfig;
  readonly #store: CursorRunStatePort;
  readonly #jobId: string;
  readonly #guard: PreparedWorktreeGuard;
  readonly #logger: WorkflowLogger;
  readonly #cursorStore: JsonlLocalAgentStore;
  readonly #activeRuns = new Map<string, Run>();

  constructor(
    paths: RuntimePaths,
    config: MachineConfig,
    store: CursorRunStatePort,
    jobId: string,
    guard: PreparedWorktreeGuard,
    logger: WorkflowLogger,
  ) {
    this.#config = config;
    this.#store = store;
    this.#jobId = jobId;
    this.#guard = guard;
    this.#logger = logger;
    this.#cursorStore = new JsonlLocalAgentStore(path.join(paths.home, "cursor-sdk"));
  }

  async run(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    attempt: Attempt,
    repairFeedback?: string,
  ): Promise<ImplementerOutcome> {
    await this.#guard.assertPreparedWorktree(prepared);
    let submitted: z.infer<typeof outcomeSchema> | undefined;
    const customTools = {
      submit_bridge_outcome: outputTool((outcome) => {
        if (submitted) throw new Error("submit_bridge_outcome may only be called once");
        submitted = {
          ...outcome,
          summary: redactSensitiveText(outcome.summary),
          ...(outcome.reason ? { reason: redactSensitiveText(outcome.reason) } : {}),
        };
        this.#store.updateAttempt(attempt.id, attempt.workerToken, {
          outcome: submitted.status,
          outcomeSummary: submitted.summary,
          ...(submitted.reason ? { outcomeReason: submitted.reason } : {}),
        });
      }),
    };
    const pendingEventsDelivered = await drainPendingRunEvents(
      this.#jobId,
      attempt,
      this.#store,
      this.#logEvent.bind(this),
      this.#logSafely.bind(this),
    );
    if (!pendingEventsDelivered && attempt.cursorRunId) {
      throw new CursorRunEventDeliveryUncertainError(attempt.cursorRunId);
    }
    const recovered = await this.#recoverDurableRun(prepared, attempt);
    if (recovered.kind === "outcome" || recovered.kind === "recovery-required") {
      return recovered.outcome;
    }
    const agent = await this.#createOrResumeAgentWithRetry(
      prepared,
      task,
      attempt,
      customTools,
    );
    try {
      const prompt = repairFeedback
        ? [
          "Continue the approved task in the existing worktree.",
          "Use only the independent verifier evidence below for this bounded repair attempt.",
          repairFeedback,
          "Do not commit or push. Call submit_bridge_outcome exactly once when you stop.",
        ].join("\n\n")
        : [
          "Read AGENTS.md and project rules before editing.",
          "Implement exactly the approved task packet below.",
          "Do not weaken acceptance criteria, widen scope, delete tests, add unapproved dependencies, or access production.",
          "Reproduce bugs first, add regression tests, and stop on any stop condition.",
          "Do not commit, push, or create a PR; the bridge verifies and publishes independently.",
          "Call submit_bridge_outcome exactly once with completed, blocked, or needs_input when you stop.",
          "--- APPROVED TASK ---",
          stringify(task, { lineWidth: 100 }),
          "--- END TASK ---",
        ].join("\n\n");
      const run = recovered.kind === "active"
        ? recovered.run
        : await this.#sendWithTransportRetry(
          agent,
          prompt,
          prepared,
          attempt,
          customTools,
          recovered.previousRunId,
        );
      this.#activeRuns.set(attempt.id, run);
      this.#store.updateAttempt(attempt.id, attempt.workerToken, {
        cursorAgentId: agent.agentId,
        cursorRunId: run.id,
        ...(run.requestId ? { cursorRequestId: run.requestId } : {}),
      });
      if (run.status !== "running") {
        const terminalOutcome = restoredOutcome(
          run,
          attempt,
          agent.agentId,
          run.id,
        );
        if (terminalOutcome) return terminalOutcome;
        if (run.status === "error" && isRecoverableCursorRunError(run.error)) {
          throw new CursorTransportUncertainError(
            `Cursor send returned a terminal transport error for run ${run.id}.`,
          );
        }
      }
      return await this.#waitForOutcomeWithTransportRetry(
        run,
        agent,
        prepared,
        attempt,
        () => submitted,
      );
    } finally {
      this.#activeRuns.delete(attempt.id);
      try {
        await agent[Symbol.asyncDispose]();
      } catch (error) {
        // Disposal is best-effort cleanup. Never let an executor shutdown
        // failure replace the primary run outcome or an uncertain transport
        // error; the redacted diagnostic is enough for later inspection.
        await this.#logSafely(`Cursor agent disposal failed: ${safeErrorMessage(error)}`);
      }
    }
  }
  async cancel(attempt: Attempt): Promise<void> {
    const active = this.#activeRuns.get(attempt.id);
    if (active) {
      await active.cancel();
      await active.wait();
      return;
    }
    if (!attempt.cursorRunId) return;
    const options = {
      runtime: "local",
      ...(attempt.worktree ? { cwd: attempt.worktree } : {}),
      store: this.#cursorStore,
    } as const;
    const current = await Agent.getRun(attempt.cursorRunId, options);
    if (current.status !== "running") return;
    if (
      !supportsRunOperation(current, "wait")
      || !supportsRunOperation(current, "cancel")
    ) {
      throw new Error(
        `RECOVERY_REQUIRED: Cursor run ${attempt.cursorRunId} is detached; cancellation cannot be confirmed without a live executor.`,
      );
    }
    await Agent.cancelRun(attempt.cursorRunId, options);
    const persisted = await Agent.getRun(attempt.cursorRunId, options);
    if (persisted.status === "running") {
      throw new Error(`Cursor run is still active after cancellation: ${attempt.cursorRunId}`);
    }
  }
  async #createOrResumeAgent(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    attempt: Attempt,
    customTools: Record<string, SDKCustomTool>,
  ): Promise<SDKAgent> {
    const apiKey = await readCursorApiKey();
    const selected = chooseConfiguredGrok(
      await Cursor.models.list({ apiKey }),
      this.#config.cursorModelId,
      this.#config.cursorModelParams,
    );
    const options = {
      apiKey,
      name: `codex-delegated:${task.id}`,
      model: selected,
      mode: "agent" as const,
      local: {
        cwd: prepared.worktree,
        store: this.#cursorStore,
        settingSources: [],
        sandboxOptions: { enabled: true },
        autoReview: true,
        customTools,
        enableAgentRetries: true,
      },
    };
    return attempt.cursorAgentId
      ? Agent.resume(attempt.cursorAgentId, options)
      : Agent.create({ ...options, idempotencyKey: `bridge-agent:${attempt.id}` });
  }
  async #createOrResumeAgentWithRetry(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    attempt: Attempt,
    customTools: Record<string, SDKCustomTool>,
  ): Promise<SDKAgent> {
    let lastError: unknown;
    for (let retry = 1; retry <= CURSOR_TRANSPORT_MAX_ATTEMPTS; retry += 1) {
      try {
        return await this.#createOrResumeAgent(prepared, task, attempt, customTools);
      } catch (error) {
        lastError = error;
        if (!isTransientCursorTransportError(error)) throw error;
        await this.#logTransportFailure("agent-resume", retry, error);
        if (retry === CURSOR_TRANSPORT_MAX_ATTEMPTS) break;
        await this.#delayAfterTransportFailure(retry);
      }
    }
    throw new CursorTransportUncertainError(
      `Cursor agent could not be resumed after ${CURSOR_TRANSPORT_MAX_ATTEMPTS} attempts: ${safeErrorMessage(lastError)}`,
    );
  }
  async #recoverDurableRun(
    prepared: PreparedWorktree,
    attempt: Attempt,
  ): Promise<RecoveredCursorRun> {
    const agentId = attempt.cursorAgentId;
    const runId = attempt.cursorRunId;
    const options: LocalCursorRunOptions = {
      runtime: "local",
      cwd: prepared.worktree,
      store: this.#cursorStore,
    };
    if (runId) {
      let priorRun = await this.#readPriorRun(runId, options);
      if (agentId && priorRun.agentId !== agentId) {
        await this.#logSafely(
          `Cursor run identity mismatch: Attempt agent ${agentId}, local run agent ${priorRun.agentId}.`,
        );
        throw new CursorTransportUncertainError(
          `Cursor run ${runId} does not belong to the durable agent identity.`,
        );
      }
      const recoveredAgentId = agentId ?? priorRun.agentId;
      if (priorRun.status === "running") {
        if (
          !supportsRunOperation(priorRun, "wait")
          || (hasPersistedOutcome(attempt) && !supportsRunOperation(priorRun, "cancel"))
        ) {
          return {
            kind: "recovery-required",
            outcome: detachedRunOutcome(priorRun, attempt, recoveredAgentId),
          };
        }
        if (hasPersistedOutcome(attempt)) {
          priorRun = await this.#stopPriorRun(runId, options);
        }
      }
      if (priorRun.status === "running") {
        return { kind: "active", run: priorRun };
      }
      const outcome = restoredOutcome(priorRun, attempt, recoveredAgentId, runId);
      if (outcome) return { kind: "outcome", outcome };

      // A terminal transport error is safe to follow up only after the local
      // store confirms that no newer run is active for this agent.
      const active = await this.#findActiveRun(recoveredAgentId, options);
      if (active) {
        if (!supportsRunOperation(active, "wait")) {
          return {
            kind: "recovery-required",
            outcome: detachedRunOutcome(active, attempt, recoveredAgentId),
          };
        }
        await this.#bindRun(attempt, recoveredAgentId, active);
        return { kind: "active", run: active };
      }
      return { kind: "new", previousRunId: runId };
    }
    if (!agentId) return { kind: "new" };
    const active = await this.#findActiveRun(agentId, options);
    if (active) {
      if (!supportsRunOperation(active, "wait")) {
        return {
          kind: "recovery-required",
          outcome: detachedRunOutcome(active, attempt, agentId),
        };
      }
      await this.#bindRun(attempt, agentId, active);
      return { kind: "active", run: active };
    }
    return { kind: "new" };
  }

  async #readPriorRun(
    runId: string,
    options: LocalCursorRunOptions,
  ): Promise<Run> {
    try {
      return await Agent.getRun(runId, options);
    } catch (error) {
      const detail = safeErrorMessage(error);
      await this.#logSafely(`Could not safely read prior Cursor run: ${detail}`);
      if (isRecoverableCursorRunError(error)) {
        throw new CursorTransportUncertainError(
          `Could not safely recover the prior Cursor run: ${detail}`,
        );
      }
      throw new Error(`Could not safely recover the prior Cursor run: ${detail}`);
    }
  }

  async #findActiveRun(
    agentId: string,
    options: LocalCursorRunOptions,
  ): Promise<Run | undefined> {
    try {
      const listed = await Agent.listRuns(agentId, options);
      const active = listed.items
        .filter((run) => run.status === "running" && run.agentId === agentId)
        .sort((left, right) => {
          const leftCreated = left.createdAt ?? 0;
          const rightCreated = right.createdAt ?? 0;
          return rightCreated - leftCreated || right.id.localeCompare(left.id);
        });
      return active[0];
    } catch (error) {
      const detail = safeErrorMessage(error);
      await this.#logSafely(`Could not reconcile local Cursor runs: ${detail}`);
      if (isRecoverableCursorRunError(error)) {
        throw new CursorTransportUncertainError(
          `Could not reconcile local Cursor runs: ${detail}`,
        );
      }
      throw new Error(`Could not reconcile local Cursor runs: ${detail}`);
    }
  }

  async #bindRun(attempt: Attempt, agentId: string, run: Run): Promise<void> {
    this.#store.updateAttempt(attempt.id, attempt.workerToken, {
      cursorAgentId: agentId,
      cursorRunId: run.id,
      ...(run.requestId ? { cursorRequestId: run.requestId } : {}),
    });
    await this.#logSafely(`Rebound active Cursor run ${run.id} for agent ${agentId}.`);
  }

  async #sendWithTransportRetry(
    agent: SDKAgent,
    prompt: string,
    prepared: PreparedWorktree,
    attempt: Attempt,
    customTools: Record<string, SDKCustomTool>,
    previousRunId?: string,
  ): Promise<Run> {
    const idempotencyKey = previousRunId
      ? `bridge-follow-up:${attempt.id}:${previousRunId}`
      : `bridge-attempt:${attempt.id}`;
    let lastError: unknown;
    for (let retry = 1; retry <= CURSOR_TRANSPORT_MAX_ATTEMPTS; retry += 1) {
      try {
        const run = await agent.send(prompt, {
          idempotencyKey,
          local: { customTools },
        });
        if (run.status !== "running") {
          const active = await this.#findActiveRun(agent.agentId, {
            runtime: "local",
            cwd: prepared.worktree,
            store: this.#cursorStore,
          });
          if (active && active.id !== run.id) {
            await this.#logSafely(
              `Ignored terminal Cursor send result ${run.id}; rebound active run ${active.id}.`,
            );
            return active;
          }
        }
        return run;
      } catch (error) {
        lastError = error;
        if (!isRecoverableCursorRunError(error)) throw error;
        await this.#logTransportFailure("send", retry, error);
        const active = await this.#findActiveRun(agent.agentId, {
          runtime: "local",
          cwd: prepared.worktree,
          store: this.#cursorStore,
        });
        if (active) return active;
        if (retry === CURSOR_TRANSPORT_MAX_ATTEMPTS) break;
        await this.#delayAfterTransportFailure(retry);
      }
    }
    throw new CursorTransportUncertainError(
      `Cursor send remained ambiguous after ${CURSOR_TRANSPORT_MAX_ATTEMPTS} attempts: ${transportFailureSummary(lastError)}`,
    );
  }

  async #waitForOutcomeWithTransportRetry(
    run: Run,
    agent: SDKAgent,
    prepared: PreparedWorktree,
    attempt: Attempt,
    submitted: () => z.infer<typeof outcomeSchema> | undefined,
  ): Promise<ImplementerOutcome> {
    let current = run;
    for (let retry = 1; retry <= CURSOR_TRANSPORT_MAX_ATTEMPTS; retry += 1) {
      try {
        if (current.status === "running" && !supportsRunOperation(current, "wait")) {
          return detachedRunOutcome(current, attempt, agent.agentId);
        }
        return await waitForOutcome(
          current,
          agent,
          attempt,
          this.#jobId,
          this.#store,
          submitted,
          this.#logSafely.bind(this),
          this.#logEvent.bind(this),
        );
      } catch (error) {
        if (error instanceof CursorRunEventDeliveryUncertainError) throw error;
        if (!isRecoverableCursorRunError(error)) throw error;
        await this.#logTransportFailure("monitor", retry, error);
        const options: LocalCursorRunOptions = {
          runtime: "local",
          cwd: prepared.worktree,
          store: this.#cursorStore,
        };
        const rebound = await this.#reconcileRunAfterTransport(
          attempt,
          agent.agentId,
          current.id,
          options,
        );
        if (rebound.kind === "outcome") return rebound.outcome;
        if (rebound.kind === "recovery-required") return rebound.outcome;
        if (rebound.kind === "active") {
          current = rebound.run;
          if (retry < CURSOR_TRANSPORT_MAX_ATTEMPTS) {
            await this.#delayAfterTransportFailure(retry);
            continue;
          }
        }
        throw new CursorTransportUncertainError(
          `Cursor run ${current.id} could not be monitored after a transport failure: ${transportFailureSummary(error)}`,
        );
      }
    }
    throw new CursorTransportUncertainError(
      `Cursor run ${current.id} could not be monitored after ${CURSOR_TRANSPORT_MAX_ATTEMPTS} attempts.`,
    );
  }

  async #reconcileRunAfterTransport(
    attempt: Attempt,
    agentId: string,
    runId: string,
    options: LocalCursorRunOptions,
  ): Promise<RecoveredCursorRun> {
    const run = await this.#readPriorRun(runId, options);
    if (run.status === "running") {
      return supportsRunOperation(run, "wait")
        ? { kind: "active", run }
        : {
          kind: "recovery-required",
          outcome: detachedRunOutcome(run, attempt, agentId),
        };
    }
    const outcome = restoredOutcome(run, attempt, agentId, runId);
    if (outcome) return { kind: "outcome", outcome };
    const active = await this.#findActiveRun(agentId, options);
    if (active) {
      if (!supportsRunOperation(active, "wait")) {
        return {
          kind: "recovery-required",
          outcome: detachedRunOutcome(active, attempt, agentId),
        };
      }
      await this.#bindRun(attempt, agentId, active);
      return { kind: "active", run: active };
    }
    return { kind: "new", previousRunId: runId };
  }

  async #logTransportFailure(
    operation: string,
    retry: number,
    error: unknown,
  ): Promise<void> {
    await this.#logSafely(
      `CURSOR_TRANSPORT_RETRY operation=${operation} attempt=${retry}/${CURSOR_TRANSPORT_MAX_ATTEMPTS} error=${transportFailureDetails(error)}`,
    );
  }

  async #logSafely(message: string): Promise<void> {
    try {
      await this.#logger.log(message);
    } catch {
      // Diagnostics are non-authoritative; logging failures must not alter the
      // durable run outcome or hide an uncertain transport error.
    }
  }

  async #logEvent(eventKey: string, message: string): Promise<void> {
    await (this.#logger.logEvent?.(eventKey, message) ?? this.#logger.log(message));
  }

  async #delayAfterTransportFailure(retry: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, transportRetryDelayMs(retry)));
  }

  async #stopPriorRun(
    runId: string,
    options: LocalCursorRunOptions,
  ): Promise<Run> {
    let cancellationFailure: unknown;
    try {
      await Agent.cancelRun(runId, options);
    } catch (error) {
      cancellationFailure = error;
    }
    let confirmed: Run;
    try {
      confirmed = await Agent.getRun(runId, options);
    } catch (error) {
      throw new Error(
        `Could not confirm the prior Cursor run stopped: ${safeErrorMessage(error)}`,
      );
    }
    if (confirmed.status === "running") {
      const detail = cancellationFailure
        ? `: ${safeErrorMessage(cancellationFailure)}`
        : "";
      throw new Error(
        `Cursor run is still active after restoring its durable outcome${detail}`,
      );
    }
    if (cancellationFailure) {
      await this.#logSafely(
        "Cursor cancellation reported an error, but terminal readback confirmed the run stopped.",
      );
    }
    return confirmed;
  }
}
