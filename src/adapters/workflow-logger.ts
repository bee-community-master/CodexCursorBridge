import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { redactSensitiveText } from "../application/redaction.js";
import type { PublicationStatePort } from "../application/workflow-ports.js";

const eventLogLockRetryMs = 5;
const legacyLockRetryMs = 100;
const eventLogLockStaleMs = 30_000;
const legacyLockSuffix = ".cursor-events.lock";
const sqliteLockSuffix = ".cursor-events.sqlite";

function eventMarker(eventKey: string): string {
  return `CURSOR_RUN_EVENT:${createHash("sha256").update(eventKey).digest("hex")}`;
}

function encodeLogMessage(message: string): string {
  return [...redactSensitiveText(message)].map((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
}

function hasEventMarker(line: string, marker: string): boolean {
  const timestampEnd = line.indexOf("] ");
  return timestampEnd > 1
    && line.startsWith(`[${line.slice(1, timestampEnd)}] ${marker}\t`)
    && !line.slice(1, timestampEnd).includes("\r")
    && !line.slice(1, timestampEnd).includes("\n");
}

function isSqliteBusy(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | undefined;
  return candidate?.code === "ERR_SQLITE_BUSY"
    || /(?:database is locked|SQLITE_BUSY)/i.test(String(candidate?.message ?? error));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retireLegacyEventLogLock(logPath: string): Promise<boolean> {
  const legacyPath = `${logPath}${legacyLockSuffix}`;
  const lockStat = await stat(legacyPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!lockStat) return true;
  if (Date.now() - lockStat.mtimeMs <= eventLogLockStaleMs) return false;

  const quarantinePath = `${legacyPath}.stale-${randomUUID()}`;
  try {
    await rename(legacyPath, quarantinePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    throw error;
  }
  await rm(quarantinePath, { recursive: true, force: true });
  return true;
}

async function withEventLogLock<T>(
  logPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const databasePath = `${logPath}${sqliteLockSuffix}`;
  for (;;) {
    let database: DatabaseSync | undefined;
    let transactionOpen = false;
    try {
      database = new DatabaseSync(databasePath);
      await chmod(databasePath, 0o600);
      // Do not block the Node event loop while another logger transaction is
      // active; the retry below yields so that owner can finish and roll back.
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      if (!await retireLegacyEventLogLock(logPath)) {
        database.exec("ROLLBACK");
        transactionOpen = false;
        database.close();
        database = undefined;
        await sleep(legacyLockRetryMs);
        continue;
      }
      try {
        return await operation();
      } finally {
        if (transactionOpen) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // A process crash lets SQLite roll back the transaction itself.
          }
        }
        database.close();
      }
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the operation or SQLite error below.
      }
      if (!isSqliteBusy(error)) throw error;
      await sleep(eventLogLockRetryMs);
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
      `[${new Date().toISOString()}] ${encodeLogMessage(message)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(job.logPath, 0o600);
  }

  async logEvent(eventKey: string, message: string): Promise<void> {
    const job = this.#store.get(this.#jobId);
    if (!job?.logPath) return;
    await withEventLogLock(job.logPath, async () => {
      const marker = eventMarker(eventKey);
      let existing = "";
      try {
        existing = await readFile(job.logPath!, { encoding: "utf8" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing.split("\n").some((line) => hasEventMarker(line, marker))) return;
      await appendFile(
        job.logPath!,
        `[${new Date().toISOString()}] ${marker}\t${encodeLogMessage(message)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await chmod(job.logPath!, 0o600);
    });
  }
}
