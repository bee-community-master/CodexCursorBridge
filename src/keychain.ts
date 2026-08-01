import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runFile } from "./git.js";
import {
  bootstrapCredentialChildLockDatabase,
  executeKeychainStoreProcess,
  isBootstrapCredentialChildBusy,
  reconcileBootstrapCredentialChildMarkers,
  runBootstrapCredentialChild as runBootstrapCredentialChildProcess,
  type BootstrapCredentialLockRunner,
  type KeychainStoreRequest,
} from "./keychain-child.js";

export type { KeychainStoreRequest } from "./keychain-child.js";

const keychainService = "codex-cursor-bridge";
const keychainAccount = "cursor-api-key";
const securityCommand = "/usr/bin/security";
const bootstrapCredentialLockName = ".bootstrap-keychain.sqlite";
const bootstrapCredentialLockTimeoutMs = 30_000;
const bootstrapCredentialLockRetryDelayMs = 25;

export type CursorApiKeyInspection =
  | { kind: "missing" }
  | { kind: "empty" }
  | { kind: "present"; value: string };

interface BootstrapCredentialLockHandle {
  database: DatabaseSync;
}

export interface BootstrapCredentialLockOptions {
  database?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function keychainStoreRequest(): KeychainStoreRequest {
  return {
    command: securityCommand,
    args: [
      "add-generic-password",
      "-s",
      keychainService,
      "-a",
      keychainAccount,
      "-w",
    ],
  };
}

export function isMissingKeychainItem(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === 44 || error.code === "44");
}

export function keychainReadError(error: unknown): Error {
  return isMissingKeychainItem(error)
    ? new Error("Cursor API key is not configured; run pnpm bootstrap")
    : new Error("Cursor API key could not be read from macOS Keychain");
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function lockPathError(): Error {
  return new Error("Bootstrap credential lock path must contain only plain directories and regular files");
}

async function assertPlainDirectoryIfPresent(directory: string): Promise<boolean> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw lockPathError();
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function ensurePlainDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw lockPathError();
  }
  if (!(await assertPlainDirectoryIfPresent(absolute))) throw lockPathError();
  const finalMetadata = await lstat(absolute);
  const isRootOwnedStickyDirectory = finalMetadata.uid === 0 && (finalMetadata.mode & 0o1000) !== 0;
  if (absolute !== parsed.root && !isRootOwnedStickyDirectory) await chmod(absolute, 0o700);
}

async function canonicalizeTrustedSystemAlias(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  if (process.platform !== "darwin") return absolute;

  // macOS exposes /tmp and /var as root-owned compatibility symlinks. Resolve
  // only these fixed aliases before the no-follow component walk; every
  // user-controlled component remains subject to the plain-directory check.
  for (const [alias, expectedTarget] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]] as const) {
    if (absolute !== alias && !absolute.startsWith(`${alias}${path.sep}`)) continue;
    let metadata;
    try {
      metadata = await lstat(alias);
    } catch (error) {
      if (isNotFound(error)) return absolute;
      throw error;
    }
    if (!metadata.isSymbolicLink() || metadata.uid !== 0) throw lockPathError();
    let target: string;
    try {
      target = await realpath(alias);
    } catch {
      throw lockPathError();
    }
    if (target !== expectedTarget) throw lockPathError();
    let targetMetadata;
    try {
      targetMetadata = await lstat(expectedTarget);
    } catch {
      throw lockPathError();
    }
    if (targetMetadata.isSymbolicLink() || !targetMetadata.isDirectory() || targetMetadata.uid !== 0) {
      throw lockPathError();
    }
    return path.join(expectedTarget, absolute.slice(alias.length));
  }
  return absolute;
}

function defaultBootstrapCredentialLockDatabase(): string {
  const home = process.env.CURSOR_BRIDGE_HOME
    ?? path.join(os.homedir(), ".config", "codex-cursor-bridge");
  return path.join(path.resolve(home), bootstrapCredentialLockName);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isSqliteBusy(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | undefined;
  return candidate?.code === "ERR_SQLITE_BUSY"
    || candidate?.code === "SQLITE_BUSY"
    || /(?:database is locked|SQLITE_BUSY)/i.test(String(candidate?.message ?? error));
}

interface DatabaseIdentity {
  dev: number;
  ino: number;
  uid: number;
  nlink: number;
}

type DatabaseFileMetadata = Awaited<ReturnType<typeof lstat>>;

function currentProcessUid(): number {
  if (typeof process.getuid !== "function") throw lockPathError();
  return process.getuid();
}

function identityFromMetadata(metadata: DatabaseFileMetadata): DatabaseIdentity {
  return {
    dev: Number(metadata.dev),
    ino: Number(metadata.ino),
    uid: Number(metadata.uid),
    nlink: Number(metadata.nlink),
  };
}

function assertPrivateDatabaseMetadata(
  metadata: DatabaseFileMetadata,
  ownerUid: number,
): DatabaseIdentity {
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.uid !== ownerUid
    || metadata.nlink !== 1
  ) {
    throw lockPathError();
  }
  return identityFromMetadata(metadata);
}

