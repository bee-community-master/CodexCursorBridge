import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { withBootstrapCredentialLock } from "../src/keychain.js";

const execFileAsync = promisify(execFile);

interface MarkerIdentity {
  pid: number;
  uid: number;
  startIdentity: string;
  command: string;
  expectedCommand: string;
}

function markerText(pid: number, overrides: Partial<MarkerIdentity> = {}): string {
  return `${JSON.stringify({
    pid,
    uid: process.getuid?.() ?? 0,
    startIdentity: "stale-process-start",
    command: process.execPath,
    expectedCommand: process.execPath,
    ...overrides,
  })}\n`;
}

async function currentProcessIdentity(): Promise<Pick<MarkerIdentity, "uid" | "startIdentity" | "command">> {
  const result = await execFileAsync("/bin/ps", ["-p", String(process.pid), "-o", "uid=,lstart=,command="], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
  });
  const match = /^(\d+)\s+(.{24})\s+(.+)$/s.exec(String(result.stdout).trim());
  if (!match) throw new Error(`could not inspect test process: ${result.stdout}`);
  return {
    uid: Number(match[1]),
    startIdentity: match[2]!,
    command: match[3]!.trim(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

interface LockChild {
  child: ChildProcessWithoutNullStreams;
  getOutput: () => string;
  waitFor: (text: string, timeoutMs?: number) => Promise<void>;
  release: () => void;
}

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        waitForExit(child),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  }));
});

function launchLockChild(database: string, label: string): LockChild {
  const script = `
    import { withBootstrapCredentialLock } from "./src/keychain.ts";
    const database = process.env.LOCK_DB;
    const label = process.env.LOCK_LABEL;
    await withBootstrapCredentialLock(async () => {
      process.stdout.write("ENTER " + label + "\\n");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      process.stdout.write("EXIT " + label + "\\n");
    }, { database, timeoutMs: 5_000, retryDelayMs: 5 });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOCK_DB: database, LOCK_LABEL: label },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  let output = "";
  const waiters: Array<{ text: string; resolve: () => void; reject: (error: Error) => void }> = [];
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    for (const waiter of [...waiters]) {
      if (!output.includes(waiter.text)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  return {
    child,
    getOutput: () => output,
    waitFor: (text: string, timeoutMs = 5_000): Promise<void> => {
      if (output.includes(text)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = { text, resolve, reject };
        waiters.push(waiter);
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`child ${label} timed out waiting for ${text}; output=${output}`));
        }, timeoutMs);
        const originalResolve = waiter.resolve;
        waiter.resolve = (): void => {
          clearTimeout(timeout);
          originalResolve();
        };
      });
    },
    release: (): void => {
      child.stdin.write("\\n");
      child.stdin.end();
    },
  };
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("lock child did not exit"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForFileText(file: string, text: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(file, "utf8");
      if (contents.includes(text)) return contents;
    } catch {
      // The child has not created the marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${text} in ${file}`);
}

