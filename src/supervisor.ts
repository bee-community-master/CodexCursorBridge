import { appendFile, chmod, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePaths } from "./config.js";
import type { RuntimePaths } from "./domain/configuration.js";
import { safeErrorMessage } from "./redaction.js";
import { JobStore } from "./state.js";
import { processClaim } from "./worker.js";

const claimLeaseMs = 60_000;
const heartbeatIntervalMs = 15_000;
const shutdownPollMs = 25;
const shutdownGraceMs = 250;
const idlePollMs = 1_000;
const supervisorBackoffBaseMs = 250;
const supervisorBackoffCapMs = 30_000;

export interface SupervisorLoopOptions {
  claimLeaseMs?: number;
  heartbeatIntervalMs?: number;
  idlePollMs?: number;
  workerToken?: string;
  shouldStop?: () => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  processClaim?: typeof processClaim;
}

export class SupervisorShutdownError extends Error {
  constructor() {
    super("Supervisor shutdown requires the top-level owner to exit after cleanup.");
    this.name = "SupervisorShutdownError";
  }
}

export function supervisorBackoffMs(failureStreak: number): number {
  const exponent = Math.max(0, Math.min(failureStreak - 1, 16));
  return Math.min(supervisorBackoffCapMs, supervisorBackoffBaseMs * 2 ** exponent);
}

function delay(milliseconds: number, shouldStop: () => boolean): Promise<void> {
  if (shouldStop()) return Promise.resolve();
  return new Promise((resolve) => {
    const pollMs = Math.min(100, Math.max(1, milliseconds));
    const timer = setTimeout(finish, milliseconds);
    const poll = setInterval(() => {
      if (shouldStop()) finish();
    }, pollMs);
    function finish(): void {
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    }
  });
}

function watchForShutdown(shouldStop: () => boolean): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    if (shouldStop()) {
      resolve();
      return;
    }
    timer = setInterval(() => {
      if (!shouldStop()) return;
      if (timer) clearInterval(timer);
      resolve();
    }, shutdownPollMs);
  });
  return {
    promise,
    cancel: (): void => {
      if (timer) clearInterval(timer);
    },
  };
}

async function logSupervisorFailure(
  paths: RuntimePaths,
  phase: "claim" | "heartbeat" | "process",
  error: unknown,
): Promise<void> {
  const message = `[${new Date().toISOString()}] SUPERVISOR_${phase.toUpperCase()}_ERROR ${safeErrorMessage(error)}\n`;
  const logPath = `${paths.home}/supervisor.log`;
  try {
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await appendFile(logPath, message, { encoding: "utf8", mode: 0o600 });
    await chmod(logPath, 0o600);
  } catch {
    // launchd still receives the original diagnostic on stderr if the private
    // log cannot be written; logging must never kill the recovery loop.
    process.stderr.write(message);
  }
}

/**
 * Run the durable claim loop. Runtime exceptions are intentionally contained
 * here: a transient SDK/SQLite/lease error must leave the job reclaimable and
 * wake the next iteration rather than taking down launchd's process.
 */
export async function runSupervisor(
  store: JobStore,
  paths: RuntimePaths,
  options: SupervisorLoopOptions = {},
): Promise<void> {
  const leaseMs = options.claimLeaseMs ?? claimLeaseMs;
  const heartbeatMs = options.heartbeatIntervalMs ?? heartbeatIntervalMs;
  const idleMs = options.idlePollMs ?? idlePollMs;
  const shouldStop = options.shouldStop ?? ((): boolean => false);
  const processClaimImpl = options.processClaim ?? processClaim;
  const workerToken = options.workerToken ?? `supervisor:${process.pid}:${randomUUID()}`;
  let failureStreak = 0;
  let signalRequested = false;
  const stopRequested = (): boolean => shouldStop() || signalRequested;
  const sleep = options.sleep ?? ((milliseconds: number): Promise<void> =>
    delay(milliseconds, stopRequested));
  const signalHandler = (): void => {
    signalRequested = true;
  };
  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);

  try {
    while (!stopRequested()) {
    let claim;
    try {
      claim = store.claimNext(workerToken, leaseMs);
    } catch (error) {
      failureStreak += 1;
      await logSupervisorFailure(paths, "claim", error);
      await sleep(supervisorBackoffMs(failureStreak));
      continue;
    }
    if (!claim) {
      failureStreak = 0;
      await sleep(idleMs);
      continue;
    }

    const heartbeat = setInterval(() => {
      try {
        const currentAttemptId = store.get(claim.job.id)?.currentAttemptId;
        if (!currentAttemptId) return;
        store.heartbeat(currentAttemptId, workerToken, leaseMs);
      } catch (error) {
        // The workflow will observe a lost lease on its next state transition;
        // the loop itself remains alive so a replacement supervisor can reclaim.
        void logSupervisorFailure(paths, "heartbeat", error);
      }
    }, heartbeatMs);
    const shutdown = watchForShutdown(stopRequested);
    const processPromise = Promise.resolve().then(() => processClaimImpl(store, claim, paths));
    let processSettled = false;
    processPromise.finally(() => {
      processSettled = true;
    }).catch(() => undefined);
    try {
      const result = await Promise.race([
        processPromise.then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        shutdown.promise.then(() => ({ kind: "shutdown" as const })),
      ]);
      if (result.kind === "shutdown") {
        clearInterval(heartbeat);
        shutdown.cancel();
        await Promise.race([
          processPromise.then(() => undefined, () => undefined),
          delay(shutdownGraceMs, () => false),
        ]);
        if (!processSettled && signalRequested) throw new SupervisorShutdownError();
        continue;
      }
      if (result.kind === "failed") throw result.error;
      failureStreak = 0;
    } catch (error) {
      if (error instanceof SupervisorShutdownError) throw error;
      // processClaim normally fences and records workflow failures itself. A
      // last-resort guard keeps an unexpected adapter/runtime exception from
      // crashing launchd while the durable lease remains reclaimable.
      failureStreak += 1;
      clearInterval(heartbeat);
      await logSupervisorFailure(paths, "process", error);
      await sleep(supervisorBackoffMs(failureStreak));
    } finally {
      clearInterval(heartbeat);
      shutdown.cancel();
    }
  }
  } finally {
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
  }
}

async function main(): Promise<void> {
  const paths = runtimePaths();
  const store = new JobStore(paths.databaseFile);
  let stopping = false;
  let forceExit = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  try {
    await runSupervisor(store, paths, { shouldStop: () => stopping });
  } catch (error) {
    if (error instanceof SupervisorShutdownError) forceExit = true;
    else throw error;
  } finally {
    store.close();
  }
  if (forceExit) process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
