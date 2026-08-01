import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runFile } from "./git.js";

const securityCommand = "/usr/bin/security";
const psCommand = "/bin/ps";
const psEnvironment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
const bootstrapCredentialChildLockSuffix = ".security-child.sqlite";
const bootstrapCredentialChildOwnerSuffix = ".owner";
const bootstrapCredentialChildPidSuffix = ".pid";
const bootstrapCredentialChildBusyCode = "BOOTSTRAP_CHILD_BUSY";
const bootstrapCredentialLockRetryDelayMs = 25;

export interface KeychainStoreRequest {
  command: string;
  args: string[];
}

export type BootstrapCredentialLockRunner = <T>(
  work: () => Promise<T>,
  options: { database: string },
) => Promise<T>;

interface ProcessIdentity {
  pid: number;
  uid: number;
  startIdentity: string;
  command: string;
}

interface ChildMarkerIdentity extends ProcessIdentity {
  expectedCommand: string;
}

type ProcessInspection =
  | { kind: "active"; identity: ProcessIdentity }
  | { kind: "dead" }
  | { kind: "unavailable" };

type MarkerRead =
  | { kind: "missing" }
  | { kind: "identity"; identity: ChildMarkerIdentity }
  | { kind: "legacy"; pid: number };

type MarkerState =
  | { kind: "missing" }
  | { kind: "active" }
  | { kind: "stale" }
  | { kind: "unavailable" }
  | { kind: "legacy-active" }
  | { kind: "legacy-unavailable" };

export function bootstrapCredentialChildLockDatabase(database: string): string {
  return `${database}${bootstrapCredentialChildLockSuffix}`;
}

function bootstrapCredentialChildOwnerMarker(database: string): string {
  return `${database}${bootstrapCredentialChildOwnerSuffix}`;
}

function bootstrapCredentialChildPidMarker(database: string): string {
  return `${database}${bootstrapCredentialChildPidSuffix}`;
}

function lockPathError(): Error {
  return new Error("Bootstrap credential lock path must contain only plain directories and regular files");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function processUid(): number {
  if (typeof process.getuid !== "function") throw lockPathError();
  return process.getuid();
}

function assertPrivateMarker(metadata: Awaited<ReturnType<typeof lstat>>, ownerUid: number): void {
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.uid !== ownerUid
    || metadata.nlink !== 1
  ) {
    throw lockPathError();
  }
}

function childBusyError(): Error {
  const error = new Error("Another bootstrap interactive Keychain child is still active");
  Object.defineProperty(error, "code", { value: bootstrapCredentialChildBusyCode });
  return error;
}

export function isBootstrapCredentialChildBusy(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === bootstrapCredentialChildBusyCode;
}

async function inspectProcess(pid: number): Promise<ProcessInspection> {
  if (!Number.isInteger(pid) || pid <= 1) return { kind: "dead" };
  try {
    const result = await runFile(psCommand, ["-p", String(pid), "-o", "uid=,lstart=,command="], {
      env: psEnvironment,
      timeoutMs: 1_000,
    });
    const line = result.stdout.trim();
    const match = /^(\d+)\s+(.{24})\s+(.+)$/s.exec(line);
    if (!match) return { kind: line ? "unavailable" : "dead" };
    return {
      kind: "active",
      identity: {
        pid,
        uid: Number(match[1]),
        startIdentity: match[2]!,
        command: match[3]!.trim(),
      },
    };
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    return code === 1 || code === "1" ? { kind: "dead" } : { kind: "unavailable" };
  }
}

