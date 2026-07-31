import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
import { packageManagerOptionCatalog } from "./package-manager-option-catalog.js";
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

const packageManagerValueOptions = new Set(
  packageManagerOptionCatalog.valueOptions.map((option) => `--${option}`),
);

const packageManagerShortValueOptions = new Set(
  Object.keys(packageManagerOptionCatalog.shortValueOptions),
);

const dangerousPackageManagerCommands = new Set([
  "exec",
  "dlx",
  "env",
  "self-update",
  "setup",
  "shell",
  "with",
]);

export function assertPackageManagerControlArgs(args: readonly string[]): void {
  const settings = new Set<string>();
  let command: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      if (command === undefined) command = args[index + 1];
      break;
    }
    if (argument === "--config") {
      const next = args[index + 1];
      if (next) settings.add(next);
    }
    if (argument.startsWith("--config=")) {
      settings.add(argument.slice("--config=".length));
    } else if (argument.startsWith("--config.")) {
      settings.add(argument.slice("--config.".length));
    } else if (argument.startsWith("--pm-on-fail")) {
      settings.add(argument.replace(/^--/, ""));
    } else if (
      argument.startsWith("--package-manager-strict")
      || argument.startsWith("--manage-package-manager-versions")
    ) {
      settings.add(argument.replace(/^--/, ""));
    }
    if (command !== undefined) continue;
    if (argument.startsWith("-")) {
      const optionName = argument.split("=", 1)[0] ?? "";
      if (dangerousPackageManagerCommands.has(optionName.replace(/^-+/, ""))) {
        command = optionName;
        continue;
      }
      if (argument.startsWith("--")) {
        if (!argument.includes("=") && packageManagerValueOptions.has(argument)) index += 1;
        continue;
      }
      const shortOptions = argument.slice(1);
      let shortValueOption = false;
      for (let shortIndex = 0; shortIndex < shortOptions.length; shortIndex += 1) {
        const shortOption = shortOptions[shortIndex];
        if (shortOption === undefined || !packageManagerShortValueOptions.has(shortOption)) continue;
        shortValueOption = true;
        const attachedValue = shortOptions.slice(shortIndex + 1);
        if (!attachedValue) index += 1;
        break;
      }
      if (shortValueOption) {
        continue;
      }
      if (dangerousPackageManagerCommands.has(shortOptions)) {
        command = argument;
      }
      continue;
    }
    command = argument;
  }
  if ([...settings].some((setting) =>
    /(?:^|\.)(?:manage-package-manager-versions|package-manager-strict|package-manager-on-fail|pm-on-fail)(?:=|$)/i
      .test(setting),
  )) {
    throw new Error(
      "Independent verifier rejects package-manager control arguments that can switch the executed pnpm",
    );
  }

  const dangerousCommand = command?.replace(/^-+/, "");
  if (dangerousCommand && dangerousPackageManagerCommands.has(dangerousCommand)) {
    throw new Error(
      `Independent verifier rejects pnpm ${dangerousCommand}; nested package-manager execution is not attestable`,
    );
  }
}

export function assertPackageManagerEnvironment(env: Readonly<Record<string, string>> | undefined): void {
  const controlNames = Object.keys(env ?? {}).filter((name) =>
    /^COREPACK_/.test(name)
    || /^(?:NPM|PNPM)_CONFIG_(?:MANAGE_PACKAGE_MANAGER_VERSIONS|PACKAGE_MANAGER_STRICT|PM_ON_FAIL)$/.test(name),
  );
  if (controlNames.length > 0) {
    throw new Error(
      `Independent verifier rejects COREPACK_* task environment overrides: ${controlNames.join(", ")}`,
    );
  }
}

async function findWorkspacePackageManagerBinaries(root: string): Promise<string[]> {
  const binaries: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.name === "node_modules" && (entry.isDirectory() || entry.isSymbolicLink())) {
        const binDirectory = path.join(child, ".bin");
        for (const binary of ["pnpm", "pnpx", "corepack"]) {
          const candidate = path.join(binDirectory, binary);
          try {
            await lstat(candidate);
            binaries.push(candidate);
          } catch (error) {
            // A workspace may not have every package-manager binary.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name !== ".git") await visit(child);
    }
  }
  await visit(path.resolve(root));
  return binaries;
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
          ? await stagePackageManager(
            prepared.worktree,
            cacheRoot,
            path.join(this.#paths.home, "package-manager-provenance.json"),
            item.command,
          )
          : undefined;
        if (staged) await assertStagedPackageManager(staged);
        const command = staged ? process.execPath : item.command;
        const args = staged ? [staged.executable, ...item.args] : item.args;
        const argv = [command, ...args];
        const attestedCommand = argv.join(" ");
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
            blockedProcessPaths: await findWorkspacePackageManagerBinaries(prepared.worktree),
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
          argv,
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
              executable: staged.executable,
              source: staged.source,
              network: staged.network,
              scope: staged.scope,
            },
          } : {}),
        });
      } catch (error) {
        const failedCommand = staged
          ? `${process.execPath} ${staged.executable} ${item.args.join(" ")}`.trim()
          : [item.command, ...item.args].join(" ");
        const failedArgv = staged
          ? [process.execPath, staged.executable, ...item.args]
          : [item.command, ...item.args];
        await this.#logger.log(`Verification failed: ${failedCommand}`);
        results.push({
          command: failedCommand,
          argv: failedArgv,
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
              executable: staged.executable,
              source: staged.source,
              network: staged.network,
              scope: staged.scope,
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
