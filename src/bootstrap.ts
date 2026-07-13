import { Cursor } from "@cursor/sdk";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { emptyMachineConfig, loadMachineConfig, runtimePaths, saveMachineConfig } from "./config.js";
import { runFile } from "./git.js";
import { deleteCursorApiKey, storeCursorApiKey } from "./keychain.js";
import { removeManagedRegistrationBlocks, upsertManagedMcpBlock } from "./managed-config.js";

const agentMarker = "# Managed by codex-cursor-bridge bootstrap";
const marketplaceName = "coding-agent";

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

export async function installCodexRegistration(projectRoot: string, codexHome: string): Promise<{ configFile: string }> {
  const configFile = path.join(codexHome, "config.toml");
  const legacyAgentFile = path.join(codexHome, "agents", "cursor.toml");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });

  let config = "";
  try { config = await readFile(configFile, "utf8"); } catch { /* New Codex home. */ }
  const clean = removeManagedRegistrationBlocks(config);
  if (/^\[mcp_servers\.cursor_bridge\]\s*$/m.test(clean)) {
    throw new Error("An unmanaged [mcp_servers.cursor_bridge] registration already exists");
  }
  if (config) await copyFile(configFile, `${configFile}.cursor-bridge-backup-${Date.now()}`);
  await writeFile(configFile, upsertManagedMcpBlock(config, projectRoot), { encoding: "utf8", mode: 0o600 });
  try {
    const legacyAgent = await readFile(legacyAgentFile, "utf8");
    if (legacyAgent.startsWith(agentMarker)) await rm(legacyAgentFile);
  } catch { /* No managed legacy agent file. */ }
  return { configFile };
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
  process.stdout.write(`Installed Cursor Bridge MCP for the main Codex agent with Cursor model ${cursorModelId}.\nRestart Codex and open a new task.\n`);
}

export async function uninstall(projectRoot: string, deleteKey: boolean): Promise<void> {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const configFile = path.join(codexHome, "config.toml");
  const agentFile = path.join(codexHome, "agents", "cursor.toml");
  try {
    const config = await readFile(configFile, "utf8");
    await writeFile(configFile, removeManagedRegistrationBlocks(config), { encoding: "utf8", mode: 0o600 });
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
