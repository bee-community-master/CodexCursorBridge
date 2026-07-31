import { randomUUID } from "node:crypto";
import { appendFile, chmod, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { redactSensitiveText } from "../application/redaction.js";
import type { PublicationStatePort } from "../application/workflow-ports.js";

const eventLogLockRetryMs = 5;
const eventLogLockStaleMs = 30_000;
const eventLogLockHeartbeatMs = 5_000;

interface EventLogLockOwner {
  pid: number;
  token: string;
}

async function readLockOwner(lockPath: string): Promise<EventLogLockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, { encoding: "utf8" })) as Partial<EventLogLockOwner>;
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
      && typeof parsed.token === "string" && parsed.token.length > 0
      ? { pid: parsed.pid, token: parsed.token }
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function releaseEventLogLock(lockPath: string, owner: EventLogLockOwner): Promise<void> {
  const current = await readLockOwner(lockPath);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return;
  await unlink(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

async function refreshEventLogLock(lockPath: string, owner: EventLogLockOwner): Promise<void> {
  const current = await readLockOwner(lockPath);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return;
  const now = new Date();
  await utimes(lockPath, now, now);
}

async function withEventLogLock<T>(
  logPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${logPath}.cursor-events.lock`;
  for (;;) {
    const owner: EventLogLockOwner = { pid: process.pid, token: randomUUID() };
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(owner), { encoding: "utf8" });
      const heartbeat = setInterval(() => {
        void refreshEventLogLock(lockPath, owner).catch(() => undefined);
      }, eventLogLockHeartbeatMs);
      try {
        return await operation();
      } finally {
        clearInterval(heartbeat);
        await handle.close();
        await releaseEventLogLock(lockPath, owner);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const ownerOnDisk = await readLockOwner(lockPath);
      if (!ownerOnDisk || processIsAlive(ownerOnDisk.pid)) {
        await new Promise<void>((resolve) => setTimeout(resolve, eventLogLockRetryMs));
        continue;
      }
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > eventLogLockStaleMs) {
          const confirmedOwner = await readLockOwner(lockPath);
          if (
            confirmedOwner
            && confirmedOwner.pid === ownerOnDisk.pid
            && confirmedOwner.token === ownerOnDisk.token
          ) {
            await unlink(lockPath).catch((unlinkError: unknown) => {
              if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
            });
          }
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, eventLogLockRetryMs));
    }
  }
}

export interface WorkflowLogger {
  log(message: string): Promise<void>;
  logEvent?(eventKey: string, message: string): Promise<void>;
}

export class FileWorkflowLogger implements WorkflowLogger {
  readonly #store: Pick<PublicationStatePort, "get">;
  readonly #jobId: string;

  constructor(store: Pick<PublicationStatePort, "get">, jobId: string) {
    this.#store = store;
    this.#jobId = jobId;
  }

  async log(message: string): Promise<void> {
    const job = this.#store.get(this.#jobId);
    if (!job?.logPath) return;
    await appendFile(
      job.logPath,
      `[${new Date().toISOString()}] ${redactSensitiveText(message)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(job.logPath, 0o600);
  }

  async logEvent(eventKey: string, message: string): Promise<void> {
    const job = this.#store.get(this.#jobId);
    if (!job?.logPath) return;
    await withEventLogLock(job.logPath, async () => {
      const marker = `CURSOR_RUN_EVENT:${eventKey}`;
      let existing = "";
      try {
        existing = await readFile(job.logPath!, { encoding: "utf8" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing.split("\n").some((line) =>
        line.includes(`${marker}\t`) || line.includes(`${marker} `))) return;
      await appendFile(
        job.logPath!,
        `[${new Date().toISOString()}] ${marker}\t${redactSensitiveText(message)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await chmod(job.logPath!, 0o600);
    });
  }
}