async function createPrivateChildMarker(marker: string, pid: number, expectedCommand: string): Promise<void> {
  const ownerUid = processUid();
  const inspection = await inspectProcess(pid);
  if (inspection.kind !== "active") throw new Error("Interactive child process identity could not be established");
  let handle;
  try {
    handle = await open(
      marker,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify({
      ...inspection.identity,
      expectedCommand,
    })}\n`, "utf8");
  } finally {
    await handle?.close();
  }
  const metadata = await lstat(marker);
  assertPrivateMarker(metadata, ownerUid);
}

async function readPrivateChildMarker(marker: string): Promise<MarkerRead> {
  const ownerUid = processUid();
  let metadata;
  try {
    metadata = await lstat(marker);
  } catch (error) {
    if (isNotFound(error)) return { kind: "missing" };
    throw error;
  }
  assertPrivateMarker(metadata, ownerUid);
  const text = (await readFile(marker, "utf8")).trim();
  if (/^\d+$/.test(text)) return { kind: "legacy", pid: Number(text) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw lockPathError();
  }
  if (!isChildMarkerIdentity(parsed)) throw lockPathError();
  return { kind: "identity", identity: parsed };
}

function isChildMarkerIdentity(value: unknown): value is ChildMarkerIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const pid = candidate.pid;
  const uid = candidate.uid;
  const startIdentity = candidate.startIdentity;
  const command = candidate.command;
  const expectedCommand = candidate.expectedCommand;
  return typeof pid === "number"
    && Number.isSafeInteger(pid)
    && pid > 1
    && typeof uid === "number"
    && Number.isSafeInteger(uid)
    && uid >= 0
    && typeof startIdentity === "string"
    && startIdentity.length > 0
    && typeof command === "string"
    && command.length > 0
    && typeof expectedCommand === "string"
    && expectedCommand.length > 0;
}

async function removePrivateChildMarker(marker: string): Promise<void> {
  const ownerUid = processUid();
  try {
    const metadata = await lstat(marker);
    assertPrivateMarker(metadata, ownerUid);
    await rm(marker);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function securityCommandIsRunning(): Promise<boolean> {
  try {
    const result = await runFile(psCommand, ["-axo", "pid=,command="], {
      env: psEnvironment,
      timeoutMs: 1_000,
    });
    return result.stdout.split("\n").some((line) => {
      const command = line.trim().replace(/^\d+\s+/, "");
      return command === securityCommand || command.startsWith(`${securityCommand} `);
    });
  } catch {
    return true;
  }
}

function commandMatches(command: string, expectedCommand: string): boolean {
  return command === expectedCommand || command.startsWith(`${expectedCommand} `);
}

async function inspectMarker(record: MarkerRead): Promise<MarkerState> {
  if (record.kind === "missing") return { kind: "missing" };
  const inspection = await inspectProcess(record.kind === "legacy" ? record.pid : record.identity.pid);
  if (record.kind === "legacy") {
    if (inspection.kind === "dead") return { kind: "stale" };
    if (inspection.kind === "unavailable") return { kind: "legacy-unavailable" };
    return { kind: "legacy-active" };
  }
  if (inspection.kind === "dead") return { kind: "stale" };
  if (inspection.kind === "unavailable") return { kind: "unavailable" };
  const expected = record.identity;
  if (
    inspection.identity.uid !== expected.uid
    || inspection.identity.startIdentity !== expected.startIdentity
    || inspection.identity.command !== expected.command
    || !commandMatches(inspection.identity.command, expected.expectedCommand)
  ) {
    return { kind: "stale" };
  }
  return { kind: "active" };
}

function markerIdentityError(marker: string): Error {
  return new Error(
    `Bootstrap interactive child marker ${marker} has no trusted process identity; verify no ${securityCommand} process remains, then remove the marker and retry`,
  );
}

function markerInspectionError(marker: string): Error {
  return new Error(
    `Bootstrap interactive child marker ${marker} could not be checked with ${psCommand}; verify no ${securityCommand} process remains, then retry`,
  );
}

async function removeRecoveredMarkers(
  ownerMarker: string,
  pidMarker: string,
): Promise<void> {
  if (await securityCommandIsRunning()) {
    throw new Error(
      `Bootstrap interactive child ownership could not be conclusively recovered; verify no ${securityCommand} process remains, then remove ${ownerMarker} and ${pidMarker} and retry`,
    );
  }
  await removePrivateChildMarker(ownerMarker);
  await removePrivateChildMarker(pidMarker);
}

export async function reconcileBootstrapCredentialChildMarkers(database: string): Promise<void> {
  const ownerMarker = bootstrapCredentialChildOwnerMarker(database);
  const pidMarker = bootstrapCredentialChildPidMarker(database);
  const ownerRecord = await readPrivateChildMarker(ownerMarker);
  const childRecord = await readPrivateChildMarker(pidMarker);
  if (ownerRecord.kind === "missing" && childRecord.kind === "missing") return;

  const ownerState = await inspectMarker(ownerRecord);
  const childState = await inspectMarker(childRecord);

  if (childRecord.kind !== "missing") {
    if (childState.kind === "active" || childState.kind === "legacy-active") {
      if (childState.kind === "legacy-active") throw markerIdentityError(pidMarker);
      throw childBusyError();
    }
    if (childState.kind === "unavailable" || childState.kind === "legacy-unavailable") {
      throw markerInspectionError(pidMarker);
    }
    if (ownerState.kind === "active" || ownerState.kind === "legacy-active") {
      if (ownerState.kind === "legacy-active") throw markerIdentityError(ownerMarker);
      throw childBusyError();
    }
    if (ownerState.kind === "unavailable" || ownerState.kind === "legacy-unavailable") {
      throw markerInspectionError(ownerMarker);
    }
    await removeRecoveredMarkers(ownerMarker, pidMarker);
    return;
  }

  if (ownerState.kind === "active" || ownerState.kind === "legacy-active") {
    if (ownerState.kind === "legacy-active") throw markerIdentityError(ownerMarker);
    throw childBusyError();
  }
  if (ownerState.kind === "unavailable" || ownerState.kind === "legacy-unavailable") {
    throw markerInspectionError(ownerMarker);
  }
  await removeRecoveredMarkers(ownerMarker, pidMarker);
}

function parentProcessIsAlive(parentPid: number): boolean {
  if (!Number.isInteger(parentPid) || parentPid <= 1) return false;
  if (process.ppid !== parentPid) return false;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForChildProcess(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Keychain command exited with ${signal ?? `code ${code ?? "unknown"}`}`));
    });
  });
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child exited between the state check and kill.
        }
      }
      resolve();
    }, 1_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function runBootstrapCredentialChild(
  database: string,
  request: KeychainStoreRequest,
  parentPid: number,
  withLock: BootstrapCredentialLockRunner,
): Promise<void> {
  await withLock(async () => {
    if (!parentProcessIsAlive(parentPid)) return;

    const ownerMarker = bootstrapCredentialChildOwnerMarker(database);
    const pidMarker = bootstrapCredentialChildPidMarker(database);
    await createPrivateChildMarker(ownerMarker, process.pid, process.execPath);
    let child: ChildProcess | undefined;
    let childMarkerCreated = false;
    let parentGone = false;
    let termination: Promise<void> | undefined;
    try {
      child = spawn(request.command, request.args, { stdio: "inherit" });
      if (typeof child.pid !== "number") throw new Error("Interactive Keychain child did not expose a process id");
      await createPrivateChildMarker(pidMarker, child.pid, request.command);
      childMarkerCreated = true;
      const requestTermination = (): Promise<void> => {
        if (termination === undefined) termination = terminateChildProcess(child!);
        return termination;
      };
      const monitor = setInterval(() => {
        if (parentProcessIsAlive(parentPid) || child === undefined) return;
        parentGone = true;
        void requestTermination();
      }, bootstrapCredentialLockRetryDelayMs);
      try {
        await waitForChildProcess(child);
      } finally {
        clearInterval(monitor);
      }
    } finally {
      if (child !== undefined && (!childMarkerCreated || parentGone)) {
        if (termination === undefined) termination = terminateChildProcess(child);
        await termination;
      }
      await removePrivateChildMarker(ownerMarker);
      await removePrivateChildMarker(pidMarker);
    }
  }, { database });
}

