import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { redactSensitiveText } from "../application/redaction.js";
import type { PublicationStatePort } from "../application/workflow-ports.js";

const eventLogLockRetryMs = 5;
const eventLogLockStaleMs = 30_000;
const eventLogLockHeartbeatMs = 5_000;
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
  const timestampEnd = line.indexOf("] ");
  return timestampEnd > 1
    && line.startsWith(`[${line.slice(1, timestampEnd)}] ${marker}\t`)
    && !line.slice(1, timestampEnd).includes("\r")
    && !line.slice(1, timestampEnd).includes("\n");
}

interface EventLogLockOwner {
  pid: number;
  token: string;
  startIdentity?: string;
  state: "held" | "released";
}

interface LockOwnerSnapshot {
  owner: EventLogLockOwner;
  ownerPath: string;
  mtimeMs: number;
}

let ownStartIdentity: Promise<string | undefined> | undefined;

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

function currentProcessStartIdentity(): Promise<string | undefined> {
  ownStartIdentity ??= processStartIdentity(process.pid);
  return ownStartIdentity;
}

async function readLockOwner(lockPath: string): Promise<LockOwnerSnapshot | undefined> {
  try {
    const names = await readdir(lockPath);
    const ownerNames = names.filter((name) =>
      name.startsWith(ownerFilePrefix) && name.endsWith(".json"));
    if (ownerNames.length !== 1) return undefined;
    const ownerName = ownerNames[0]!;
    const ownerPath = `${lockPath}/${ownerName}`;
    const parsed = JSON.parse(await readFile(ownerPath, { encoding: "utf8" })) as Partial<EventLogLockOwner>;
    if (
      typeof parsed.pid !== "number"
      || !Number.isInteger(parsed.pid)
      || typeof parsed.token !== "string"
      || parsed.token.length === 0
      || (parsed.startIdentity !== undefined && typeof parsed.startIdentity !== "string")
      || (parsed.state !== "held" && parsed.state !== "released")
    ) return undefined;
    const ownerStat = await stat(ownerPath);
    return {
      owner: {
        pid: parsed.pid,
        token: parsed.token,
        ...(parsed.startIdentity ? { startIdentity: parsed.startIdentity } : {}),
        state: parsed.state,
      },
      ownerPath,
      mtimeMs: ownerStat.mtimeMs,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || error instanceof SyntaxError) return undefined;
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

async function ownerIsAlive(owner: EventLogLockOwner): Promise<boolean> {
  if (owner.state === "released") return false;
  if (!processIsAlive(owner.pid)) return false;
  if (!owner.startIdentity) return false;
  const currentIdentity = await processStartIdentity(owner.pid);
  return currentIdentity === owner.startIdentity;
}

async function refreshEventLogLock(snapshotPath: string, owner: EventLogLockOwner): Promise<void> {
  const current = await readLockOwner(snapshotPath);
  if (!current || current.owner.pid !== owner.pid || current.owner.token !== owner.token) return;
  const now = new Date();
  await utimes(current.ownerPath, now, now);
}

async function releaseEventLogLock(
  lockPath: string,
  ownerPath: string,
  owner: EventLogLockOwner,
): Promise<void> {
  const current = await readLockOwner(lockPath);
  if (current && current.owner.pid === owner.pid && current.owner.token === owner.token) {
    await writeFile(ownerPath, JSON.stringify({ ...owner, state: "released" }), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  await unlink(ownerPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await rmdir(lockPath).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  });
}

async function reclaimStaleEventLogLock(lockPath: string): Promise<void> {
  const snapshot = await readLockOwner(lockPath);
  const lockStat = await stat(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!lockStat) return;
  const lastActivityMs = snapshot?.mtimeMs ?? lockStat.mtimeMs;
  if (Date.now() - lastActivityMs <= eventLogLockStaleMs) return;
  if (snapshot && await ownerIsAlive(snapshot.owner)) return;
  const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    return;
  }
  await rm(quarantinePath, { recursive: true, force: true });
}

async function withEventLogLock<T>(
  logPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${logPath}.cursor-events.lock`;
  for (;;) {
    const startIdentity = await currentProcessStartIdentity();
    const owner: EventLogLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      ...(startIdentity ? { startIdentity } : {}),
      state: "held",
    };
    const claimPath = `${lockPath}.claim-${owner.token}`;
    const claimOwnerPath = `${claimPath}/${ownerFilePrefix}${owner.token}.json`;
    let claimCreated = false;
    let claimed = false;
    try {
      await mkdir(claimPath, { mode: 0o700 });
      claimCreated = true;
      await writeFile(claimOwnerPath, JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
      await rename(claimPath, lockPath);
      claimed = true;
      const ownerPath = `${lockPath}/${ownerFilePrefix}${owner.token}.json`;
      const heartbeat = setInterval(() => {
        void refreshEventLogLock(lockPath, owner).catch(() => undefined);
      }, eventLogLockHeartbeatMs);
      try {
        return await operation();
      } finally {
        clearInterval(heartbeat);
        await releaseEventLogLock(lockPath, ownerPath, owner);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (claimCreated && !claimed) await rm(claimPath, { recursive: true, force: true });
      if (claimed || (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EISDIR")) {
        throw error;
      }
      await reclaimStaleEventLogLock(lockPath);
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
