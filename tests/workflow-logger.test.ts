import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const loggerModuleUrl = pathToFileURL(
  path.resolve(process.cwd(), "src/adapters/workflow-logger.ts"),
).href;

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

function runChild(
  script: string,
  environment: Record<string, string>,
): Promise<ChildResult> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...environment },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`logger child timed out; stderr=${stderr}`));
    }, 5_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
}

function runLoggerChild(logPath: string, eventKey: string, eventMessage: string): Promise<ChildResult> {
  return runChild(
    `
      const { FileWorkflowLogger } = await import(${JSON.stringify(loggerModuleUrl)});
      const logger = new FileWorkflowLogger(
        { get: () => ({ logPath: process.env.LOG_PATH }) },
        "job",
      );
      await logger.logEvent(process.env.EVENT_KEY, process.env.EVENT_MESSAGE);
    `,
    { LOG_PATH: logPath, EVENT_KEY: eventKey, EVENT_MESSAGE: eventMessage },
  );
}

function runPartialEventChild(logPath: string, eventKey: string): Promise<ChildResult> {
  return runChild(
    `
      import { createHash } from "node:crypto";
      import { open } from "node:fs/promises";
      const marker = "CURSOR_RUN_EVENT:" + createHash("sha256").update(process.env.EVENT_KEY).digest("hex");
      const handle = await open(process.env.LOG_PATH, "a", 0o600);
      await handle.write("[" + new Date().toISOString() + "] " + marker + "\\t" + "partial ".repeat(131072));
      process.kill(process.pid, "SIGKILL");
    `,
    { LOG_PATH: logPath, EVENT_KEY: eventKey },
  );
}

function runLegacyHolderChild(lockPath: string, readyPath: string): Promise<ChildResult> {
  return runChild(
    `
      import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
      await mkdir(process.env.LOCK_PATH);
      const ownerPath = process.env.LOCK_PATH + "/owner-live.json";
      await writeFile(ownerPath, JSON.stringify({
        pid: process.pid,
        token: "live-holder",
        startIdentity: "holder-test",
        state: "held",
      }), "utf8");
      await writeFile(process.env.READY_PATH, "ready", "utf8");
      const stale = new Date(Date.now() - 120000);
      await utimes(process.env.LOCK_PATH, stale, stale);
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(ownerPath, now, now);
      }, 10);
      await new Promise((resolve) => setTimeout(resolve, 350));
      clearInterval(heartbeat);
      await rm(process.env.LOCK_PATH, { recursive: true, force: true });
    `,
    { LOCK_PATH: lockPath, READY_PATH: readyPath },
  );
}

async function waitForPath(pathname: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await stat(pathname).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`test helper did not create ${pathname}`);
}

function runCrashChild(lockPath: string, partial: boolean): Promise<ChildResult> {
  return runChild(
    `
      import { mkdir, writeFile } from "node:fs/promises";
      await mkdir(process.env.LOCK_PATH);
      if (process.env.PARTIAL === "1") {
        await writeFile(process.env.OWNER_PATH, "{\\"pid\\":", "utf8");
      }
    `,
    {
      LOCK_PATH: lockPath,
      OWNER_PATH: path.join(lockPath, "owner-crashed.json"),
      PARTIAL: partial ? "1" : "0",
    },
  );
}

async function makeStale(pathname: string): Promise<void> {
  const stale = new Date(Date.now() - 120_000);
  await utimes(pathname, stale, stale);
}

