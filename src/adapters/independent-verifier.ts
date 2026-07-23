import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type {
  PreparedWorktree,
  PublicationStatePort,
  VerificationResult,
} from "../application/workflow-ports.js";
import type { RuntimePaths } from "../domain/configuration.js";
import type { ApprovedTask } from "../domain/task.js";
import { safeErrorMessage } from "../application/redaction.js";
import { createVerificationSandbox } from "../sandbox.js";
import { runFile } from "./command-runner.js";
import type { PreparedWorktreeGuard } from "./prepared-worktree-guard.js";
import type { WorkflowLogger } from "./workflow-logger.js";

type VerificationStatePort = Pick<
  PublicationStatePort,
  "isCancellationRequested"
>;

export class IndependentVerifier {
  readonly #paths: RuntimePaths;
  readonly #store: VerificationStatePort;
  readonly #jobId: string;
  readonly #guard: PreparedWorktreeGuard;
  readonly #logger: WorkflowLogger;

  constructor(
    paths: RuntimePaths,
    store: VerificationStatePort,
    jobId: string,
    guard: PreparedWorktreeGuard,
    logger: WorkflowLogger,
  ) {
    this.#paths = paths;
    this.#store = store;
    this.#jobId = jobId;
    this.#guard = guard;
    this.#logger = logger;
  }

  async run(
    prepared: PreparedWorktree,
    task: ApprovedTask,
  ): Promise<VerificationResult[]> {
    await this.#guard.assertPreparedWorktree(prepared);
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
        await this.#logger.log(`Verification passed: ${item.command} ${item.args.join(" ")}`);
        results.push({
          command: [item.command, ...item.args].join(" "),
          status: "passed",
          durationMs: Date.now() - started,
        });
      } catch (error) {
        await this.#logger.log(`Verification failed: ${item.command} ${item.args.join(" ")}`);
        results.push({
          command: [item.command, ...item.args].join(" "),
          status: "failed",
          durationMs: Date.now() - started,
          output: safeErrorMessage(error),
        });
        break;
      } finally {
        clearInterval(cancellationTimer);
        await rm(scratch, { recursive: true, force: true });
      }
    }
    return results;
  }
}
