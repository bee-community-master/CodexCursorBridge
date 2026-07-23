import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFile } from "./git.js";

export const SUPERVISOR_LABEL = "com.codex-cursor-bridge.supervisor";
const fallbackExecutablePath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const launchctlCommand = "/bin/launchctl";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function executablePath(value: string | undefined): string {
  const entries = (value ?? fallbackExecutablePath)
    .split(path.delimiter)
    .filter((entry) =>
      entry.length > 0
      && path.isAbsolute(entry)
      && !/[\0\r\n]/.test(entry),
    );
  return [...new Set(entries)].join(path.delimiter) || fallbackExecutablePath;
}

export function renderSupervisorPlist(
  projectRoot: string,
  bridgeHome: string,
  nodePath: string,
  inheritedPath = process.env.PATH,
): string {
  const root = path.resolve(projectRoot);
  const home = path.resolve(bridgeHome);
  const supervisor = path.join(root, "dist", "supervisor.js");
  const log = path.join(home, "supervisor.log");
  const runtimePath = executablePath(inheritedPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SUPERVISOR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(path.resolve(nodePath))}</string>
    <string>${xml(supervisor)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CURSOR_BRIDGE_ROOT</key>
    <string>${xml(root)}</string>
    <key>CURSOR_BRIDGE_HOME</key>
    <string>${xml(home)}</string>
    <key>PATH</key>
    <string>${xml(runtimePath)}</string>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function launchAgentFile(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${SUPERVISOR_LABEL}.plist`);
}

function launchDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the current user id for launchd");
  return `gui/${uid}`;
}

function launchServiceTarget(): string {
  return `${launchDomain()}/${SUPERVISOR_LABEL}`;
}

export async function writeSupervisorPlist(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function isMissingLaunchdService(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === 113;
}

async function isSupervisorLoaded(): Promise<boolean> {
  try {
    await runFile(launchctlCommand, ["print", launchServiceTarget()]);
    return true;
  } catch (error) {
    if (isMissingLaunchdService(error)) return false;
    throw error;
  }
}

export async function installSupervisor(
  projectRoot: string,
  bridgeHome: string,
  nodePath = process.execPath,
): Promise<string> {
  if (process.platform !== "darwin") throw new Error("The local supervisor requires macOS launchd");
  const file = launchAgentFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await mkdir(bridgeHome, { recursive: true, mode: 0o700 });
  await writeSupervisorPlist(file, renderSupervisorPlist(projectRoot, bridgeHome, nodePath));
  await chmod(file, 0o600);
  if (await isSupervisorLoaded()) {
    await runFile(launchctlCommand, ["bootout", launchServiceTarget()]);
  }
  await runFile(launchctlCommand, ["bootstrap", launchDomain(), file]);
  await wakeSupervisor();
  return file;
}

export async function wakeSupervisor(): Promise<void> {
  if (process.platform !== "darwin") return;
  await runFile(launchctlCommand, ["kickstart", launchServiceTarget()]);
}

export async function uninstallSupervisor(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (await isSupervisorLoaded()) {
    await runFile(launchctlCommand, ["bootout", launchServiceTarget()]);
  }
  await rm(launchAgentFile(), { force: true });
}