describe("workflow logger lock recovery", () => {
  it("replays an event after SIGKILL leaves a partial marker line", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-log-partial-event-"));
    const logPath = path.join(root, "job.log");
    const eventKey = "partial-event-replay";
    const crashed = await runPartialEventChild(logPath, eventKey);
    expect(crashed.signal).toBe("SIGKILL");

    const firstRetry = await runLoggerChild(logPath, eventKey, "complete event");
    const secondRetry = await runLoggerChild(logPath, eventKey, "complete event");
    expect(firstRetry, firstRetry.stderr).toMatchObject({ code: 0, signal: null });
    expect(secondRetry, secondRetry.stderr).toMatchObject({ code: 0, signal: null });
    const log = await readFile(logPath, "utf8");
    expect(log.split("\n").filter((line) => line.includes("complete event"))).toHaveLength(1);
    expect(log.endsWith("\n")).toBe(true);
  });

  it("does not quarantine a live mixed-version owner whose child heartbeat is fresh", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-log-mixed-lock-"));
    const logPath = path.join(root, "job.log");
    const lockPath = `${logPath}.cursor-events.lock`;
    const readyPath = path.join(root, "holder.ready");
    const holderPromise = runLegacyHolderChild(lockPath, readyPath);
    await waitForPath(readyPath);
    const logger = await runLoggerChild(logPath, "mixed-version-live", "mixed-version recovered");
    const holder = await holderPromise;
    expect(holder, holder.stderr).toMatchObject({ code: 0, signal: null });
    expect(logger, logger.stderr).toMatchObject({ code: 0, signal: null });
    expect(await readFile(logPath, "utf8")).toContain("mixed-version recovered");
  });

  it("reclaims an empty lock left by a crashed process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-log-lock-empty-"));
    const logPath = path.join(root, "job.log");
    const lockPath = `${logPath}.cursor-events.lock`;
    const crashed = await runCrashChild(lockPath, false);
    expect(crashed, crashed.stderr).toMatchObject({ code: 0, signal: null });
    await makeStale(lockPath);

    const result = await runLoggerChild(logPath, "empty-recovery", "empty recovered");

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(await readFile(logPath, "utf8")).toContain("empty recovered");
  });

  it("reclaims a partially written owner left by a crashed process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-log-lock-partial-"));
    const logPath = path.join(root, "job.log");
    const lockPath = `${logPath}.cursor-events.lock`;
    const crashed = await runCrashChild(lockPath, true);
    expect(crashed, crashed.stderr).toMatchObject({ code: 0, signal: null });
    await makeStale(path.join(lockPath, "owner-crashed.json"));
    await makeStale(lockPath);

    const result = await runLoggerChild(logPath, "partial-recovery", "partial recovered");

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(await readFile(logPath, "utf8")).toContain("partial recovered");
  });

  it.each([
    ["legacy-json", JSON.stringify({ pid: 99_999_999, token: "legacy" })],
    ["legacy-empty", ""],
    ["legacy-partial", "{\"pid\":"],
  ])("quarantines an aged legacy regular-file lock without losing the log (%s)", async (_name, contents) => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-log-legacy-lock-"));
    const logPath = path.join(root, "job.log");
    const lockPath = `${logPath}.cursor-events.lock`;
    await writeFile(logPath, "prior diagnostic\n", "utf8");
    await writeFile(lockPath, contents, "utf8");
    await makeStale(lockPath);

    const result = await runLoggerChild(logPath, `legacy-${_name}`, "legacy recovered");

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(await readFile(logPath, "utf8")).toContain("prior diagnostic");
    expect(await readFile(logPath, "utf8")).toContain("legacy recovered");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let two reclaimers delete a newly claimed owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-log-lock-race-"));
    const logPath = path.join(root, "job.log");
    const lockPath = `${logPath}.cursor-events.lock`;
    await mkdir(lockPath);
    await writeFile(
      path.join(lockPath, "owner-dead.json"),
      JSON.stringify({ pid: 99_999_999, token: "dead", startIdentity: "dead", state: "held" }),
      "utf8",
    );
    await makeStale(path.join(lockPath, "owner-dead.json"));
    await makeStale(lockPath);

    const results = await Promise.all([
      runLoggerChild(logPath, "race-a", "race event a"),
      runLoggerChild(logPath, "race-b", "race event b"),
    ]);

    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    const log = await readFile(logPath, "utf8");
    expect(log.match(/race event a/g)).toHaveLength(1);
    expect(log.match(/race event b/g)).toHaveLength(1);
  });

  it("reclaims a stale owner when its PID is alive but its start identity differs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-log-lock-pid-"));
    const logPath = path.join(root, "job.log");
    const lockPath = `${logPath}.cursor-events.lock`;
    await mkdir(lockPath);
    await writeFile(
      path.join(lockPath, "owner-reused.json"),
      JSON.stringify({
        pid: process.pid,
        token: "reused",
        startIdentity: `not-current-${Date.now()}`,
        state: "held",
      }),
      "utf8",
    );
    await makeStale(path.join(lockPath, "owner-reused.json"));
    await makeStale(lockPath);

    const result = await runLoggerChild(logPath, "pid-reuse", "pid reused recovered");

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(await readFile(logPath, "utf8")).toContain("pid reused recovered");
  });
});
