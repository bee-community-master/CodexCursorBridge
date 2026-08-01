import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { redactSensitiveText } from "../application/redaction.js";
import type { PublicationStatePort } from "../application/workflow-ports.js";

const eventLogLockRetryMs = 5;
const legacyLockRetryMs = 100;
const eventLogLockStaleMs = 30_000;
const legacyLockSuffix = ".cursor-events.lock";
const sqliteLockSuffix = ".cursor-events.sqlite";
const ownerFilePrefix = "owner-";
const execFileAsync = promisify(execFile);

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
  if (!line.endsWith("\n")) return false;
  const content = line.slice(0, -1);
  const timestampEnd = line.indexOf("] ");
  const timestamp = content.slice(1, timestampEnd);
  if (timestampEnd <= 1
    || !content.startsWith("[")
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
    || content.slice(1, timestampEnd).includes("\r")
    || content.slice(1, timestampEnd).includes("\n")) return false;
  return content.endsWith(`\t${marker}`);
}

function hasCompleteEventMarker(log: string, marker: string): boolean {
  let start = 0;
  for (;;) {
    const newline = log.indexOf("\n", start);
    if (newline < 0) return false;
    if (hasEventMarker(log.slice(start, newline + 1), marker)) return true;
    start = newline + 1;
  }
}

function hasTrailingEventMarkerWithoutNewline(log: string, marker: string): boolean {
  if (!log || log.endsWith("\n")) return false;
  const start = log.lastIndexOf("\n") + 1;
  return hasEventMarker(`${log.slice(start)}\n`, marker);
}

interface EventLogLockOwner {
  pid: number;
  token: string;
  startIdentity?: string;
  state: "held" | "released";
}

interface LockOwnerSnapshot {
  owner: EventLogLockOwner;
  mtimeMs: number;
}

interface LegacyLockInspection {
  owners: LockOwnerSnapshot[];
  lastActivityMs?: number;
}

async function processStartIdentity(pid: number): Promise<string | undefined> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 1_000,
    });
    const identity = String(result.stdout).trim();
    return identity || undefined;
  } catch {
    return undefined;
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

async function readLegacyLockOwners(lockPath: string): Promise<LegacyLockInspection> {
  try {
    const names = await readdir(lockPath);
    const ownerNames = names.filter((name) =>
      name.startsWith(ownerFilePrefix) && name.endsWith(".json"));
    const snapshots: LockOwnerSnapshot[] = [];
    let lastActivityMs: number | undefined;
    for (const name of ownerNames) {
      const ownerPath = `${lockPath}/${name}`;
      try {
        const ownerStat = await stat(ownerPath);
        lastActivityMs = Math.max(lastActivityMs ?? ownerStat.mtimeMs, ownerStat.mtimeMs);
        const parsed = JSON.parse(await readFile(ownerPath, { encoding: "utf8" })) as Partial<EventLogLockOwner>;
        if (
          typeof parsed.pid !== "number"
          || !Number.isSafeInteger(parsed.pid)
          || parsed.pid <= 0
          || typeof parsed.token !== "string"
          || parsed.token.length === 0
          || (parsed.startIdentity !== undefined && typeof parsed.startIdentity !== "string")
          || (parsed.state !== "held" && parsed.state !== "released")
        ) continue;
        snapshots.push({
          owner: {
            pid: parsed.pid,
            token: parsed.token,
            ...(parsed.startIdentity ? { startIdentity: parsed.startIdentity } : {}),
            state: parsed.state,
          },
          mtimeMs: ownerStat.mtimeMs,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && !(error instanceof SyntaxError)) throw error;
      }
    }
    return { owners: snapshots, ...(lastActivityMs === undefined ? {} : { lastActivityMs }) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { owners: [] };
    throw error;
  }
}

async function ownerIsLive(owner: EventLogLockOwner): Promise<boolean | undefined> {
  if (owner.state === "released") return false;
  if (!processIsAlive(owner.pid)) return false;
  if (!owner.startIdentity) return undefined;
  const identity = await processStartIdentity(owner.pid);
  if (!identity) return undefined;
  return identity === owner.startIdentity;
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
  let lastActivityMs = lockStat.mtimeMs;
  let owners: LockOwnerSnapshot[] = [];
  if (lockStat.isDirectory()) {
    const inspection = await readLegacyLockOwners(legacyPath);
    owners = inspection.owners;
    if (inspection.lastActivityMs !== undefined) {
      lastActivityMs = Math.max(lastActivityMs, inspection.lastActivityMs);
    }
  }
  if (Date.now() - lastActivityMs <= eventLogLockStaleMs) return false;
  for (const snapshot of owners) {
    if (await ownerIsLive(snapshot.owner) !== false) return false;
  }

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
      if (hasCompleteEventMarker(existing, marker)) {
        await chmod(job.logPath!, 0o600);
        return;
      }
      if (hasTrailingEventMarkerWithoutNewline(existing, marker)) {
        await appendFile(job.logPath!, "\n", { encoding: "utf8", mode: 0o600 });
        await chmod(job.logPath!, 0o600);
        return;
      }
      const record = `[${new Date().toISOString()}] ${encodeLogMessage(message)}\t${marker}\n`;
      const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      await appendFile(
        job.logPath!,
        `${separator}${record}`,
        { encoding: "utf8", mode: 0o600 },
      );
      await chmod(job.logPath!, 0o600);
    });
  }
}
