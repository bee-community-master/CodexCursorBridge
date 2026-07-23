import {
  Agent,
  Cursor,
  JsonlLocalAgentStore,
  type Run,
  type SDKAgent,
  type SDKCustomTool,
  type SDKJsonValue,
} from "@cursor/sdk";
import { access, appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import type { MachineConfig, RepositoryConfig, RuntimePaths } from "./config.js";
import {
  assertGitHubRemote,
  assertWorktreeIdentity,
  captureWorktreeIdentity,
  collectChanges,
  collectTreeChanges,
  computeCandidateTree,
  git,
  runFile,
} from "./git.js";
import { readCursorApiKey } from "./keychain.js";
import { chooseConfiguredGrok } from "./model.js";
import {
  redactSensitiveText as redact,
  safeErrorMessage as errorOutput,
} from "./redaction.js";
import { createVerificationSandbox } from "./sandbox.js";
import type { Attempt, JobStore } from "./state.js";
import type { ApprovedTask } from "./task.js";
import type {
  AttestationData,
  ImplementerOutcome,
  PreparedWorktree,
  PublicationInput,
  PublicationResult,
  VerificationResult,
  WorkflowAdapter,
  WorkflowReportData,
} from "./workflow.js";

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function eventSummary(event: { type: string; name?: string; status?: string }): string {
  return [event.type, event.name, event.status].filter(Boolean).join(" ");
}

const outcomeSchema = z.object({
  status: z.enum(["completed", "blocked", "needs_input"]),
  summary: z.string().min(1).max(8_000),
  reason: z.string().min(1).max(4_000).optional(),
});

interface PullRequestInfo {
  state: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string;
  headRepository: { nameWithOwner: string };
  url: string;
  isDraft?: boolean;
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

function branchNames(task: ApprovedTask, jobId: string, existingHead?: string): {
  pushBranch: string;
  localBranch: string;
} {
  const suffix = `${task.id.toLowerCase()}-${slug(task.title)}-v${task.spec_version}-${jobId.slice(0, 8)}`;
  const pushBranch = task.pull_request.mode === "new_draft"
    ? `codex/cursor/${suffix}`
    : existingHead ?? "";
  if (!pushBranch) throw new Error("Existing PR head branch is missing");
  return {
    pushBranch,
    localBranch: task.pull_request.mode === "new_draft"
      ? pushBranch
      : `codex/cursor/${task.id.toLowerCase()}-followup-${jobId.slice(0, 8)}`,
  };
}

export class RealWorkflowAdapter implements WorkflowAdapter {
  readonly #paths: RuntimePaths;
  readonly #config: MachineConfig;
  readonly #store: JobStore;
  readonly #jobId: string;
  readonly #cursorStore: JsonlLocalAgentStore;
  readonly #activeRuns = new Map<string, Run>();

  constructor(paths: RuntimePaths, config: MachineConfig, store: JobStore, jobId: string) {
    this.#paths = paths;
    this.#config = config;
    this.#store = store;
    this.#jobId = jobId;
    this.#cursorStore = new JsonlLocalAgentStore(path.join(paths.home, "cursor-sdk"));
  }

  async #log(message: string): Promise<void> {
    const job = this.#store.get(this.#jobId);
    if (job?.logPath) {
      await appendFile(
        job.logPath,
        `[${new Date().toISOString()}] ${redact(message)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await chmod(job.logPath, 0o600);
    }
  }

  async #existingPullRequest(task: ApprovedTask, repository: RepositoryConfig): Promise<PullRequestInfo | undefined> {
    if (task.pull_request.mode !== "existing_pr") return undefined;
    const output = await runFile("gh", [
      "pr",
      "view",
      String(task.pull_request.number),
      "--repo",
      repository.origin,
      "--json",
      "state,baseRefName,headRefName,headRefOid,headRepository,url,isDraft",
    ]);
    const info = JSON.parse(output.stdout) as PullRequestInfo;
    if (info.state !== "OPEN") throw new Error(`Existing PR is not open: #${task.pull_request.number}`);
    if (info.headRepository.nameWithOwner !== repository.origin) {
      throw new Error("Existing PR head is in a fork and cannot be updated safely");
    }
    if (!info.isDraft) throw new Error("Existing pull request must remain a draft");
    if (info.headRefName !== task.target.base_ref) {
      throw new Error("STALE_SPEC: existing PR head branch changed after task approval");
    }
    if (info.baseRefName !== task.target.destination_ref) {
      throw new Error("STALE_SPEC: existing PR destination branch changed after task approval");
    }
    return info;
  }

  #hasDurableEffect(kind: string, idempotencyKey: string): boolean {
    const effect = this.#store.getEffect(idempotencyKey);
    return effect !== undefined
      && effect.jobId === this.#jobId
      && effect.kind === kind
      && effect.status !== "FAILED";
  }

  async #assertDirectChildOfApprovedBase(
    worktree: string,
    headSha: string,
    approvedBaseSha: string,
  ): Promise<void> {
    const commit = await git(
      worktree,
      "cat-file",
      "-p",
      headSha,
    );
    const header = commit.split("\n\n", 1)[0] ?? "";
    const parents = header
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice("parent ".length));
    if (
      parents.length !== 1
      || parents[0] !== approvedBaseSha
    ) {
      throw new Error(
        "Bridge publication commit is not a direct child of the approved base",
      );
    }
  }

  async #isBridgeOwnedHead(
    worktree: string,
    headSha: string,
    approvedBaseSha: string,
  ): Promise<boolean> {
    const treeHash = await git(worktree, "rev-parse", "HEAD^{tree}");
    const effect = this.#store.getEffect(`commit:${this.#jobId}:${treeHash}`);
    const checkpointMatches = effect !== undefined
      && effect.jobId === this.#jobId
      && effect.kind === "git_commit"
      && effect.status !== "FAILED"
      && (
        effect.status !== "COMPLETED"
        || effect.payload?.headSha === undefined
        || effect.payload.headSha === headSha
      );
    if (!checkpointMatches) return false;
    await this.#assertDirectChildOfApprovedBase(
      worktree,
      headSha,
      approvedBaseSha,
    );
    return true;
  }

  async #assertPreparedHead(
    worktree: string,
    approvedBaseSha: string,
  ): Promise<void> {
    const currentHead = await git(worktree, "rev-parse", "HEAD");
    if (
      currentHead !== approvedBaseSha
      && !await this.#isBridgeOwnedHead(
        worktree,
        currentHead,
        approvedBaseSha,
      )
    ) {
      throw new Error("STALE_SPEC: prepared worktree HEAD is not the approved base or a Bridge commit");
    }
  }

  #assertPublicationLease(attempt: Attempt): void {
    this.#store.assertActiveAttempt(
      this.#jobId,
      attempt.id,
      attempt.workerToken,
      "PUBLISHING",
    );
  }

  async #assertPreparedWorktree(prepared: PreparedWorktree): Promise<void> {
    if (prepared.gitIdentity) {
      await assertWorktreeIdentity(prepared.worktree, prepared.gitIdentity);
      const currentBranch = await git(
        prepared.worktree,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      );
      if (currentBranch !== prepared.localBranch) {
        throw new Error("Prepared worktree branch changed after preparation");
      }
    }
  }

  async prepare(
    job: { id: string },
    task: ApprovedTask,
    repository: RepositoryConfig,
  ): Promise<PreparedWorktree> {
    const worktree = path.join(this.#paths.worktreesDir, task.repository, job.id);
    await mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
    let existingWorktree = false;
    try {
      await access(worktree);
      existingWorktree = true;
    } catch {
      // The first execution has no durable worktree yet.
    }
    let existingGitIdentity: Awaited<ReturnType<typeof captureWorktreeIdentity>> | undefined;
    if (existingWorktree) {
      this.#store.update(this.#jobId, {
        worktree,
        baseSha: task.target.base_sha,
      });
      existingGitIdentity = await captureWorktreeIdentity(worktree, repository.root);
      const currentJob = this.#store.get(this.#jobId);
      const currentAttempt = currentJob?.currentAttemptId
        ? this.#store.getAttempt(currentJob.currentAttemptId)
        : undefined;
      if (
        currentAttempt?.gitConfigDigest
        && currentAttempt.gitConfigDigest !== existingGitIdentity.configDigest
      ) {
        throw new Error(
          "STALE_SPEC: prepared worktree Git configuration identity changed",
        );
      }
      if (
        currentAttempt
        && currentAttempt.status !== "PREPARING"
        && !currentAttempt.gitConfigDigest
      ) {
        throw new Error(
          "STALE_SPEC: prepared worktree Git configuration identity is missing",
        );
      }
    }

    await git(repository.root, "fetch", "--prune", "origin");
    const existingPr = await this.#existingPullRequest(task, repository);
    const names = branchNames(task, job.id, existingPr?.headRefName);
    if (
      existingPr?.headRefOid
      && existingPr.headRefOid !== task.target.base_sha
      && !this.#hasDurableEffect(
        "git_push",
        `push:${this.#jobId}:${names.pushBranch}:${existingPr.headRefOid}`,
      )
    ) {
      throw new Error("STALE_SPEC: existing PR head changed after task approval");
    }

    if (existingGitIdentity) {
      await assertWorktreeIdentity(worktree, existingGitIdentity);
      await this.#assertPreparedHead(worktree, task.target.base_sha);
      return {
        worktree,
        baseSha: task.target.base_sha,
        pushBranch: names.pushBranch,
        localBranch: names.localBranch,
        gitIdentity: existingGitIdentity,
      };
    }

    let localBranchExists = false;
    try {
      await git(repository.root, "show-ref", "--verify", `refs/heads/${names.localBranch}`);
      localBranchExists = true;
    } catch {
      // A new job normally has no local branch yet.
    }
    if (localBranchExists) {
      await git(
        repository.root,
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        worktree,
        names.localBranch,
      );
    } else {
      await git(
        repository.root,
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "-b",
        names.localBranch,
        worktree,
        task.target.base_sha,
      );
    }
    this.#store.update(this.#jobId, {
      worktree,
      baseSha: task.target.base_sha,
    });
    const gitIdentity = await captureWorktreeIdentity(worktree, repository.root);
    await this.#assertPreparedHead(worktree, task.target.base_sha);
    await this.#log(`Prepared worktree ${worktree} from ${task.target.base_sha}`);
    return { worktree, baseSha: task.target.base_sha, gitIdentity, ...names };
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

  async runImplementer(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    attempt: Attempt,
    repairFeedback?: string,
  ): Promise<ImplementerOutcome> {
    await this.#assertPreparedWorktree(prepared);
    let submitted: z.infer<typeof outcomeSchema> | undefined;
    const customTools = {
      submit_bridge_outcome: outputTool((outcome) => {
        if (submitted) throw new Error("submit_bridge_outcome may only be called once");
        submitted = {
          ...outcome,
          summary: redact(outcome.summary),
          ...(outcome.reason ? { reason: redact(outcome.reason) } : {}),
        };
        this.#store.updateAttempt(attempt.id, attempt.workerToken, {
          outcome: submitted.status,
          outcomeSummary: submitted.summary,
          ...(submitted.reason ? { outcomeReason: submitted.reason } : {}),
        });
      }),
    };
    if (attempt.cursorAgentId && attempt.cursorRunId) {
      const priorRunOptions = {
        runtime: "local" as const,
        cwd: prepared.worktree,
        store: this.#cursorStore,
      };
      let priorRun: Run | undefined;
      try {
        priorRun = await Agent.getRun(attempt.cursorRunId, priorRunOptions);
      } catch (error) {
        const detail = errorOutput(error);
        await this.#log(`Could not safely read prior Cursor run: ${detail}`);
        throw new Error(`Could not safely recover the prior Cursor run: ${detail}`);
      }
      const hasPersistedOutcome = attempt.outcome !== undefined
        && attempt.outcomeSummary !== undefined;
      if (priorRun?.status === "running" && hasPersistedOutcome) {
        let cancellationFailure: unknown;
        try {
          await Agent.cancelRun(attempt.cursorRunId, priorRunOptions);
        } catch (error) {
          cancellationFailure = error;
        }
        try {
          priorRun = await Agent.getRun(attempt.cursorRunId, priorRunOptions);
        } catch (error) {
          const detail = errorOutput(error);
          throw new Error(`Could not confirm the prior Cursor run stopped: ${detail}`);
        }
        if (priorRun.status === "running") {
          const detail = cancellationFailure
            ? `: ${errorOutput(cancellationFailure)}`
            : "";
          throw new Error(`Cursor run is still active after restoring its durable outcome${detail}`);
        }
        if (cancellationFailure) {
          await this.#log(
            "Cursor cancellation reported an error, but terminal readback confirmed the run stopped.",
          );
        }
      }
      if (hasPersistedOutcome || priorRun?.status === "finished") {
        return {
          status: hasPersistedOutcome ? attempt.outcome ?? "needs_input" : "needs_input",
          agentId: attempt.cursorAgentId,
          runId: attempt.cursorRunId,
          ...(priorRun.requestId ? { requestId: priorRun.requestId } : {}),
          summary: redact(hasPersistedOutcome
            ? attempt.outcomeSummary ?? "Cursor finished without a persisted structured outcome."
            : priorRun.result ?? "Cursor finished without a persisted structured outcome."),
          ...(hasPersistedOutcome
            ? attempt.outcomeReason
              ? { reason: redact(attempt.outcomeReason) }
              : {}
            : {
              reason: "Cursor finished without submitting a durable structured outcome.",
            }),
          ...(priorRun.usage ? {
            inputTokens: priorRun.usage.inputTokens,
            outputTokens: priorRun.usage.outputTokens,
          } : {}),
        };
      }
      if (priorRun?.status === "error" || priorRun?.status === "cancelled") {
        throw new Error(
          priorRun.error?.message ?? `Cursor run ended with ${priorRun.status}`,
        );
      }
    }
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

      let cancellationCheckActive = false;
      const cancellationTimer = setInterval(() => {
        if (cancellationCheckActive || !this.#store.isCancellationRequested(this.#jobId)) return;
        cancellationCheckActive = true;
        void run.cancel()
          .catch((error: unknown) => this.#log(`Cursor cancellation failed: ${errorOutput(error)}`))
          .finally(() => {
            cancellationCheckActive = false;
          });
      }, 500);
      cancellationTimer.unref();
      try {
        for await (const event of run.stream()) await this.#log(eventSummary(event));
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
        const structured = submitted ?? {
          status: "needs_input" as const,
          summary: redact(result.result ?? "Cursor did not submit a structured outcome."),
          reason: "Cursor completed without calling submit_bridge_outcome.",
        };
        return {
          status: structured.status,
          agentId: agent.agentId,
          runId: run.id,
          ...(result.requestId ? { requestId: result.requestId } : {}),
          summary: redact(structured.summary),
          ...(structured.reason ? { reason: redact(structured.reason) } : {}),
          ...(result.usage ? {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          } : {}),
        };
      } finally {
        clearInterval(cancellationTimer);
      }
    } finally {
      this.#activeRuns.delete(attempt.id);
      await agent[Symbol.asyncDispose]();
    }
  }

  async collectChanges(
    prepared: PreparedWorktree,
    candidate?: Awaited<ReturnType<typeof computeCandidateTree>>,
  ): Promise<Awaited<ReturnType<typeof collectChanges>>> {
    await this.#assertPreparedWorktree(prepared);
    return candidate
      ? collectTreeChanges(prepared.worktree, prepared.baseSha, candidate.treeHash)
      : collectChanges(prepared.worktree, prepared.baseSha);
  }

  async runVerification(
    prepared: PreparedWorktree,
    task: ApprovedTask,
  ): Promise<VerificationResult[]> {
    await this.#assertPreparedWorktree(prepared);
    const results: VerificationResult[] = [];
    await mkdir(this.#paths.home, { recursive: true, mode: 0o700 });
    for (const item of task.verification.commands) {
      const scratch = await mkdtemp(path.join(this.#paths.home, "verify-"));
      await mkdir(path.join(scratch, "home"), { recursive: true, mode: 0o700 });
      await mkdir(path.join(scratch, "tmp"), { recursive: true, mode: 0o700 });
      const invocation = createVerificationSandbox({
        worktree: prepared.worktree,
        scratchDir: scratch,
        command: item.command,
        args: item.args,
        ...(item.env ? { taskEnv: item.env } : {}),
      });
      const started = Date.now();
      const controller = new AbortController();
      const cancellationTimer = setInterval(() => {
        if (this.#store.isCancellationRequested(this.#jobId)) controller.abort();
      }, 250);
      cancellationTimer.unref();
      try {
        await runFile(invocation.command, invocation.args, {
          cwd: prepared.worktree,
          env: invocation.env,
          timeoutMs: item.timeout_seconds * 1000,
          signal: controller.signal,
        });
        await this.#log(`Verification passed: ${item.command} ${item.args.join(" ")}`);
        results.push({
          command: [item.command, ...item.args].join(" "),
          status: "passed",
          durationMs: Date.now() - started,
        });
      } catch (error) {
        const output = errorOutput(error);
        await this.#log(`Verification failed: ${item.command} ${item.args.join(" ")}`);
        results.push({
          command: [item.command, ...item.args].join(" "),
          status: "failed",
          durationMs: Date.now() - started,
          output,
        });
        break;
      } finally {
        clearInterval(cancellationTimer);
        await rm(scratch, { recursive: true, force: true });
      }
    }
    return results;
  }

  async computeCandidateTree(prepared: PreparedWorktree): Promise<Awaited<ReturnType<typeof computeCandidateTree>>> {
    await this.#assertPreparedWorktree(prepared);
    const candidate = await computeCandidateTree(prepared.worktree, prepared.baseSha);
    const currentHead = await git(prepared.worktree, "rev-parse", "HEAD");
    if (currentHead !== prepared.baseSha) {
      if (!await this.#isBridgeOwnedHead(
        prepared.worktree,
        currentHead,
        prepared.baseSha,
      )) {
        throw new Error("Implementer changed HEAD; only bridge-owned commits may be published");
      }
    }
    return candidate;
  }

  async #commitCandidate(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    input: PublicationInput,
    attempt: Attempt,
  ): Promise<string> {
    await this.#assertPreparedWorktree(prepared);
    this.#assertPublicationLease(attempt);
    const key = `commit:${this.#jobId}:${input.tree.treeHash}`;
    const effect = this.#store.beginEffect(this.#jobId, attempt.id, "git_commit", key);
    const currentTree = await git(prepared.worktree, "rev-parse", "HEAD^{tree}");
    let headSha: string;
    if (currentTree === input.tree.treeHash) {
      headSha = await git(prepared.worktree, "rev-parse", "HEAD");
    } else {
      await git(prepared.worktree, "read-tree", input.tree.treeHash);
      const stagedTree = await git(prepared.worktree, "write-tree");
      if (stagedTree !== input.tree.treeHash) {
        throw new Error("Candidate tree changed between attestation and commit");
      }
      await git(
        prepared.worktree,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Codex Cursor Bridge",
        "-c",
        "user.email=codex-cursor-bridge@example.invalid",
        "commit",
        "--no-gpg-sign",
        "-m",
        `chore(cursor): ${task.title}`,
      );
      headSha = await git(prepared.worktree, "rev-parse", "HEAD");
    }
    const committedTree = await git(prepared.worktree, "rev-parse", "HEAD^{tree}");
    if (committedTree !== input.tree.treeHash) {
      throw new Error("Committed tree does not match the attested candidate");
    }
    await this.#assertDirectChildOfApprovedBase(
      prepared.worktree,
      headSha,
      prepared.baseSha,
    );
    if (
      effect.status === "COMPLETED"
      && effect.payload?.headSha
      && effect.payload.headSha !== headSha
    ) {
      throw new Error("Completed commit checkpoint does not match local HEAD");
    }
    if (effect.status !== "COMPLETED") {
      this.#store.completeEffect(effect.id, { headSha, treeHash: input.tree.treeHash });
    }
    return headSha;
  }

  async #pushCandidate(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    headSha: string,
    attempt: Attempt,
  ): Promise<string> {
    await this.#assertPreparedWorktree(prepared);
    this.#assertPublicationLease(attempt);
    await assertGitHubRemote(prepared.worktree, task.target.origin);
    const key = `push:${this.#jobId}:${prepared.pushBranch}:${headSha}`;
    const effect = this.#store.beginEffect(this.#jobId, attempt.id, "git_push", key);
    const remoteBefore = await git(
      prepared.worktree,
      "ls-remote",
      "origin",
      `refs/heads/${prepared.pushBranch}`,
    );
    const existingSha = remoteBefore.split(/\s+/)[0] ?? "";
    const approvedRemoteSha = task.pull_request.mode === "existing_pr"
      ? task.target.base_sha
      : "";
    if (existingSha !== headSha && existingSha !== approvedRemoteSha) {
      throw new Error("STALE_SPEC: remote head changed after task approval");
    }
    let pushFailure: unknown;
    if (existingSha !== headSha) {
      try {
        await git(
          prepared.worktree,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "push.gpgSign=false",
          "push",
          `--force-with-lease=refs/heads/${prepared.pushBranch}:${approvedRemoteSha}`,
          "origin",
          `${headSha}:refs/heads/${prepared.pushBranch}`,
        );
      } catch (error) {
        pushFailure = error;
      }
    }
    const remoteAfter = await git(
      prepared.worktree,
      "ls-remote",
      "origin",
      `refs/heads/${prepared.pushBranch}`,
    );
    const remoteHeadSha = remoteAfter.split(/\s+/)[0] ?? "";
    if (remoteHeadSha !== headSha) {
      if (pushFailure) {
        throw new Error(`Git push failed and remote readback did not contain the candidate: ${errorOutput(pushFailure)}`);
      }
      throw new Error("Remote branch readback does not match local HEAD");
    }
    if (pushFailure) {
      await this.#log("Git push reported an error, but exact remote readback confirmed the candidate.");
    }
    if (effect.status !== "COMPLETED") {
      this.#store.completeEffect(effect.id, { headSha, remoteHeadSha });
    }
    return remoteHeadSha;
  }

  async #ensurePullRequest(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    repository: RepositoryConfig,
    input: PublicationInput,
    attempt: Attempt,
  ): Promise<{ url: string; isDraft: boolean; headRefOid: string }> {
    this.#assertPublicationLease(attempt);
    const key = `pull_request:${this.#jobId}:${prepared.pushBranch}`;
    const effect = this.#store.beginEffect(this.#jobId, attempt.id, "pull_request", key);
    let prUrl: string;
    if (task.pull_request.mode === "existing_pr") {
      const existing = await this.#existingPullRequest(task, repository);
      if (!existing) throw new Error("Existing pull request disappeared");
      prUrl = existing.url;
    } else {
      const findOpenPullRequest = async (): Promise<string | undefined> => {
        const listed = await runFile("gh", [
          "pr",
          "list",
          "--repo",
          repository.origin,
          "--state",
          "open",
          "--head",
          prepared.pushBranch,
          "--json",
          "url",
        ]);
        const open = JSON.parse(listed.stdout) as Array<{ url: string }>;
        return open[0]?.url;
      };
      const open = await findOpenPullRequest();
      if (open) {
        prUrl = open;
      } else {
        const bodyDirectory = await mkdtemp(path.join(os.tmpdir(), "cursor-bridge-pr-"));
        const bodyFile = path.join(bodyDirectory, "body.md");
        try {
          const body = [
            `승인된 작업 \`${task.id}\`의 자동 구현 결과입니다.`,
            "",
            "## 인수 조건",
            ...task.acceptance_criteria.map((item) => `- ${item}`),
            "",
            "## 독립 검증",
            ...input.verification.map((item) =>
              `- ${item.status === "passed" ? "PASS" : "FAIL"}: \`${item.command}\``,
            ),
            "",
            `- 후보 트리: \`${input.tree.treeHash}\``,
            `- 패치 증명: \`${input.tree.patchHash}\``,
            "",
            "Codex Cursor Bridge가 생성했습니다. 리뷰 완료 전까지 Draft 상태를 유지해야 합니다.",
          ].join("\n");
          await writeFile(bodyFile, body, { encoding: "utf8", mode: 0o600 });
          const created = await runFile("gh", [
            "pr",
            "create",
            "--draft",
            "--repo",
            repository.origin,
            "--base",
            task.target.destination_ref,
            "--head",
            prepared.pushBranch,
            "--title",
            task.title,
            "--body-file",
            bodyFile,
          ]);
          prUrl = created.stdout.trim();
        } catch (error) {
          const reconciled = await findOpenPullRequest();
          if (!reconciled) {
            throw new Error(
              `Draft pull request creation failed and no matching PR was found: ${errorOutput(error)}`,
            );
          }
          prUrl = reconciled;
          await this.#log(
            "Draft PR creation reported an error, but exact branch lookup found the created PR.",
          );
        } finally {
          await rm(bodyDirectory, { recursive: true, force: true });
        }
      }
    }
    const readback = await runFile("gh", [
      "pr",
      "view",
      prUrl,
      "--repo",
      repository.origin,
      "--json",
      "state,url,isDraft,baseRefName,headRefName,headRefOid,headRepository",
    ]);
    const info = JSON.parse(readback.stdout) as {
      state: string;
      url: string;
      isDraft: boolean;
      baseRefName: string;
      headRefName: string;
      headRefOid: string;
      headRepository: { nameWithOwner: string };
    };
    if (info.state !== "OPEN") {
      throw new Error("Pull request is no longer open");
    }
    if (
      info.headRefName !== prepared.pushBranch
      || info.headRepository.nameWithOwner !== repository.origin
    ) {
      throw new Error("Pull request readback does not match the published head branch");
    }
    if (
      info.baseRefName !== task.target.destination_ref
    ) {
      throw new Error("Pull request readback does not match the approved base branch");
    }
    if (effect.status !== "COMPLETED") {
      this.#store.completeEffect(effect.id, {
        url: info.url,
        isDraft: info.isDraft,
        headRefOid: info.headRefOid,
      });
    }
    return info;
  }

  async publish(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    repository: RepositoryConfig,
    input: PublicationInput,
    attempt: Attempt,
  ): Promise<PublicationResult> {
    await this.#assertPreparedWorktree(prepared);
    this.#assertPublicationLease(attempt);
    const headSha = await this.#commitCandidate(prepared, task, input, attempt);
    const remoteHeadSha = await this.#pushCandidate(prepared, task, headSha, attempt);
    const pullRequest = await this.#ensurePullRequest(
      prepared,
      task,
      repository,
      input,
      attempt,
    );
    if (pullRequest.headRefOid !== headSha) {
      throw new Error("Pull request head readback does not match the published commit");
    }
    return {
      prUrl: pullRequest.url,
      headSha,
      remoteHeadSha,
      treeHash: input.tree.treeHash,
      isDraft: pullRequest.isDraft,
    };
  }

  async writeAttestation(data: AttestationData): Promise<string> {
    await mkdir(this.#paths.reportsDir, { recursive: true, mode: 0o700 });
    const attestationPath = path.join(this.#paths.reportsDir, `${data.job.id}.attestation.json`);
    await writeFile(attestationPath, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      jobId: data.job.id,
      task: {
        id: data.task.id,
        specVersion: data.task.spec_version,
        specHash: data.task.spec_hash,
        policyVersion: data.task.policy_version,
        verificationProfileHash: data.task.verification.profile_hash,
        target: data.task.target,
      },
      source: {
        taskCommitSha: data.job.taskCommitSha,
        taskBlobSha: data.job.taskBlobSha,
      },
      candidate: data.tree,
      publication: data.publication,
      verification: data.verification,
      attempts: data.attempts.map((attempt) => ({
        id: attempt.id,
        ordinal: attempt.ordinal,
        status: attempt.status,
        cursorAgentId: attempt.cursorAgentId,
        cursorRunId: attempt.cursorRunId,
        cursorRequestId: attempt.cursorRequestId,
        outcome: attempt.outcome,
        outcomeSummary: attempt.outcomeSummary
          ? redact(attempt.outcomeSummary)
          : undefined,
        outcomeReason: attempt.outcomeReason
          ? redact(attempt.outcomeReason)
          : undefined,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
      })),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return attestationPath;
  }

  async writeReport(data: WorkflowReportData): Promise<string> {
    await mkdir(this.#paths.reportsDir, { recursive: true, mode: 0o700 });
    const reportPath = path.join(this.#paths.reportsDir, `${data.job.id}.md`);
    const lines = [
      `# ${data.task.id} Cursor 실행 보고서`,
      "",
      `- 상태: ${data.job.status}`,
      `- 저장소: ${data.task.repository}`,
      `- 명세: v${data.task.spec_version} ${data.task.spec_hash}`,
      `- 대상 기준 SHA: ${data.task.target.base_sha}`,
      ...(data.publication ? [
        `- PR: ${data.publication.prUrl}`,
        `- 게시 HEAD: ${data.publication.headSha}`,
      ] : data.job.prUrl ? [`- PR: ${data.job.prUrl}`] : []),
      "",
      "## Cursor 요약",
      "",
      data.cursorSummary ? redact(data.cursorSummary) : "요약 없음.",
      "",
      "## 변경 파일",
      "",
      ...(data.changes?.files.map((file) => `- ${file}`) ?? ["- 수집되지 않음"]),
      "",
      "## 독립 검증",
      "",
      ...(data.verification?.flatMap((result) => [
        `- ${result.status.toUpperCase()}: \`${result.command}\` (${result.durationMs}ms)`,
        ...(result.output
          ? redact(result.output).split("\n").map((line) => `    ${line}`)
          : []),
      ]) ?? ["- 실행되지 않음"]),
      ...(data.attempts ? [
        "",
        "## 시도",
        "",
        ...data.attempts.map((attempt) =>
          `- #${attempt.ordinal} ${attempt.status}${attempt.cursorRunId ? ` (run ${attempt.cursorRunId})` : ""}`,
        ),
      ] : []),
      ...(data.assessment && !data.assessment.ok ? [
        "",
        "## 범위 위반",
        "",
        ...data.assessment.reasons.map((reason) => `- ${reason}`),
      ] : []),
      ...(data.error ? ["", "## 오류", "", redact(data.error)] : []),
      "",
    ];
    await writeFile(reportPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
    return reportPath;
  }

  async cleanup(prepared: PreparedWorktree, repository: RepositoryConfig): Promise<void> {
    await this.#assertPreparedWorktree(prepared);
    await git(repository.root, "worktree", "remove", prepared.worktree);
    await git(repository.root, "branch", "-D", prepared.localBranch);
  }

  async cancel(attempt: Attempt): Promise<void> {
    const active = this.#activeRuns.get(attempt.id);
    if (active) {
      await active.cancel();
      await active.wait();
      return;
    }
    if (attempt.cursorRunId) {
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
  }
}
