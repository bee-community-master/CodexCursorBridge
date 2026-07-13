import { Cursor } from "@cursor/sdk";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { emptyMachineConfig, loadMachineConfig, runtimePaths, saveMachineConfig } from "./config.js";
import { runFile } from "./git.js";
import { deleteCursorApiKey, storeCursorApiKey } from "./keychain.js";
import { removeManagedAgentBlock, upsertManagedAgentBlock } from "./managed-config.js";

const agentMarker = "# Managed by codex-cursor-bridge bootstrap";
const marketplaceName = "coding-agent";

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function renderCursorAgentConfig(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  return `${agentMarker}
model = "gpt-5.6-luna"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
approval_policy = "never"
developer_instructions = """
You are CURSOR, a delegation agent. Never edit product files directly.
Accept only an approved repository alias, Task ID, spec version, and spec hash.
Use only the cursor_bridge MCP tools. Start a task exactly once, return the job ID,
monitor it when asked, and report exact status, artifacts, verification, PR URL, and errors.
Never rewrite requirements, invent a free-form Cursor prompt, or retry a stale/blocked task.
"""

[mcp_servers.cursor_bridge]
command = "node"
args = ["${escapeToml(path.join(root, "dist", "mcp.js"))}"]
cwd = "${escapeToml(root)}"
env = { CURSOR_BRIDGE_ROOT = "${escapeToml(root)}" }
enabled_tools = [
  "cursor_start_task",
  "cursor_get_task",
  "cursor_cancel_task",
  "cursor_get_report",
]
startup_timeout_sec = 20
tool_timeout_sec = 45
default_tools_approval_mode = "approve"
`;
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Interactive terminal is required for secret input");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Cancelled"));
        } else if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
        } else if (character === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

async function chooseGrok(apiKey: string): Promise<string> {
  const grok = (await Cursor.models.list({ apiKey })).filter((model) =>
    `${model.id} ${model.displayName}`.toLowerCase().includes("grok"),
  );
  if (grok.length === 0) throw new Error("No Grok model is available for this Cursor account");
  process.stdout.write("Available Grok models:\n");
  grok.forEach((model, index) => process.stdout.write(`  ${index + 1}. ${model.displayName} (${model.id})\n`));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question("Select model number: ");
  prompt.close();
  const selected = grok[Number(answer) - 1];
  if (!selected) throw new Error("Invalid Grok model selection");
  return selected.id;
}

async function installPlugin(projectRoot: string): Promise<void> {
  const listing = await runFile("codex", ["plugin", "marketplace", "list"]);
  const marketplaceExists = listing.stdout.includes(`\`${marketplaceName}\``);
  const pointsToCurrentClone = listing.stdout.includes(projectRoot);
  if (marketplaceExists && !pointsToCurrentClone) {
    try { await runFile("codex", ["plugin", "remove", `cursor-bridge@${marketplaceName}`]); } catch { /* May not be installed. */ }
    await runFile("codex", ["plugin", "marketplace", "remove", marketplaceName]);
  }
  if (!marketplaceExists || !pointsToCurrentClone) {
    await runFile("codex", ["plugin", "marketplace", "add", projectRoot]);
  }
  try { await runFile("codex", ["plugin", "remove", `cursor-bridge@${marketplaceName}`]); } catch { /* First install. */ }
  await runFile("codex", ["plugin", "add", `cursor-bridge@${marketplaceName}`]);
}

export async function installCodexRegistration(projectRoot: string, codexHome: string): Promise<{ agentFile: string; configFile: string }> {
  const agentsDir = path.join(codexHome, "agents");
  const agentFile = path.join(agentsDir, "cursor.toml");
  const configFile = path.join(codexHome, "config.toml");
  await mkdir(agentsDir, { recursive: true, mode: 0o700 });
  await writeFile(agentFile, renderCursorAgentConfig(projectRoot), { encoding: "utf8", mode: 0o600 });

  let config = "";
  try { config = await readFile(configFile, "utf8"); } catch { /* New Codex home. */ }
  const clean = removeManagedAgentBlock(config);
  if (/^\[agents\.cursor\]\s*$/m.test(clean)) throw new Error("An unmanaged [agents.cursor] role already exists");
  if (config) await copyFile(configFile, `${configFile}.cursor-bridge-backup-${Date.now()}`);
  await writeFile(configFile, upsertManagedAgentBlock(config, agentFile), { encoding: "utf8", mode: 0o600 });
  return { agentFile, configFile };
}

export async function bootstrap(projectRoot: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Cursor Bridge v1 supports macOS only");
  await runFile("pnpm", ["build"], { cwd: projectRoot, timeoutMs: 120_000 });
  const apiKey = await readSecret("Cursor API key (input hidden): ");
  await storeCursorApiKey(apiKey);
  const cursorModelId = await chooseGrok(apiKey);

  const paths = runtimePaths(projectRoot);
  let machineConfig = emptyMachineConfig(cursorModelId);
  try {
    const existing = await loadMachineConfig(paths.configFile);
    machineConfig = { ...existing, cursorModelId };
  } catch {
    // First install or a missing machine-local config.
  }
  await saveMachineConfig(paths.configFile, machineConfig);

  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  await installCodexRegistration(projectRoot, codexHome);
  await installPlugin(projectRoot);
  process.stdout.write(`Installed CURSOR role with model gpt-5.6-luna/medium and Cursor model ${cursorModelId}.\nRestart Codex and open a new task.\n`);
}

export async function uninstall(projectRoot: string, deleteKey: boolean): Promise<void> {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const configFile = path.join(codexHome, "config.toml");
  const agentFile = path.join(codexHome, "agents", "cursor.toml");
  try {
    const config = await readFile(configFile, "utf8");
    await writeFile(configFile, removeManagedAgentBlock(config), { encoding: "utf8", mode: 0o600 });
  } catch { /* Already absent. */ }
  try {
    const agent = await readFile(agentFile, "utf8");
    if (agent.startsWith(agentMarker)) await rm(agentFile);
  } catch { /* Already absent. */ }
  try { await runFile("codex", ["plugin", "remove", `cursor-bridge@${marketplaceName}`]); } catch { /* Already absent. */ }
  try { await runFile("codex", ["plugin", "marketplace", "remove", marketplaceName]); } catch { /* Already absent. */ }
  if (deleteKey) await deleteCursorApiKey();
  process.stdout.write(`Uninstalled Cursor Bridge registration for ${projectRoot}. Local job history was preserved.\n`);
}