function helperNodeArguments(script: string): string[] {
  const inherited = [...process.execArgv];
  const filtered: string[] = [];
  let skipNext = false;
  for (const argument of inherited) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (argument === "-e" || argument === "--eval" || argument === "-p" || argument === "--print") {
      skipNext = true;
      continue;
    }
    if (argument === "--input-type" || argument.startsWith("--input-type=")) {
      if (argument === "--input-type") skipNext = true;
      continue;
    }
    filtered.push(argument);
  }
  return [...filtered, "--input-type=module", "-e", script];
}

export async function executeKeychainStoreProcess(
  request: KeychainStoreRequest,
  database: string,
  keychainModuleUrl: string,
): Promise<void> {
  const childModuleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const helperScript = `
    import { runBootstrapCredentialChild } from ${JSON.stringify(childModuleUrl)};
    import { withBootstrapCredentialLock } from ${JSON.stringify(keychainModuleUrl)};
    const database = process.env.CURSOR_BRIDGE_CHILD_LOCK_DATABASE;
    const command = process.env.CURSOR_BRIDGE_CHILD_COMMAND;
    const args = JSON.parse(process.env.CURSOR_BRIDGE_CHILD_ARGS ?? "[]");
    const parentPid = Number(process.env.CURSOR_BRIDGE_PARENT_PID);
    if (!database || !command || !Number.isInteger(parentPid)) {
      throw new Error("Invalid bootstrap child guard configuration");
    }
    await runBootstrapCredentialChild(database, { command, args }, parentPid, withBootstrapCredentialLock);
  `;
  const helper = spawn(
    process.execPath,
    helperNodeArguments(helperScript),
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CURSOR_BRIDGE_CHILD_LOCK_DATABASE: bootstrapCredentialChildLockDatabase(database),
        CURSOR_BRIDGE_CHILD_COMMAND: request.command,
        CURSOR_BRIDGE_CHILD_ARGS: JSON.stringify(request.args),
        CURSOR_BRIDGE_PARENT_PID: String(process.pid),
      },
    },
  );
  await waitForChildProcess(helper);
}
