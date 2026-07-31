import { chmod, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeOwnerOnlyAtomic } from "./adapters/owner-only-atomic-file.js";
import type {
  CursorModelParameter,
  MachineConfig,
  RepositoryConfig,
  RuntimePaths,
} from "./domain/configuration.js";

export type {
  MachineConfig,
  RepositoryConfig,
  RuntimePaths,
} from "./domain/configuration.js";

function hasNoControlCharacters(value: string): boolean {
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

const repositorySchema = z.object({
  root: z.string().min(1)
    .refine((value) => path.isAbsolute(value), "repository root must be absolute")
    .refine(hasNoControlCharacters, "repository root contains control characters"),
  origin: z.string().regex(/^[^\s/]+\/[^\s/]+$/)
    .refine(hasNoControlCharacters, "repository origin contains control characters"),
  defaultBranch: z.string().min(1).regex(/^[^\s]+$/)
    .refine(hasNoControlCharacters, "default branch contains control characters"),
});

const cursorModelParameterSchema = z.object({
  id: z.string().min(1)
    .refine(hasNoControlCharacters, "Cursor model parameter id contains control characters"),
  value: z.string().min(1)
    .refine(hasNoControlCharacters, "Cursor model parameter value contains control characters"),
});

const cursorModelParamsSchema = z.array(cursorModelParameterSchema).max(16)
  .superRefine((parameters, context) => {
    const ids = new Set<string>();
    parameters.forEach((parameter, index) => {
      if (ids.has(parameter.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Duplicate Cursor model parameter id: ${parameter.id}`,
        });
      }
      ids.add(parameter.id);
    });
  });

const machineConfigSchema = z.object({
  cursorModelId: z.string().min(1)
    .refine(hasNoControlCharacters, "Cursor model id contains control characters"),
  cursorModelParams: cursorModelParamsSchema.optional(),
  repositories: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), repositorySchema),
});

export function runtimePaths(projectRoot = process.env.CURSOR_BRIDGE_ROOT ?? process.cwd()): RuntimePaths {
  const home = path.resolve(
    process.env.CURSOR_BRIDGE_HOME
      ?? path.join(os.homedir(), ".config", "codex-cursor-bridge"),
  );
  const root = path.resolve(projectRoot);
  if (!hasNoControlCharacters(root) || !hasNoControlCharacters(home)) {
    throw new Error("Cursor Bridge runtime roots may not contain control characters");
  }
  return {
    projectRoot: root, home,
    configFile: path.join(home, "config.json"), databaseFile: path.join(home, "jobs.sqlite"),
    logsDir: path.join(home, "logs"), reportsDir: path.join(home, "reports"),
    worktreesDir: path.join(home, "worktrees"),
    tasksDir: path.join(root, "tasks"),
  };
}

export async function loadMachineConfig(file: string): Promise<MachineConfig> {
  return machineConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function saveMachineConfig(file: string, config: MachineConfig): Promise<void> {
  const parsed = machineConfigSchema.parse(config);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeOwnerOnlyAtomic(file, `${JSON.stringify(parsed, null, 2)}\n`);
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

export function emptyMachineConfig(
  cursorModelId: string,
  cursorModelParams?: CursorModelParameter[],
): MachineConfig {
  return machineConfigSchema.parse({
    cursorModelId,
    ...(cursorModelParams ? { cursorModelParams } : {}),
    repositories: {},
  });
}
