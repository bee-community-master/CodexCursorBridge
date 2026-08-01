import type { Run, SDKAgent } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import { waitForOutcome } from "../src/adapters/cursor-run-wait.js";
import type { PendingRunEvent, RunEventDeliveryState } from "../src/application/workflow-ports.js";
import { publishingAttempt } from "./helpers/workflow-fixtures.js";

describe("Cursor run event delivery", () => {
  it("retries a transient log failure before returning a terminal outcome", async () => {
    const pending = new Map<string, PendingRunEvent>();
    const logged = new Set<string>();
    const store = {
      isCancellationRequested: (): boolean => false,
      beginRunEvent: (
        _jobId: string,
        _attemptId: string,
        _workerToken: string,
        runId: string,
        eventKey: string,
        eventSummary: string,
      ): RunEventDeliveryState => {
        if (logged.has(eventKey)) return "LOGGED";
        if (pending.has(eventKey)) return "PENDING";
        pending.set(eventKey, { runId, eventKey, eventSummary });
        return "NEW";
      },
      completeRunEvent: (
        _jobId: string,
        _attemptId: string,
        _workerToken: string,
        _runId: string,
        eventKey: string,
      ): void => {
        pending.delete(eventKey);
        logged.add(eventKey);
      },
      listPendingRunEvents: (
        _jobId: string,
        _attemptId: string,
        _workerToken: string,
        runId: string,
      ): PendingRunEvent[] => [...pending.values()].filter((event) => event.runId === runId),
    };
    const run = {
      id: "transient-run",
      status: "running" as const,
      async *stream(): AsyncGenerator<{ type: string; status: string }, void> {
        yield { type: "assistant", status: "running" };
      },
      wait: async () => ({
        status: "finished" as const,
        result: "done",
      }),
    } as unknown as Run;
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorRunId: run.id,
    };
    let failFirst = true;
    const visible: string[] = [];
    const outcome = await waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async () => undefined,
      async (_eventKey, message) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("transient log I/O failure");
        }
        visible.push(message);
      },
    );

    expect(outcome.status).toBe("needs_input");
    expect(visible).toEqual(["assistant running"]);
    expect(pending).toHaveLength(0);
    expect(logged).toHaveLength(1);
  });

  it("does not invoke cancel when a requested cancellation is unsupported", async () => {
    const runCancel = vi.fn(async () => undefined);
    const run = {
      id: "uncancellable-run",
      agentId: "agent",
      status: "running" as const,
      supports: (operation: string): boolean => operation !== "cancel",
      async *stream(): AsyncGenerator<never, void> { /* no events */ },
      wait: async () => ({ status: "finished" as const, result: "done" }),
      cancel: runCancel,
    } as unknown as Run;
    const attempt = { ...publishingAttempt(), status: "IMPLEMENTING" as const };
    const store = {
      isCancellationRequested: (): boolean => true,
      beginRunEvent: (): RunEventDeliveryState => "LOGGED",
      completeRunEvent: (): void => undefined,
      listPendingRunEvents: (): PendingRunEvent[] => [],
    };

    const outcome = await waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async () => undefined,
      async () => undefined,
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/RECOVERY_REQUIRED/);
    expect(runCancel).not.toHaveBeenCalled();
  });

  it("fences a run whose stream capability is unavailable", async () => {
    const runStream = vi.fn();
    const runWait = vi.fn();
    const run = {
      id: "stream-unsupported-run",
      agentId: "agent",
      status: "running" as const,
      supports: (operation: string): boolean => operation !== "stream",
      stream: runStream,
      wait: runWait,
    } as unknown as Run;
    const attempt = { ...publishingAttempt(), status: "IMPLEMENTING" as const };
    const store = {
      isCancellationRequested: (): boolean => false,
      beginRunEvent: (): RunEventDeliveryState => "LOGGED",
      completeRunEvent: (): void => undefined,
      listPendingRunEvents: (): PendingRunEvent[] => [],
    };

    const outcome = await waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async () => undefined,
      async () => undefined,
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/RECOVERY_REQUIRED/);
    expect(runStream).not.toHaveBeenCalled();
    expect(runWait).not.toHaveBeenCalled();
  });

  it("returns one recovery outcome for an uncancellable stream that never yields", async () => {
    const runCancel = vi.fn(async () => undefined);
    const runWait = vi.fn();
    const run = {
      id: "never-ending-uncancellable-run",
      agentId: "agent",
      status: "running" as const,
      supports: (operation: string): boolean => operation !== "cancel",
      async *stream(): AsyncGenerator<never, void> {
        await new Promise<void>(() => undefined);
        if (process.env.NEVER_YIELD) yield undefined as never;
      },
      wait: runWait,
      cancel: runCancel,
    } as unknown as Run;
    const attempt = { ...publishingAttempt(), status: "IMPLEMENTING" as const };
    const store = {
      isCancellationRequested: (): boolean => true,
      beginRunEvent: (): RunEventDeliveryState => "LOGGED",
      completeRunEvent: (): void => undefined,
      listPendingRunEvents: (): PendingRunEvent[] => [],
    };
    const diagnostics: string[] = [];

    const outcome = await waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async (message) => { diagnostics.push(message); },
      async () => undefined,
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/RECOVERY_REQUIRED/);
    expect(runCancel).not.toHaveBeenCalled();
    expect(runWait).not.toHaveBeenCalled();
    expect(diagnostics.filter((message) => message.includes("no cancel mutation"))).toHaveLength(1);
  });

  it("fences after one rejected cancellation without retrying the mutation", async () => {
    const runCancel = vi.fn(async () => {
      throw new Error("transport reset after cancellation request");
    });
    const runWait = vi.fn();
    const run = {
      id: "rejected-cancel-run",
      agentId: "agent",
      status: "running" as const,
      supports: (): boolean => true,
      async *stream(): AsyncGenerator<never, void> {
        await new Promise<void>(() => undefined);
        if (process.env.NEVER_YIELD) yield undefined as never;
      },
      wait: runWait,
      cancel: runCancel,
    } as unknown as Run;
    const attempt = { ...publishingAttempt(), status: "IMPLEMENTING" as const };
    const store = {
      isCancellationRequested: (): boolean => true,
      beginRunEvent: (): RunEventDeliveryState => "LOGGED",
      completeRunEvent: (): void => undefined,
      listPendingRunEvents: (): PendingRunEvent[] => [],
    };
    const diagnostics: string[] = [];

    const outcome = await waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async (message) => { diagnostics.push(message); },
      async () => undefined,
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/CURSOR_TRANSPORT_UNCERTAIN/);
    expect(runCancel).toHaveBeenCalledTimes(1);
    expect(runWait).not.toHaveBeenCalled();
    expect(diagnostics.filter((message) => message.includes("no further cancel mutation"))).toHaveLength(1);
  });

  it("lets a delayed cancellation rejection override an early terminal result", async () => {
    const runCancel = vi.fn(() => new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("late cancellation transport reset")), 150);
    }));
    const run = {
      id: "late-rejected-cancel-run",
      agentId: "agent",
      status: "running" as const,
      supports: (): boolean => true,
      async *stream(): AsyncGenerator<{ type: string }, void> {
        await new Promise((resolve) => setTimeout(resolve, 75));
        yield { type: "assistant" };
      },
      wait: async () => ({ status: "finished" as const, result: "done" }),
      cancel: runCancel,
    } as unknown as Run;
    const attempt = { ...publishingAttempt(), status: "IMPLEMENTING" as const };
    const store = {
      isCancellationRequested: (): boolean => true,
      beginRunEvent: (): RunEventDeliveryState => "LOGGED",
      completeRunEvent: (): void => undefined,
      listPendingRunEvents: (): PendingRunEvent[] => [],
    };

    const outcome = await waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async () => undefined,
      async () => undefined,
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/CURSOR_TRANSPORT_UNCERTAIN/);
    expect(runCancel).toHaveBeenCalledTimes(1);
  });

  it("starts a requested supported cancellation before an immediate terminal result", async () => {
    const runCancel = vi.fn(async () => undefined);
    const run = {
      id: "immediate-cancel-run",
      agentId: "agent",
      status: "running" as const,
      supports: (): boolean => true,
      async *stream(): AsyncGenerator<never, void> { /* no events */ },
      wait: async () => ({ status: "finished" as const, result: "done" }),
      cancel: runCancel,
    } as unknown as Run;
    const attempt = { ...publishingAttempt(), status: "IMPLEMENTING" as const };
    const store = {
      isCancellationRequested: (): boolean => true,
      beginRunEvent: (): RunEventDeliveryState => "LOGGED",
      completeRunEvent: (): void => undefined,
      listPendingRunEvents: (): PendingRunEvent[] => [],
    };

    const outcome = await waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async () => undefined,
      async () => undefined,
    );

    expect(outcome.status).toBe("needs_input");
    expect(runCancel).toHaveBeenCalledTimes(1);
  });

  it("fences a successful cancel when no terminal stream result arrives", async () => {
    const runCancel = vi.fn(async () => undefined);
    const runWait = vi.fn();
    const run = {
      id: "hanging-successful-cancel-run",
      agentId: "agent",
      status: "running" as const,
      supports: (): boolean => true,
      async *stream(): AsyncGenerator<never, void> {
        await new Promise<void>(() => undefined);
        if (process.env.NEVER_YIELD) yield undefined as never;
      },
      wait: runWait,
      cancel: runCancel,
    } as unknown as Run;
    const attempt = { ...publishingAttempt(), status: "IMPLEMENTING" as const };
    const store = {
      isCancellationRequested: (): boolean => true,
      beginRunEvent: (): RunEventDeliveryState => "LOGGED",
      completeRunEvent: (): void => undefined,
      listPendingRunEvents: (): PendingRunEvent[] => [],
    };

    const outcome = await waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async () => undefined,
      async () => undefined,
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/CURSOR_TRANSPORT_UNCERTAIN/);
    expect(runCancel).toHaveBeenCalledTimes(1);
    expect(runWait).not.toHaveBeenCalled();
  });

  it("races an unsupported cancellation recovery against a hanging wait", async () => {
    let cancellationChecks = 0;
    const runWait = vi.fn(() => new Promise<never>(() => undefined));
    const run = {
      id: "unsupported-cancel-hanging-wait-run",
      agentId: "agent",
      status: "running" as const,
      supports: (operation: string): boolean => operation !== "cancel",
      async *stream(): AsyncGenerator<{ type: string }, void> {
        yield { type: "assistant" };
      },
      wait: runWait,
    } as unknown as Run;
    const attempt = { ...publishingAttempt(), status: "IMPLEMENTING" as const };
    const store = {
      isCancellationRequested: (): boolean => {
        cancellationChecks += 1;
        return cancellationChecks > 4;
      },
      beginRunEvent: (): RunEventDeliveryState => "LOGGED",
      completeRunEvent: (): void => undefined,
      listPendingRunEvents: (): PendingRunEvent[] => [],
    };

    const outcome = await waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async () => undefined,
      async () => undefined,
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/RECOVERY_REQUIRED/);
    expect(runWait).toHaveBeenCalledTimes(1);
  });

  it("prioritizes pending delivery uncertainty when stream decoding fails", async () => {
    let pending: PendingRunEvent | undefined;
    let firstLog = true;
    const store = {
      isCancellationRequested: (): boolean => false,
      beginRunEvent: (
        _jobId: string,
        _attemptId: string,
        _workerToken: string,
        runId: string,
        eventKey: string,
        eventSummary: string,
      ): RunEventDeliveryState => {
        if (!pending || pending.eventKey !== eventKey) {
          pending = { runId, eventKey, eventSummary };
          return "NEW";
        }
        return "PENDING";
      },
      completeRunEvent: (): void => { pending = undefined; },
      listPendingRunEvents: (): PendingRunEvent[] => pending ? [pending] : [],
    };
    const run = {
      id: "decode-failure-run",
      agentId: "agent",
      status: "running" as const,
      async *stream(): AsyncGenerator<{ type: string; status: string }, void> {
        yield { type: "assistant", status: "running" };
        throw new Error("stream decode failed");
      },
      wait: vi.fn(),
    } as unknown as Run;
    const attempt = { ...publishingAttempt(), status: "IMPLEMENTING" as const, cursorRunId: run.id };
    const visible: string[] = [];

    await expect(waitForOutcome(
      run,
      { agentId: "agent" } as SDKAgent,
      attempt,
      "job",
      store,
      () => undefined,
      async () => undefined,
      async (_eventKey, message) => {
        if (firstLog) {
          firstLog = false;
          throw new Error("transient log failure");
        }
        visible.push(message);
      },
    )).rejects.toThrow(/stream decode failed/);
    expect(visible).toEqual(["assistant running"]);
    expect(pending).toBeUndefined();
  });
});
