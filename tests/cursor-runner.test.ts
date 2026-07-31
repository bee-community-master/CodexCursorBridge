import { mkdtemp, stat } from "node:fs/promises";
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