async function waitForDirectoryEntry(
  directory: string,
  predicate: (name: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const name = (await readdir(directory)).find(predicate);
      if (name !== undefined) return path.join(directory, name);
    } catch {
      // The lock directory has not been created yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for an entry in ${directory}`);
}

async function waitForProcessGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} did not exit`);
}

describe("bootstrap credential SQLite lock", () => {
  it("serializes concurrent in-process bootstraps without blocking the event loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-sqlite-"));
    const database = path.join(root, "bootstrap-keychain.sqlite");
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    let active = 0;
    let maximumActive = 0;

    const first = withBootstrapCredentialLock(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      firstEntered.resolve();
      await releaseFirst.promise;
      active -= 1;
    }, { database, timeoutMs: 1_000, retryDelayMs: 1 });
    await firstEntered.promise;

    const second = withBootstrapCredentialLock(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      secondEntered.resolve();
      active -= 1;
    }, { database, timeoutMs: 1_000, retryDelayMs: 1 });
    await Promise.resolve();
    expect(secondEntered.promise).toBeDefined();
    expect(active).toBe(1);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
  });

  it("times out behind an active transaction and leaves the lock database intact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-timeout-"));
    const database = path.join(root, "bootstrap-keychain.sqlite");
    const entered = deferred();
    const release = deferred();
    const holder = withBootstrapCredentialLock(async () => {
      entered.resolve();
      await release.promise;
    }, { database, timeoutMs: 1_000, retryDelayMs: 1 });
    await entered.promise;

    await expect(withBootstrapCredentialLock(async () => undefined, {
      database,
      timeoutMs: 25,
      retryDelayMs: 1,
    })).rejects.toThrow(/another bootstrap/i);
    expect((await stat(database)).isFile()).toBe(true);
    release.resolve();
    await holder;
  });

  it("rolls back and closes the transaction when the protected work throws", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-rollback-"));
    const database = path.join(root, "bootstrap-keychain.sqlite");
    await expect(withBootstrapCredentialLock(async () => {
      throw new Error("protected failure");
    }, { database, timeoutMs: 1_000, retryDelayMs: 1 })).rejects.toThrow("protected failure");
    await expect(withBootstrapCredentialLock(async () => "recovered", {
      database,
      timeoutMs: 1_000,
      retryDelayMs: 1,
    })).resolves.toBe("recovered");
  });

  it("serializes three independent processes without a canonical lock gap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-processes-"));
    const database = path.join(root, "bootstrap-keychain.sqlite");
    const first = launchLockChild(database, "A");
    await first.waitFor("ENTER A");
    const second = launchLockChild(database, "B");
    const third = launchLockChild(database, "C");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second.getOutput()).not.toContain("ENTER B");
    expect(third.getOutput()).not.toContain("ENTER C");

    first.release();
    const firstNext = await Promise.race([
      second.waitFor("ENTER B").then(() => second),
      third.waitFor("ENTER C").then(() => third),
    ]);
    firstNext.release();
    const secondNext = firstNext === second ? third : second;
    await secondNext.waitFor(firstNext === second ? "ENTER C" : "ENTER B");
    secondNext.release();
    await Promise.all([waitForExit(first.child), waitForExit(second.child), waitForExit(third.child)]);
    expect(first.getOutput()).toContain("EXIT A");
    expect(second.getOutput()).toContain("EXIT B");
    expect(third.getOutput()).toContain("EXIT C");
  });

  it("releases the transaction when the holder process crashes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-crash-"));
    const database = path.join(root, "bootstrap-keychain.sqlite");
    const holder = launchLockChild(database, "CRASH");
    await holder.waitFor("ENTER CRASH");
    holder.child.kill("SIGKILL");
    await waitForExit(holder.child);

    await expect(withBootstrapCredentialLock(async () => "recovered", {
      database,
      timeoutMs: 1_000,
      retryDelayMs: 1,
    })).resolves.toBe("recovered");
  });

  it("serializes two runtime homes through the owner-global default lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-global-home-"));
    const globalHome = path.join(root, "owner-home");
    const firstHome = path.join(root, "runtime-home-first");
    const secondHome = path.join(root, "runtime-home-second");
    const events = path.join(root, "events.log");
    const credential = path.join(root, "credential");
    const active = path.join(root, "active");
    const parentScript = `
      import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
      import { ensureCursorApiKey, withBootstrapCredentialLock } from "./src/keychain.ts";
      const mode = process.env.PROBE_MODE;
      const events = process.env.PROBE_EVENTS;
      const credential = process.env.PROBE_CREDENTIAL;
      const active = process.env.PROBE_ACTIVE;
      await ensureCursorApiKey({
        inspect: async () => existsSync(credential)
          ? { kind: "present", value: "probe-key" }
          : { kind: "missing" },
        prompt: () => appendFileSync(events, "PROMPT " + mode + "\\n"),
        store: async () => {
          let ownsActive = false;
          try {
            writeFileSync(active, mode, { flag: "wx" });
            ownsActive = true;
          } catch {
            appendFileSync(events, "OVERLAP " + mode + "\\n");
          }
          appendFileSync(events, "STORE START " + mode + "\\n");
          await new Promise((resolve) => setTimeout(resolve, 150));
          try {
            writeFileSync(credential, "probe-key", { flag: "wx" });
          } catch {
            appendFileSync(events, "STORE CONFLICT " + mode + "\\n");
          }
          if (ownsActive) unlinkSync(active);
          appendFileSync(events, "STORE END " + mode + "\\n");
        },
        withLock: (work) => withBootstrapCredentialLock(work, { timeoutMs: 5_000, retryDelayMs: 5 }),
      });
    `;
    const launchParent = (mode: string, home: string): ChildProcessWithoutNullStreams => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", parentScript],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: globalHome,
            CURSOR_BRIDGE_HOME: home,
            PROBE_MODE: mode,
            PROBE_EVENTS: events,
            PROBE_CREDENTIAL: credential,
            PROBE_ACTIVE: active,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.push(child);
      return child;
    };

    const first = launchParent("first", firstHome);
    const second = launchParent("second", secondHome);
    await Promise.all([waitForExit(first), waitForExit(second)]);
    const contents = await readFile(events, "utf8");
    expect(contents.match(/^PROMPT /gm)).toHaveLength(1);
    expect(contents.match(/^STORE START /gm)).toHaveLength(1);
    expect(contents.match(/^STORE END /gm)).toHaveLength(1);
    expect(contents).not.toContain("OVERLAP");
    expect(contents).not.toContain("STORE CONFLICT");
    expect(await readFile(credential, "utf8")).toBe("probe-key");
  });

  it("keeps an interactive child guarded across homes and timezone changes after its bootstrap parent is SIGKILLed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-child-crash-"));
    const marker = path.join(root, "prompt-events.log");
    const release = path.join(root, "release-first");
    const globalHome = path.join(root, "owner-home");
    const firstHome = path.join(root, "runtime-home-first");
    const secondHome = path.join(root, "runtime-home-second");
    const lockDirectory = path.join(globalHome, ".config", "codex-cursor-bridge");
    const probeScript = `
      import { appendFileSync, existsSync } from "node:fs";
      const marker = process.env.PROBE_MARKER;
      const release = process.env.PROBE_RELEASE;
      const mode = process.env.PROBE_MODE;
      appendFileSync(marker, "START " + mode + " " + process.pid + "\\n");
      if (mode !== "first") {
        appendFileSync(marker, "EXIT " + mode + " " + process.pid + "\\n");
        process.exit(0);
      }
      process.on("SIGTERM", () => {
        appendFileSync(marker, "TERM first " + process.pid + "\\n");
        const timer = setInterval(() => {
          if (!existsSync(release)) return;
          clearInterval(timer);
          appendFileSync(marker, "EXIT first " + process.pid + "\\n");
          process.exit(0);
        }, 10);
      });
      setInterval(() => undefined, 1_000);
    `;
    const parentScript = `
      import { appendFileSync } from "node:fs";
      import { ensureCursorApiKey, executeKeychainStore, withBootstrapCredentialLock } from "./src/keychain.ts";
      const request = {
        command: process.execPath,
        args: ["--input-type=module", "-e", ${JSON.stringify(probeScript)}],
      };
      let inspections = 0;
      await ensureCursorApiKey({
        inspect: async () => inspections++ === 0
          ? { kind: "missing" }
          : { kind: "present", value: "probe-key" },
        prompt: () => appendFileSync(process.env.PROBE_MARKER, "PROMPT " + process.env.PROBE_MODE + "\\n"),
        store: () => executeKeychainStore(request, { database: process.env.PRIMARY_DB }),
        withLock: (work) => withBootstrapCredentialLock(
          work,
          { timeoutMs: 5_000, retryDelayMs: 5 },
        ),
      });
    `;
    const launchParent = (mode: string, timezone: string, home: string): ChildProcessWithoutNullStreams => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", parentScript],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: globalHome,
            CURSOR_BRIDGE_HOME: home,
            PROBE_MARKER: marker,
            PROBE_RELEASE: release,
            PROBE_MODE: mode,
            TZ: timezone,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.push(child);
      return child;
    };

    const first = launchParent("first", "UTC", firstHome);
    const firstContents = await waitForFileText(marker, "START first");
    const firstPid = Number(firstContents.match(/START first (\d+)/)?.[1]);
    expect(Number.isInteger(firstPid)).toBe(true);
    const ownerMarker = await waitForDirectoryEntry(lockDirectory, (name) => name.endsWith(".owner"));
    const pidMarker = ownerMarker.replace(/\.owner$/, ".pid");
    await waitForFileText(pidMarker, "\n");
    first.kill("SIGKILL");
    await waitForExit(first);
    await waitForFileText(marker, "TERM first");

    const second = launchParent("second", "Asia/Seoul", secondHome);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const blocked = await readFile(marker, "utf8");
    expect(blocked).not.toContain("PROMPT second");
    expect(blocked).not.toContain("START second");
    await expect(readFile(ownerMarker, "utf8")).resolves.toContain("startIdentity");
    await expect(readFile(pidMarker, "utf8")).resolves.toContain("startIdentity");

    await writeFile(release, "release\n", { flag: "wx" });
    await waitForFileText(marker, "EXIT first");
    await waitForFileText(marker, "EXIT second");
    await waitForExit(second);
    expect(second.exitCode).toBe(0);
    const starts = (await readFile(marker, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("START "));
    expect(starts).toHaveLength(2);
    expect(starts[0]).toContain("START first");
    expect(starts[1]).toContain("START second");
  });

  it("fails closed across timezone changes if the child owner itself crashes while its child is alive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-owner-crash-"));
    const marker = path.join(root, "prompt-events.log");
    const database = path.join(root, ".bootstrap-keychain.sqlite");
    const childDatabase = `${database}.security-child.sqlite`;
    const ownerMarker = `${childDatabase}.owner`;
    const pidMarker = `${childDatabase}.pid`;
    const probeScript = `
      import { appendFileSync } from "node:fs";
      const marker = process.env.PROBE_MARKER;
      const mode = process.env.PROBE_MODE;
      appendFileSync(marker, "START " + mode + " " + process.pid + "\\n");
      if (mode !== "first") {
        appendFileSync(marker, "EXIT " + mode + " " + process.pid + "\\n");
        process.exit(0);
      }
      setInterval(() => undefined, 1_000);
    `;
    const parentScript = `
      import { appendFileSync } from "node:fs";
      import { ensureCursorApiKey, executeKeychainStore, withBootstrapCredentialLock } from "./src/keychain.ts";
      const request = {
        command: process.execPath,
        args: ["--input-type=module", "-e", ${JSON.stringify(probeScript)}],
      };
      let inspections = 0;
      await ensureCursorApiKey({
        inspect: async () => inspections++ === 0
          ? { kind: "missing" }
          : { kind: "present", value: "probe-key" },
        prompt: () => appendFileSync(process.env.PROBE_MARKER, "PROMPT " + process.env.PROBE_MODE + "\\n"),
        store: () => executeKeychainStore(request, { database: process.env.PRIMARY_DB }),
        withLock: (work) => withBootstrapCredentialLock(
          work,
          { database: process.env.PRIMARY_DB, timeoutMs: 5_000, retryDelayMs: 5 },
        ),
      });
    `;
    const launchParent = (mode: string, timezone: string): ChildProcessWithoutNullStreams => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", parentScript],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CURSOR_BRIDGE_HOME: root,
            PRIMARY_DB: database,
            PROBE_MARKER: marker,
            PROBE_MODE: mode,
            TZ: timezone,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.push(child);
      return child;
    };

    const first = launchParent("first", "UTC");
    const firstContents = await waitForFileText(marker, "START first");
    const firstPid = Number(firstContents.match(/START first (\d+)/)?.[1]);
    const ownerPid = (JSON.parse(await waitForFileText(ownerMarker, "\n")) as MarkerIdentity).pid;
    const childPid = (JSON.parse(await waitForFileText(pidMarker, "\n")) as MarkerIdentity).pid;
    expect(Number.isInteger(firstPid)).toBe(true);
    expect(Number.isInteger(ownerPid)).toBe(true);
    expect(Number.isInteger(childPid)).toBe(true);

    process.kill(ownerPid, "SIGKILL");
    await waitForProcessGone(ownerPid);
    await waitForExit(first);

    const second = launchParent("second", "Asia/Seoul");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const blocked = await readFile(marker, "utf8");
    expect(blocked).not.toContain("PROMPT second");
    expect(blocked).not.toContain("START second");
    await expect(readFile(ownerMarker, "utf8")).resolves.toContain("startIdentity");
    await expect(readFile(pidMarker, "utf8")).resolves.toContain("startIdentity");

    process.kill(childPid, "SIGKILL");
    await waitForProcessGone(childPid);
    await waitForFileText(marker, "START second");
    await waitForFileText(marker, "EXIT second");
    await waitForExit(second);
    expect(second.exitCode).toBe(0);
    const starts = (await readFile(marker, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("START "));
    expect(starts).toHaveLength(2);
    expect(starts[0]).toContain("START first");
    expect(starts[1]).toContain("START second");
  });

  it("recovers a dead spawn owner only after the native security command is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-owner-recovery-"));
    const database = path.join(root, ".bootstrap-keychain.sqlite");
    const ownerMarker = `${database}.security-child.sqlite.owner`;
    await writeFile(ownerMarker, markerText(2147483647), { mode: 0o600 });
    await chmod(ownerMarker, 0o600);

    await expect(withBootstrapCredentialLock(async () => "recovered", {
      database,
      timeoutMs: 1_000,
      retryDelayMs: 1,
    })).resolves.toBe("recovered");
    await expect(lstat(ownerMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not treat a reused owner PID with a different start identity as active", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-owner-pid-reuse-"));
    const database = path.join(root, ".bootstrap-keychain.sqlite");
    const ownerMarker = `${database}.security-child.sqlite.owner`;
    await writeFile(ownerMarker, markerText(process.pid), { mode: 0o600 });

    await expect(withBootstrapCredentialLock(async () => "recovered", {
      database,
      timeoutMs: 1_000,
      retryDelayMs: 1,
    })).resolves.toBe("recovered");
    await expect(lstat(ownerMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("does not treat a reused child PID with a different start identity as active", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-child-pid-reuse-"));
    const database = path.join(root, ".bootstrap-keychain.sqlite");
    const childDatabase = `${database}.security-child.sqlite`;
    const ownerMarker = `${childDatabase}.owner`;
    const pidMarker = `${childDatabase}.pid`;
    await writeFile(ownerMarker, markerText(2147483647), { mode: 0o600 });
    await writeFile(pidMarker, markerText(process.pid), { mode: 0o600 });

    await expect(withBootstrapCredentialLock(async () => "recovered", {
      database,
      timeoutMs: 1_000,
      retryDelayMs: 1,
    })).resolves.toBe("recovered");
    await expect(lstat(ownerMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(pidMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("recovers a marker with a nonmatching command without killing the current process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-command-reuse-"));
    const database = path.join(root, ".bootstrap-keychain.sqlite");
    const ownerMarker = `${database}.security-child.sqlite.owner`;
    const identity = await currentProcessIdentity();
    await writeFile(ownerMarker, markerText(process.pid, {
      ...identity,
      command: "/bin/sh",
      expectedCommand: "/bin/sh",
    }), { mode: 0o600 });

    await expect(withBootstrapCredentialLock(async () => "recovered", {
      database,
      timeoutMs: 1_000,
      retryDelayMs: 1,
    })).resolves.toBe("recovered");
    await expect(lstat(ownerMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("creates owner-only parent and database files without storing secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-permissions-"));
    const database = path.join(root, "nested", "bootstrap-keychain.sqlite");
    await withBootstrapCredentialLock(async () => undefined, { database });
    const parentMetadata = await stat(path.dirname(database));
    const databaseMetadata = await stat(database);
    expect(parentMetadata.mode & 0o777).toBe(0o700);
    expect(databaseMetadata.mode & 0o777).toBe(0o600);
    expect(await readFile(database, "utf8")).not.toContain("cursor-secret");
  });

  it("fails closed for a symlinked database or ancestor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-paths-"));
    const targetDatabase = path.join(root, "target.sqlite");
    await writeFile(targetDatabase, "unchanged\n", { mode: 0o600 });
    const linkedDatabase = path.join(root, "bootstrap-keychain.sqlite");
    await symlink(targetDatabase, linkedDatabase);
    await expect(withBootstrapCredentialLock(async () => undefined, {
      database: linkedDatabase,
    })).rejects.toThrow(/plain directories and regular files/i);
    expect((await lstat(linkedDatabase)).isSymbolicLink()).toBe(true);
    await expect(readFile(targetDatabase, "utf8")).resolves.toBe("unchanged\n");

    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await mkdir(path.join(target, "nested"), { mode: 0o700, recursive: true });
    await symlink(target, link);
    await expect(withBootstrapCredentialLock(async () => undefined, {
      database: path.join(link, "nested", "bootstrap-keychain.sqlite"),
    })).rejects.toThrow(/plain directories and regular files/i);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("rejects a hardlink to an arbitrary peer before changing its mode or bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-hardlink-peer-"));
    const peer = path.join(root, "operator.txt");
    const database = path.join(root, "bootstrap-keychain.sqlite");
    await writeFile(peer, "operator-owned bytes\n", { mode: 0o700 });
    await chmod(peer, 0o700);
    await link(peer, database);
    const before = await stat(peer);
    const beforeBytes = await readFile(peer);

    await expect(withBootstrapCredentialLock(async () => undefined, { database }))
      .rejects.toThrow(/plain directories and regular files/i);

    const after = await stat(peer);
    expect(await readFile(peer)).toEqual(beforeBytes);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.nlink).toBe(2);
  });

  it("rejects a hardlink to jobs.sqlite without taking or changing its SQLite lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-hardlink-jobs-"));
    const peer = path.join(root, "jobs.sqlite");
    const database = path.join(root, "bootstrap-keychain.sqlite");
    const jobs = new DatabaseSync(peer);
    try {
      jobs.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY)");
    } finally {
      jobs.close();
    }
    await chmod(peer, 0o600);
    await link(peer, database);
    const before = await stat(peer);
    const beforeBytes = await readFile(peer);

    const holder = new DatabaseSync(peer);
    holder.exec("BEGIN IMMEDIATE");
    try {
      await expect(withBootstrapCredentialLock(async () => undefined, { database }))
        .rejects.toThrow(/plain directories and regular files/i);
      expect(() => holder.exec("INSERT INTO jobs DEFAULT VALUES")).not.toThrow();
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }

    const after = await stat(peer);
    expect(await readFile(peer)).toEqual(beforeBytes);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.nlink).toBe(2);
  });

  it("rejects a database directory instead of following it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-directory-"));
    const database = path.join(root, "bootstrap-keychain.sqlite");
    await mkdir(database, { mode: 0o700 });
    await expect(withBootstrapCredentialLock(async () => undefined, { database }))
      .rejects.toThrow(/plain directories and regular files/i);
  });

  it("does not write the credential into the SQLite lock database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-redaction-"));
    const database = path.join(root, "bootstrap-keychain.sqlite");
    await withBootstrapCredentialLock(async () => undefined, { database });
    expect(await readFile(database)).not.toContain(Buffer.from("cursor-secret"));
  });

  it("keeps the dedicated database separate from the configured home contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-keychain-home-"));
    const database = path.join(root, ".bootstrap-keychain.sqlite");
    await chmod(root, 0o700);
    await withBootstrapCredentialLock(async () => undefined, { database });
    expect((await lstat(database)).isSymbolicLink()).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});
