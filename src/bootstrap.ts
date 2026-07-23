import { Cursor } from "@cursor/sdk";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { emptyMachineConfig, loadMachineConfig, runtimePaths, saveMachineConfig } from "./config.js";
import { runFile } from "./git.js";
import {
  deleteCursorApiKey,
  readCursorApiKey,
  storeCursorApiKey,
} from "./keychain.js";
import { installSupervisor, uninstallSupervisor } from "./launchd.js";
import { removeManagedRegistrationBlocks, upsertManagedMcpBlock } from "./managed-config.js";

const agentMarker = "# Managed by codex-cursor-bridge bootstrap";
const marketplaceName = "coding-agent";
const pluginId = `cursor-bridge@${marketplaceName}`;

const marketplaceListSchema = z.object({
  marketplaces: z.array(z.object({
    name: z.string(),
    root: z.string(),
  })),
});

const pluginListSchema = z.object({
  installed: z.array(z.object({
    pluginId: z.string(),
  })),
});

async function configuredMarketplace(): Promise<{ name: string; root: string } | undefined> {
  const output = await runFile(
    "codex",
    ["plugin", "marketplace", "list", "--json"],
  );
  const marketplaces = marketplaceListSchema.parse(
    JSON.parse(output.stdout),
  ).marketplaces.filter((item) => item.name === marketplaceName);
  if (marketplaces.length > 1) {
    throw new Error(`Multiple Codex marketplaces use the name ${marketplaceName}`);
  }
  return marketplaces[0];
}

async function isPluginInstalled(): Promise<boolean> {
  const output = await runFile("codex", ["plugin", "list", "--json"]);
  return pluginListSchema.parse(
    JSON.parse(output.stdout),
  ).installed.some((item) => item.pluginId === pluginId);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

async function readOptionalPlainFile(file: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Codex config must be a plain file, not a symbolic link");
    }
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeOwnerOnlyAtomic(file: string, content: string): Promise<void> {
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

export async function installPlugin(projectRoot: string): Promise<void> {
  const marketplace = await configuredMarketplace();
  const pointsToCurrentClone = marketplace !== undefined
    && path.resolve(marketplace.root) === path.resolve(projectRoot);

  if (await isPluginInstalled()) {
    await runFile("codex", ["plugin", "remove", pluginId]);
  }
  if (marketplace && !pointsToCurrentClone) {
    await runFile("codex", ["plugin", "marketplace", "remove", marketplaceName]);
  }
  if (!pointsToCurrentClone) {
    await runFile("codex", ["plugin", "marketplace", "add", projectRoot]);
  }
  await runFile("codex", ["plugin", "add", pluginId]);
}

export async function uninstallPlugin(): Promise<void> {
  if (await isPluginInstalled()) {
    await runFile("codex", ["plugin", "remove", pluginId]);
  }
  if (await configuredMarketplace()) {
    await runFile("codex", ["plugin", "marketplace", "remove", marketplaceName]);
  }
}

export async function installCodexRegistration(projectRoot: string, codexHome: string): Promise<{ configFile: string }> {
  const configFile = path.join(codexHome, "config.toml");
  const legacyAgentFile = path.join(codexHome, "agents", "cursor.toml");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });

  const config = await readOptionalPlainFile(configFile) ?? "";
  const clean = removeManagedRegistrationBlocks(config);
  if (/^\[mcp_servers\.cursor_bridge\]\s*$/m.test(clean)) {
    throw new Error("An unmanaged [mcp_servers.cursor_bridge] registration already exists");
  }
  if (config) {
    const backupFile = `${configFile}.cursor-bridge-backup-${Date.now()}-${randomUUID()}`;
    await writeFile(backupFile, config, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(backupFile, 0o600);
  }
  await writeOwnerOnlyAtomic(configFile, upsertManagedMcpBlock(config, projectRoot));
  try {
    const legacyAgent = await readFile(legacyAgentFile, "utf8");
    if (legacyAgent.startsWith(agentMarker)) await rm(legacyAgentFile);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return { configFile };
}

export async function loadBootstrapConfig(
  configFile: string,
  cursorModelId: string,
): Promise<ReturnType<typeof emptyMachineConfig>> {
  try {
    const existing = await loadMachineConfig(configFile);
    return { ...existing, cursorModelId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return emptyMachineConfig(cursorModelId);
  }
}

export async function bootstrap(projectRoot: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Cursor Bridge v1 supports macOS only");
  await runFile("pnpm", ["build"], { cwd: projectRoot, timeoutMs: 120_000 });
  process.stdout.write("Enter the Cursor API key in the macOS Keychain prompt.\n");
  await storeCursorApiKey();
  const apiKey = await readCursorApiKey();
  const cursorModelId = await chooseGrok(apiKey);

  const paths = runtimePaths(projectRoot);
  const machineConfig = await loadBootstrapConfig(paths.configFile, cursorModelId);
  await saveMachineConfig(paths.configFile, machineConfig);

  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  await installCodexRegistration(projectRoot, codexHome);
  await installPlugin(projectRoot);
  await installSupervisor(projectRoot, paths.home);
  process.stdout.write(`Installed Cursor Bridge MCP and launchd supervisor with Cursor model ${cursorModelId}.\nRestart Codex and open a new task.\n`);
}

export async function uninstall(projectRoot: string, deleteKey: boolean): Promise<void> {
  await uninstallSupervisor();
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const configFile = path.join(codexHome, "config.toml");
  const agentFile = path.join(codexHome, "agents", "cursor.toml");
  const config = await readOptionalPlainFile(configFile);
  if (config !== undefined) {
    await writeOwnerOnlyAtomic(configFile, removeManagedRegistrationBlocks(config));
  }
  try {
    const agent = await readFile(agentFile, "utf8");
    if (agent.startsWith(agentMarker)) await rm(agentFile);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await uninstallPlugin();
  if (deleteKey) await deleteCursorApiKey();
  process.stdout.write(`Uninstalled Cursor Bridge registration for ${projectRoot}. Local job history was preserved.\n`);
}