function sameDatabaseIdentity(left: DatabaseIdentity, right: DatabaseIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink;
}

async function ensurePrivateDatabaseFile(database: string): Promise<DatabaseIdentity> {
  const ownerUid = currentProcessUid();

  // The loop handles a concurrent creator without ever chmod-ing an
  // unvalidated path. Existing hardlinks are rejected before any mutation.
  while (true) {
    try {
      const metadata = await lstat(database);
      const identity = assertPrivateDatabaseMetadata(metadata, ownerUid);
      await chmod(database, 0o600);
      const afterChmod = await lstat(database);
      const afterIdentity = assertPrivateDatabaseMetadata(afterChmod, ownerUid);
      if (!sameDatabaseIdentity(identity, afterIdentity)) throw lockPathError();
      return afterIdentity;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    let handle;
    try {
      handle = await open(
        database,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    } finally {
      await handle?.close();
    }

    const metadata = await lstat(database);
    const identity = assertPrivateDatabaseMetadata(metadata, ownerUid);
    await chmod(database, 0o600);
    const afterChmod = await lstat(database);
    const afterIdentity = assertPrivateDatabaseMetadata(afterChmod, ownerUid);
    if (!sameDatabaseIdentity(identity, afterIdentity)) throw lockPathError();
    return afterIdentity;
  }
}

async function validateOpenDatabaseIdentity(
  database: string,
  expected: DatabaseIdentity,
  ownerUid: number,
): Promise<void> {
  let handle;
  try {
    // Use a no-follow descriptor and fstat it before trusting the pathname.
    handle = await open(database, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptorIdentity = assertPrivateDatabaseMetadata(await handle.stat(), ownerUid);
    const pathIdentity = assertPrivateDatabaseMetadata(await lstat(database), ownerUid);
    if (!sameDatabaseIdentity(descriptorIdentity, pathIdentity)
      || !sameDatabaseIdentity(descriptorIdentity, expected)) {
      throw lockPathError();
    }
  } finally {
    await handle?.close();
  }
}

async function openBootstrapCredentialDatabase(database: string): Promise<DatabaseSync> {
  const ownerUid = currentProcessUid();
  const expectedIdentity = await ensurePrivateDatabaseFile(database);
  await validateOpenDatabaseIdentity(database, expectedIdentity, ownerUid);
  const connection = new DatabaseSync(database);
  try {
    // Revalidate after SQLite opens the pathname and before taking the
    // transaction, so a replacement cannot redirect the lock to another
    // inode or a hardlink.
    await validateOpenDatabaseIdentity(database, expectedIdentity, ownerUid);
    // Keep the synchronous SQLite call non-blocking; the async retry loop
    // below owns the timeout so a same-process prompt can keep progressing.
    connection.exec("PRAGMA busy_timeout = 0");
    connection.exec("BEGIN IMMEDIATE");
    return connection;
  } catch (error) {
    try {
      connection.close();
    } catch {
      // Preserve the transaction/open error below.
    }
    throw error;
  }
}

async function acquireBootstrapCredentialLock(
  options: BootstrapCredentialLockOptions,
): Promise<BootstrapCredentialLockHandle> {
  const database = await canonicalizeTrustedSystemAlias(
    options.database ?? defaultBootstrapCredentialLockDatabase(),
  );
  const parent = path.dirname(database);
  const timeoutMs = options.timeoutMs ?? bootstrapCredentialLockTimeoutMs;
  const retryDelayMs = options.retryDelayMs ?? bootstrapCredentialLockRetryDelayMs;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;

  await ensurePlainDirectory(parent);
  while (true) {
    try {
      // A bootstrap child guard may outlive the primary transaction after a
      // crash. Check it before opening the primary lock so a waiting bootstrap
      // cannot prompt before the prior interactive child is contained.
      await reconcileBootstrapCredentialChildMarkers(bootstrapCredentialChildLockDatabase(database));
      await reconcileBootstrapCredentialChildMarkers(database);
      return { database: await openBootstrapCredentialDatabase(database) };
    } catch (error) {
      if (!isSqliteBusy(error) && !isBootstrapCredentialChildBusy(error)) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("Another bootstrap is already handling the Cursor API key");
    }
    await sleep(retryDelayMs);
  }
}

export async function withBootstrapCredentialLock<T>(
  work: () => Promise<T>,
  options: BootstrapCredentialLockOptions = {},
): Promise<T> {
  const handle = await acquireBootstrapCredentialLock(options);
  try {
    return await work();
  } finally {
    try {
      handle.database.exec("ROLLBACK");
    } catch {
      // SQLite may already have rolled back or the transaction may be closed.
    } finally {
      handle.database.close();
    }
  }
}

export function runBootstrapCredentialChild(
  database: string,
  request: KeychainStoreRequest,
  parentPid: number,
): Promise<void> {
  return runBootstrapCredentialChildProcess(
    database,
    request,
    parentPid,
    withBootstrapCredentialLock as BootstrapCredentialLockRunner,
  );
}

export async function executeKeychainStore(request: KeychainStoreRequest): Promise<void> {
  const database = await canonicalizeTrustedSystemAlias(defaultBootstrapCredentialLockDatabase());
  await executeKeychainStoreProcess(request, database, import.meta.url);
}

function assertMacOS(): void {
  if (process.platform !== "darwin") throw new Error("macOS Keychain is required in v1");
}

export async function inspectCursorApiKey(): Promise<CursorApiKeyInspection> {
  assertMacOS();
  try {
    const result = await runFile(securityCommand, [
      "find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w",
    ]);
    const key = result.stdout.trim();
    return key ? { kind: "present", value: key } : { kind: "empty" };
  } catch (error) {
    if (isMissingKeychainItem(error)) return { kind: "missing" };
    throw keychainReadError(error);
  }
}

export async function readCursorApiKey(): Promise<string> {
  const item = await inspectCursorApiKey();
  if (item.kind === "present") return item.value;
  throw new Error("Cursor API key is not configured; run pnpm bootstrap");
}

export async function storeCursorApiKey(): Promise<void> {
  assertMacOS();
  // Re-read immediately before any write. A non-empty item is never updated;
  // this is the boundary that prevents an aborted interactive prompt from
  // replacing a valid credential with an empty value.
  const current = await inspectCursorApiKey();
  if (current.kind === "present") return;
  if (!process.stdin.isTTY) {
    throw new Error("Interactive terminal is required for Keychain password input");
  }
  if (current.kind === "empty") await deleteCursorApiKey();
  await executeKeychainStore(keychainStoreRequest());
}

export interface EnsureCursorApiKeyDependencies {
  inspect?: () => Promise<CursorApiKeyInspection>;
  prompt?: () => void;
  store?: () => Promise<void>;
  withLock?: <T>(work: () => Promise<T>) => Promise<T>;
}

export async function ensureCursorApiKey(
  dependencies: EnsureCursorApiKeyDependencies = {},
): Promise<string> {
  const inspect = dependencies.inspect ?? inspectCursorApiKey;
  const prompt = dependencies.prompt ?? ((): void => {
    process.stdout.write("Enter the Cursor API key in the macOS Keychain prompt.\n");
  });
  const store = dependencies.store ?? storeCursorApiKey;

  const run = async (): Promise<string> => {
    const current = await inspect();
    if (current.kind === "present") return current.value;

    prompt();
    try {
      await store();
    } catch {
      // A failed/aborted prompt can race with another writer. Re-read before
      // surfacing the failure so a valid item is never discarded or masked.
      try {
        const recovered = await inspect();
        if (recovered.kind === "present") return recovered.value;
      } catch {
        // Preserve the redacted, stable store error below.
      }
      throw new Error(
        "Cursor API key could not be stored in macOS Keychain; bootstrap stopped before configuration changes",
      );
    }

    const stored = await inspect();
    if (stored.kind === "present") return stored.value;
    throw new Error(
      "Cursor API key was not stored in macOS Keychain; bootstrap stopped before configuration changes",
    );
  };

  const withLock = dependencies.withLock ?? withBootstrapCredentialLock;
  return withLock(run);
}

export async function deleteCursorApiKey(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await runFile(securityCommand, [
      "delete-generic-password",
      "-s",
      keychainService,
      "-a",
      keychainAccount,
    ]);
  } catch (error) {
    if (!isMissingKeychainItem(error)) throw error;
  }
}
