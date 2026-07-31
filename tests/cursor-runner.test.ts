import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, JobStore } from "../src/state.js";
import {
  approvedTask,
  config,
  paths,
  publishingAttempt,
} from "./helpers/workflow-fixtures.js";

const sdkMocks = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  cancelRun: vi.fn(),
  modelsList: vi.fn(),
}));

vi.mock("../src/keychain.js", () => ({
  readCursorApiKey: vi.fn(async () => "cursor-key"),
}));
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: sdkMocks.create,
    resume: sdkMocks.resume,
    getRun: sdkMocks.getRun,
    listRuns: sdkMocks.listRuns,
    cancelRun: sdkMocks.cancelRun,
  },
  Cursor: { models: { list: sdkMocks.modelsList } },
  JsonlLocalAgentStore: class JsonlLocalAgentStore {},
}));

const { RealWorkflowAdapter } = await import("../src/real-adapter.js");

const store = {
  get: vi.fn(() => undefined),
  getAttempt: vi.fn(() => undefined),
  getEffect: vi.fn(() => undefined),
  assertActiveAttempt: vi.fn(),
  beginEffect: vi.fn(),
  completeEffect: vi.fn(),
  update: vi.fn(),
  updateAttempt: vi.fn(),
  isCancellationRequested: vi.fn(() => false),
} as unknown as JobStore;

beforeEach(() => {
  vi.mocked(store.get).mockReset().mockReturnValue(undefined);
  vi.mocked(store.updateAttempt).mockReset();
  vi.mocked(store.isCancellationRequested).mockReset().mockReturnValue(false);
  sdkMocks.create.mockReset().mockRejectedValue(new Error("Unexpected new Cursor agent"));
  sdkMocks.resume.mockReset().mockRejectedValue(new Error("Unexpected Cursor resume"));
  sdkMocks.getRun.mockReset();
  sdkMocks.listRuns.mockReset();
  sdkMocks.cancelRun.mockReset();
  sdkMocks.modelsList.mockReset().mockResolvedValue([{
    id: "grok-4.5",
    displayName: "Grok 4.5",
    variants: [{
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
      displayName: "Grok 4.5 High",
      isDefault: true,
    }],
  }]);
});

