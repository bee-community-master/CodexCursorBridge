import type { Run, SDKAgent } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
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
});
