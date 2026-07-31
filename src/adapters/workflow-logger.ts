import { appendFile, chmod, open, readFile, stat, unlink } from "node:fs/promises";
import { redactSensitiveText } from "../application/redaction.js";
import type { PublicationStatePort } from "../application/workflow-ports.js";

const eventLogLockRetryMs = 5;
const eventLogLockStaleMs = 30_000;

async function withEventLogLock<T>(
  logPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${logPath}.cursor-events.lock`;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > eventLogLockStaleMs) {
          await unlink(lockPath).catch(() => undefined);
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