describe("Cursor implementer adapter", () => {
  it("does not start a duplicate run when a finished run lacks a persisted outcome", async () => {
    sdkMocks.getRun.mockResolvedValue({
      id: "run",
      agentId: "agent",
      status: "finished",
      requestId: "request",
      result: "Implementation finished without submitting the outcome tool.",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt);

    expect(outcome).toMatchObject({
      status: "needs_input",
      agentId: "agent",
      runId: "run",
      requestId: "request",
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(outcome.summary).toMatch(/finished without submitting/i);
    expect(sdkMocks.create).not.toHaveBeenCalled();
    expect(sdkMocks.resume).not.toHaveBeenCalled();
  });

  it("stops a lingering run and restores its already persisted structured outcome", async () => {
    sdkMocks.getRun
      .mockResolvedValueOnce({
        id: "run",
        agentId: "agent",
        status: "running",
      })
      .mockResolvedValueOnce({
        id: "run",
        agentId: "agent",
        status: "cancelled",
        requestId: "request",
        usage: { inputTokens: 10, outputTokens: 20 },
      });
    sdkMocks.cancelRun.mockResolvedValue(undefined);
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
      outcome: "completed" as const,
      outcomeSummary: "Persisted final outcome",
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt);

    expect(outcome).toMatchObject({
      status: "completed",
      summary: "Persisted final outcome",
      agentId: "agent",
      runId: "run",
      requestId: "request",
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(sdkMocks.cancelRun).toHaveBeenCalledOnce();
    expect(sdkMocks.resume).not.toHaveBeenCalled();
    expect(sdkMocks.create).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous durable-outcome cancellation after terminal readback", async () => {
    sdkMocks.getRun
      .mockResolvedValueOnce({
        id: "run",
        agentId: "agent",
        status: "running",
      })
      .mockResolvedValueOnce({
        id: "run",
        agentId: "agent",
        status: "finished",
        result: "done",
      });
    sdkMocks.cancelRun.mockRejectedValue(new Error("connection closed after cancellation"));
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
      outcome: "completed" as const,
      outcomeSummary: "Persisted final outcome",
    };

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt)).resolves.toMatchObject({
      status: "completed",
      summary: "Persisted final outcome",
    });
    expect(sdkMocks.getRun).toHaveBeenCalledTimes(2);
    expect(sdkMocks.resume).not.toHaveBeenCalled();
  });

  it("rebinds and monitors a known active run without force-expiring it", async () => {
    const activeRun = {
      id: "run-active",
      agentId: "agent",
      status: "running" as const,
      async *stream(): AsyncGenerator<never, void> { /* No events. */ },
      wait: vi.fn(async () => ({
        id: "run-active",
        agentId: "agent",
        status: "finished" as const,
        result: "done",
      })),
    };
    const send = vi.fn();
    sdkMocks.getRun.mockResolvedValue(activeRun);
    sdkMocks.resume.mockResolvedValue({
      agentId: "agent",
      send,
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run-active",
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt);

    expect(outcome).toMatchObject({
      status: "needs_input",
      agentId: "agent",
      runId: "run-active",
    });
    expect(send).not.toHaveBeenCalled();
    expect(sdkMocks.getRun).toHaveBeenCalledOnce();
  });

  it("rebinds a newer active run after a legacy force_send terminal marker", async () => {
    const activeRun = {
      id: "replacement-run",
      agentId: "agent",
      status: "running" as const,
      createdAt: 200,
      async *stream(): AsyncGenerator<never, void> { /* No events. */ },
      wait: vi.fn(async () => ({
        id: "replacement-run",
        agentId: "agent",
        status: "finished" as const,
        result: "done",
      })),
    };
    const olderRun = {
      ...activeRun,
      id: "older-run",
      createdAt: 100,
    };
    const send = vi.fn();
    sdkMocks.getRun.mockResolvedValue({
      id: "expired-run",
      agentId: "agent",
      status: "error",
      error: { message: "force_send" },
    });
    sdkMocks.listRuns.mockResolvedValue({ items: [olderRun, activeRun] });
    sdkMocks.resume.mockResolvedValue({
      agentId: "agent",
      send,
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "expired-run",
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt);

    expect(outcome.runId).toBe("replacement-run");
    expect(send).not.toHaveBeenCalled();
    expect(store.updateAttempt).toHaveBeenCalledWith(
      attempt.id,
      attempt.workerToken,
      expect.objectContaining({ cursorRunId: "replacement-run" }),
    );
  });

  it("finds an orphan active local run and atomically rebinds the attempt before monitoring", async () => {
    const activeRun = {
      id: "orphan-run",
      agentId: "agent",
      status: "running" as const,
      async *stream(): AsyncGenerator<never, void> { /* No events. */ },
      wait: vi.fn(async () => ({
        id: "orphan-run",
        agentId: "agent",
        status: "finished" as const,
        result: "done",
      })),
    };
    const send = vi.fn();
    sdkMocks.listRuns.mockResolvedValue({ items: [activeRun] });
    sdkMocks.resume.mockResolvedValue({
      agentId: "agent",
      send,
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt);

    expect(outcome.runId).toBe("orphan-run");
    expect(send).not.toHaveBeenCalled();
    expect(store.updateAttempt).toHaveBeenCalledWith(
      attempt.id,
      attempt.workerToken,
      expect.objectContaining({ cursorAgentId: "agent", cursorRunId: "orphan-run" }),
    );
  });

  it("reconciles a transient send failure to the active follow-up instead of creating a duplicate", async () => {
    const activeRun = {
      id: "follow-up-run",
      agentId: "agent",
      status: "running" as const,
      async *stream(): AsyncGenerator<never, void> { /* No events. */ },
      wait: vi.fn(async () => ({
        id: "follow-up-run",
        agentId: "agent",
        status: "finished" as const,
        result: "done",
      })),
    };
    type TestSendOptions = {
      local?: { force?: boolean; customTools?: Record<string, unknown> };
    };
    const send = vi.fn<(prompt: string, options: TestSendOptions) => Promise<unknown>>()
      .mockRejectedValue(new Error("ConnectError: 503 Service Unavailable"));
    sdkMocks.create.mockResolvedValue({
      agentId: "agent",
      send,
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    });
    sdkMocks.listRuns.mockResolvedValue({ items: [activeRun] });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt);

    expect(outcome.runId).toBe("follow-up-run");
    expect(send).toHaveBeenCalledOnce();
    const options = send.mock.calls[0]?.[1];
    expect(options?.local?.customTools).toBeDefined();
    expect(options?.local?.force).toBeUndefined();
  });

  it("leaves an exhausted ambiguous send uncertain for supervisor recovery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-missing-log-"));
    vi.mocked(store.get).mockReturnValue({
      logPath: path.join(directory, "missing", "job.log"),
    } as Job);
    const send = vi.fn().mockRejectedValue(new Error("ConnectError: 503 Service Unavailable"));
    sdkMocks.create.mockResolvedValue({
      agentId: "agent",
      send,
      [Symbol.asyncDispose]: vi.fn().mockRejectedValue(new Error("executor dispose failed")),
    });
    sdkMocks.listRuns.mockResolvedValue({ items: [] });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
    })).rejects.toThrow(/CURSOR_TRANSPORT_UNCERTAIN/);

    expect(send).toHaveBeenCalledTimes(3);
  });

  it("preserves a successful outcome when Cursor agent disposal fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-dispose-"));
    const logPath = path.join(directory, "job.log");
    vi.mocked(store.get).mockReturnValue({ logPath } as Job);
    const dispose = vi.fn().mockRejectedValue(new Error("executor dispose failed API_KEY=secret"));
    const run = {
      id: "run",
      agentId: "agent",
      status: "running" as const,
      async *stream(): AsyncGenerator<never, void> { /* No events. */ },
      wait: vi.fn(async () => ({
        id: "run",
        agentId: "agent",
        status: "finished" as const,
        result: "done",
      })),
    };
    sdkMocks.create.mockResolvedValue({
      agentId: "agent",
      send: vi.fn(async () => run),
      [Symbol.asyncDispose]: dispose,
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
    })).resolves.toMatchObject({
      status: "needs_input",
      runId: "run",
    });

    expect(dispose).toHaveBeenCalledOnce();
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("Cursor agent disposal failed");
    expect(log).toContain("API_KEY=[REDACTED]");
    expect(log).not.toContain("API_KEY=secret");
  });

  it("preserves an active run outcome when event logging fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-missing-event-log-"));
    vi.mocked(store.get).mockReturnValue({
      logPath: path.join(directory, "missing", "job.log"),
    } as Job);
    const activeRun = {
      id: "active-run",
      agentId: "agent",
      status: "running" as const,
      async *stream(): AsyncGenerator<{ type: string; name: string }, void> {
        yield { type: "assistant", name: "message" };
      },
      wait: vi.fn(async () => ({
        id: "active-run",
        agentId: "agent",
        status: "finished" as const,
        result: "done",
      })),
    };
    const send = vi.fn();
    sdkMocks.getRun.mockResolvedValue(activeRun);
    sdkMocks.resume.mockResolvedValue({
      agentId: "agent",
      send,
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "active-run",
    })).resolves.toMatchObject({
      status: "needs_input",
      runId: "active-run",
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("restores a terminal Cursor error instead of starting a follow-up run", async () => {
    sdkMocks.getRun.mockResolvedValue({
      id: "run",
      agentId: "agent",
      status: "error",
      error: { message: "Cursor model failed" },
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
    };

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt)).rejects.toThrow(/model failed/i);
    expect(sdkMocks.create).not.toHaveBeenCalled();
    expect(sdkMocks.resume).not.toHaveBeenCalled();
  });

  it("fails closed when the prior run cannot be read instead of forcing a duplicate", async () => {
    sdkMocks.getRun.mockRejectedValue(new Error("local run store is temporarily unavailable"));
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
    };

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt)).rejects.toThrow(/safely recover/i);

    expect(sdkMocks.resume).not.toHaveBeenCalled();
    expect(sdkMocks.create).not.toHaveBeenCalled();
  });

  it("creates diagnostic logs with owner-only permissions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-log-"));
    const logPath = path.join(directory, "job.log");
    vi.mocked(store.get).mockReturnValue({ logPath } as Job);
    sdkMocks.getRun.mockRejectedValue(new Error("local run store is unavailable"));
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
      cursorAgentId: "agent",
      cursorRunId: "run",
    };

    await expect(adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt)).rejects.toThrow(/safely recover/i);

    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });

  it("redacts a structured Cursor outcome before persisting it", async () => {
    const dispose = vi.fn(async () => undefined);
    sdkMocks.create.mockImplementation(async (options: {
      model?: { id: string; params?: Array<{ id: string; value: string }> };
      local?: {
        customTools?: Record<string, { execute: (args: Record<string, string>) => unknown }>;
        settingSources?: string[];
        sandboxOptions?: { enabled: boolean };
      };
    }) => {
      expect(options.model).toEqual({
        id: "grok-4.5",
        params: [
          { id: "effort", value: "high" },
          { id: "fast", value: "false" },
        ],
      });
      expect(options.local).toMatchObject({
        settingSources: [],
        sandboxOptions: { enabled: true },
      });
      const submit = options.local?.customTools?.submit_bridge_outcome;
      return {
        agentId: "agent",
        send: vi.fn(async () => {
          submit?.execute({
            status: "completed",
            summary: "Implemented with token: abcdefghijklmnopqrstuvwxyz",
          });
          return {
            id: "run",
            agentId: "agent",
            status: "running",
            async *stream(): AsyncGenerator<never, void> { /* No events. */ },
            wait: vi.fn(async () => ({
              id: "run",
              agentId: "agent",
              status: "finished",
              result: "done",
            })),
          };
        }),
        [Symbol.asyncDispose]: dispose,
      };
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");
    const attempt = {
      ...publishingAttempt(),
      status: "IMPLEMENTING" as const,
    };

    const outcome = await adapter.runImplementer({
      worktree: "/worktree",
      baseSha: "b".repeat(40),
      pushBranch: "branch",
      localBranch: "branch",
    }, approvedTask({ mode: "new_draft" }), attempt);

    expect(outcome.summary).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(store.updateAttempt).toHaveBeenCalledWith(
      attempt.id,
      attempt.workerToken,
      expect.objectContaining({ outcomeSummary: "Implemented with token: [REDACTED]" }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not confirm cancellation while the persisted Cursor run is still active", async () => {
    sdkMocks.cancelRun.mockResolvedValue(undefined);
    sdkMocks.getRun.mockResolvedValue({
      id: "run",
      agentId: "agent",
      status: "running",
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await expect(adapter.cancel({
      ...publishingAttempt(),
      status: "IMPLEMENTING",
      cursorAgentId: "agent",
      cursorRunId: "run",
      worktree: "/worktree",
    })).rejects.toThrow(/still active/i);
  });

  it("treats an already terminal persisted run as stopped without cancelling it again", async () => {
    sdkMocks.getRun.mockResolvedValue({
      id: "run",
      agentId: "agent",
      status: "finished",
    });
    const adapter = new RealWorkflowAdapter(paths, config, store, "job");

    await adapter.cancel({
      ...publishingAttempt(),
      status: "VERIFYING",
      cursorAgentId: "agent",
      cursorRunId: "run",
      worktree: "/worktree",
    });

    expect(sdkMocks.cancelRun).not.toHaveBeenCalled();
  });
});
