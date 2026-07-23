import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFile } from "./git.js";

export const SUPERVISOR_LABEL = "com.codex-cursor-bridge.supervisor";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderSupervisorPlist(projectRoot: string, bridgeHome: string, nodePath: string): string {
  const root = path.resolve(projectRoot);
  const home = path.resolve(bridgeHome);
  const supervisor = path.join(root, "dist", "supervisor.js");
  const log = path.join(home, "supervisor.log");
  const runtimePath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
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

export async function installSupervisor(
  projectRoot: string,
  bridgeHome: string,
  nodePath = process.execPath,
): Promise<string> {
  if (process.platform !== "darwin") throw new Error("The local supervisor requires macOS launchd");
  const file = launchAgentFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await mkdir(bridgeHome, { recursive: true, mode: 0o700 });
  await writeFile(file, renderSupervisorPlist(projectRoot, bridgeHome, nodePath), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(file, 0o600);
  try {
    await runFile("launchctl", ["bootout", launchDomain(), file]);
  } catch {
    // A first install has no existing service.
  }
  await runFile("launchctl", ["bootstrap", launchDomain(), file]);
  await wakeSupervisor();
  return file;
}

export async function wakeSupervisor(): Promise<void> {
  if (process.platform !== "darwin") return;
  await runFile("launchctl", ["kickstart", `${launchDomain()}/${SUPERVISOR_LABEL}`]);
}

export async function uninstallSupervisor(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await runFile("launchctl", ["bootout", launchDomain(), launchAgentFile()]);
  } catch {
    // Already stopped or absent.
  }
  await rm(launchAgentFile(), { force: true });
}
