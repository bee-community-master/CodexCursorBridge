import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const repositorySchema = z.object({
  root: z.string().min(1),
  origin: z.string().regex(/^[^/]+\/[^/]+$/),
  defaultBranch: z.string().min(1),
});

const machineConfigSchema = z.object({
  cursorModelId: z.string().min(1),
  repositories: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), repositorySchema),
});

export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type MachineConfig = z.infer<typeof machineConfigSchema>;

export interface RuntimePaths {
  projectRoot: string;
  home: string;
  configFile: string;
  databaseFile: string;
  logsDir: string;
  reportsDir: string;
  worktreesDir: string;
  tasksDir: string;
}

export function runtimePaths(projectRoot = process.env.CURSOR_BRIDGE_ROOT ?? process.cwd()): RuntimePaths {
  const home = process.env.CURSOR_BRIDGE_HOME ?? path.join(os.homedir(), ".config", "codex-cursor-bridge");
  return {
    projectRoot: path.resolve(projectRoot), home,
    configFile: path.join(home, "config.json"), databaseFile: path.join(home, "jobs.sqlite"),
    logsDir: path.join(home, "logs"), reportsDir: path.join(home, "reports"),
    worktreesDir: path.join(os.homedir(), ".codex", "worktrees", "cursor-bridge"),
    tasksDir: path.join(path.resolve(projectRoot), "tasks"),
  };
}

export async function loadMachineConfig(file: string): Promise<MachineConfig> {
  return machineConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function saveMachineConfig(file: string, config: MachineConfig): Promise<void> {
  const parsed = machineConfigSchema.parse(config);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

export function addRepository(config: MachineConfig, alias: string, repository: RepositoryConfig): MachineConfig {
  const normalizedAlias = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).parse(alias);
  const normalizedRepository = repositorySchema.parse(repository);
  if (config.repositories[normalizedAlias]) throw new Error(`Repository alias already exists: ${normalizedAlias}`);
  return machineConfigSchema.parse({
    ...config,
    repositories: { ...config.repositories, [normalizedAlias]: normalizedRepository },
  });
}

export function emptyMachineConfig(cursorModelId: string): MachineConfig {
  return machineConfigSchema.parse({ cursorModelId, repositories: {} });
}
