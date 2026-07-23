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
import type { PreparedWorktreeGuard } from "./prepared-worktree-guard.js";
import type { WorkflowLogger } from "./workflow-logger.js";

type CursorRunStatePort = Pick<
  PublicationStatePort,
  "isCancellationRequested" | "updateAttempt"
>;

const outcomeSchema = z.object({
  status: z.enum(["completed", "blocked", "needs_input"]),
  summary: z.string().min(1).max(8_000),
  reason: z.string().min(1).max(4_000).optional(),
});

function eventSummary(event: { type: string; name?: string; status?: string }): string {
  return [event.type, event.name, event.status].filter(Boolean).join(" ");
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
    const recovered = await this.#recoverDurableOutcome(prepared, attempt);
    if (recovered) return recovered;

    const agent = await this.#createOrResumeAgent(prepared, task, attempt, customTools);
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
      const run = await agent.send(prompt, {
        idempotencyKey: `bridge-attempt:${attempt.id}`,
        ...(attempt.cursorRunId ? { local: { force: true, customTools } } : {}),
      });
      this.#activeRuns.set(attempt.id, run);
      this.#store.updateAttempt(attempt.id, attempt.workerToken, {
        cursorAgentId: agent.agentId,
        cursorRunId: run.id,
        ...(run.requestId ? { cursorRequestId: run.requestId } : {}),
      });
      return await this.#waitForOutcome(run, agent, attempt, () => submitted);
    } finally {
      this.#activeRuns.delete(attempt.id);
      await agent[Symbol.asyncDispose]();
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
    );
    const options = {
      apiKey,
      name: `codex-delegated:${task.id}`,
      model: { id: selected.id },
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

  async #recoverDurableOutcome(
    prepared: PreparedWorktree,
    attempt: Attempt,
  ): Promise<ImplementerOutcome | undefined> {
    if (!attempt.cursorAgentId || !attempt.cursorRunId) return undefined;
    const options = {
      runtime: "local" as const,
      cwd: prepared.worktree,
      store: this.#cursorStore,
    };
    let priorRun: Run;
    try {
      priorRun = await Agent.getRun(attempt.cursorRunId, options);
    } catch (error) {
      const detail = safeErrorMessage(error);
      await this.#logger.log(`Could not safely read prior Cursor run: ${detail}`);
      throw new Error(`Could not safely recover the prior Cursor run: ${detail}`);
    }
    const hasPersistedOutcome = attempt.outcome !== undefined
      && attempt.outcomeSummary !== undefined;
    if (priorRun.status === "running" && hasPersistedOutcome) {
      let cancellationFailure: unknown;
      try {
        await Agent.cancelRun(attempt.cursorRunId, options);
      } catch (error) {
        cancellationFailure = error;
      }
      try {
        priorRun = await Agent.getRun(attempt.cursorRunId, options);
      } catch (error) {
        throw new Error(`Could not confirm the prior Cursor run stopped: ${safeErrorMessage(error)}`);
      }
      if (priorRun.status === "running") {
        const detail = cancellationFailure ? `: ${safeErrorMessage(cancellationFailure)}` : "";
        throw new Error(`Cursor run is still active after restoring its durable outcome${detail}`);
      }
      if (cancellationFailure) {
        await this.#logger.log(
          "Cursor cancellation reported an error, but terminal readback confirmed the run stopped.",
        );
      }
    }
    if (hasPersistedOutcome || priorRun.status === "finished") {
      return {
        status: hasPersistedOutcome ? attempt.outcome ?? "needs_input" : "needs_input",
        agentId: attempt.cursorAgentId,
        runId: attempt.cursorRunId,
        ...(priorRun.requestId ? { requestId: priorRun.requestId } : {}),
        summary: redactSensitiveText(hasPersistedOutcome
          ? attempt.outcomeSummary ?? "Cursor finished without a persisted structured outcome."
          : priorRun.result ?? "Cursor finished without a persisted structured outcome."),
        ...(hasPersistedOutcome
          ? attempt.outcomeReason
            ? { reason: redactSensitiveText(attempt.outcomeReason) }
            : {}
          : { reason: "Cursor finished without submitting a durable structured outcome." }),
        ...(priorRun.usage ? {
          inputTokens: priorRun.usage.inputTokens,
          outputTokens: priorRun.usage.outputTokens,
        } : {}),
      };
    }
    if (priorRun.status === "error" || priorRun.status === "cancelled") {
      throw new Error(priorRun.error?.message ?? `Cursor run ended with ${priorRun.status}`);
    }
    return undefined;
  }

  async #waitForOutcome(
    run: Run,
    agent: SDKAgent,
    attempt: Attempt,
    submitted: () => z.infer<typeof outcomeSchema> | undefined,
  ): Promise<ImplementerOutcome> {
    let cancellationCheckActive = false;
    const cancellationTimer = setInterval(() => {
      if (cancellationCheckActive || !this.#store.isCancellationRequested(this.#jobId)) return;
      cancellationCheckActive = true;
      void run.cancel()
        .catch((error: unknown) =>
          this.#logger.log(`Cursor cancellation failed: ${safeErrorMessage(error)}`))
        .finally(() => {
          cancellationCheckActive = false;
        });
    }, 500);
    cancellationTimer.unref();
    try {
      for await (const event of run.stream()) await this.#logger.log(eventSummary(event));
      const result = await run.wait();
      if (result.status === "cancelled" && this.#store.isCancellationRequested(this.#jobId)) {
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
}
