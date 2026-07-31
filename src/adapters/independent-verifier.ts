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
import {
  assertStagedPackageManager,
  stagePackageManager,
} from "./package-manager-cache.js";
import type { PreparedWorktreeGuard } from "./prepared-worktree-guard.js";
import type { WorkflowLogger } from "./workflow-logger.js";

type VerificationStatePort = Pick<
  PublicationStatePort,
  "isCancellationRequested"
>;

type PackageManagerBinary = "pnpm" | "pnpx";

function usesPnpm(command: string): command is PackageManagerBinary {
  return command === "pnpm" || command === "pnpx";
}

function isPnpmExecutable(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.replaceAll("\\", "/").split("/").at(-1);
  return normalized === "pnpm" || normalized === "pnpx";
}

export function assertPackageManagerControlArgs(args: readonly string[]): void {
  const settings = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--config") {
      const next = args[index + 1];
      if (next) settings.add(next);
    } else if (argument.startsWith("--config=")) {
      settings.add(argument.slice("--config=".length));
    } else if (argument.startsWith("--config.")) {
      settings.add(argument.slice("--config.".length));
    }
  }
  if ([...settings].some((setting) =>
    /^(?:manage-package-manager-versions|package-manager-strict|package-manager-on-fail|pm-on-fail)(?:=|$)/i
      .test(setting),
  )) {
    throw new Error(
      "Independent verifier rejects package-manager control arguments that can switch the executed pnpm",
    );
  }

  const commandIndex = args.findIndex((argument) => !argument.startsWith("-"));
  const subcommand = commandIndex === -1 ? undefined : args[commandIndex];
  if (subcommand === "self-update" || subcommand === "with") {
    throw new Error(
      `Independent verifier rejects pnpm ${subcommand}; package-manager switching is not attestable`,
    );
  }
  if (subcommand === "exec" || subcommand === "dlx") {
    const target = args.slice(commandIndex + 1).find((argument) => !argument.startsWith("-"));
    if (isPnpmExecutable(target)) {
      throw new Error(
        "Independent verifier rejects pnpm exec/dlx of another package-manager binary",
      );
    }
  }
}

export function assertPackageManagerEnvironment(env: Readonly<Record<string, string>> | undefined): void {
  const controlNames = Object.keys(env ?? {}).filter((name) => /^COREPACK_/.test(name));
  if (controlNames.length > 0) {
    throw new Error(
      `Independent verifier rejects COREPACK_* task environment overrides: ${controlNames.join(", ")}`,
    );
  }
}

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
      const cacheRoot = await mkdtemp(path.join(this.#paths.home, "verify-cache-"));
      await mkdir(path.join(scratch, "home"), { recursive: true, mode: 0o700 });
      await mkdir(path.join(scratch, "tmp"), { recursive: true, mode: 0o700 });
      const started = Date.now();
      const controller = new AbortController();
      const cancellationTimer = setInterval(() => {
        if (this.#store.isCancellationRequested(this.#jobId)) controller.abort();
      }, 250);
      cancellationTimer.unref();
      let staged: Awaited<ReturnType<typeof stagePackageManager>> | undefined;
      let invocationStarted = false;
      try {
        if (usesPnpm(item.command)) {
          assertPackageManagerEnvironment(item.env);
          assertPackageManagerControlArgs(item.args);
        }
        staged = usesPnpm(item.command)
          ? await stagePackageManager(prepared.worktree, cacheRoot, item.command)
          : undefined;
        if (staged) await assertStagedPackageManager(staged);
        const command = staged ? process.execPath : item.command;
        const args = staged ? [staged.executable, ...item.args] : item.args;
        const attestedCommand = [command, ...args].join(" ");
        const invocation = createVerificationSandbox({
          worktree: prepared.worktree,
          scratchDir: scratch,
          command,
          args,
          ...(item.env ? { taskEnv: item.env } : {}),
          ...(staged ? {
            corepackHome: staged.corepackHome,
            readOnlyRoots: [staged.corepackHome],
            pathPrefix: [path.dirname(staged.executable), path.dirname(process.execPath)],
          } : {}),
        });
        invocationStarted = true;
        await runFile(invocation.command, invocation.args, {
          cwd: prepared.worktree,
          env: invocation.env,
          timeoutMs: item.timeout_seconds * 1000,
          signal: controller.signal,
        });
        await this.#logger.log(`Verification passed: ${attestedCommand}`);
        results.push({
          command: attestedCommand,
          status: "passed",
          durationMs: Date.now() - started,
          ...(staged && invocationStarted ? {
            packageManager: {
              name: staged.name,
              binary: staged.binary,
              version: staged.version,
              digest: staged.digest,
              ...(staged.integrity ? { integrity: staged.integrity } : {}),
              artifactDigest: staged.artifactDigest,
              runtime: "node",
              entrypoint: staged.entrypoint,
              source: staged.source,
              network: staged.network,
            },
          } : {}),
        });
      } catch (error) {
        const failedCommand = staged
          ? `${process.execPath} ${staged.executable} ${item.args.join(" ")}`.trim()
          : [item.command, ...item.args].join(" ");
        await this.#logger.log(`Verification failed: ${failedCommand}`);
        results.push({
          command: failedCommand,
          status: "failed",
          durationMs: Date.now() - started,
          output: safeErrorMessage(error),
          ...(staged && invocationStarted ? {
            packageManager: {
              name: staged.name,
              binary: staged.binary,
              version: staged.version,
              digest: staged.digest,
              ...(staged.integrity ? { integrity: staged.integrity } : {}),
              artifactDigest: staged.artifactDigest,
              runtime: "node",
              entrypoint: staged.entrypoint,
              source: staged.source,
              network: staged.network,
            },
          } : {}),
        });
        break;
      } finally {
        clearInterval(cancellationTimer);
        await rm(scratch, { recursive: true, force: true });
        await rm(cacheRoot, { recursive: true, force: true });
      }
    }
    return results;
  }
}
