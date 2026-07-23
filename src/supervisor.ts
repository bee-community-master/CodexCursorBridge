import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { runtimePaths } from "./config.js";
import { JobStore } from "./state.js";
import { processClaim } from "./worker.js";

const claimLeaseMs = 60_000;
const heartbeatIntervalMs = 15_000;
const idlePollMs = 1_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const paths = runtimePaths();
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  const store = new JobStore(paths.databaseFile);
  const workerToken = `supervisor:${process.pid}:${randomUUID()}`;
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });

  try {
    while (!stopping) {
      const claim = store.claimNext(workerToken, claimLeaseMs);
      if (!claim) {
        await delay(idlePollMs);
        continue;
      }
      const heartbeat = setInterval(() => {
        const currentAttemptId = store.get(claim.job.id)?.currentAttemptId;
        if (!currentAttemptId) return;
        try {
          store.heartbeat(currentAttemptId, workerToken, claimLeaseMs);
        } catch {
          // The workflow will observe a lost lease on its next state transition.
        }
      }, heartbeatIntervalMs);
      heartbeat.unref();
      try {
        await processClaim(store, claim, paths);
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
