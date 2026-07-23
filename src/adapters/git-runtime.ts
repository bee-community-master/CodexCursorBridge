import { runFile } from "./command-runner.js";

const unsafeInheritedGitEnvironment = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_ATTR_SOURCE",
  "GIT_REPLACE_REF_BASE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
]);

export function gitEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      unsafeInheritedGitEnvironment.has(key)
      || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
      || /^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)$/.test(key)
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    ...overrides,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function gitOutput(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<string> {
  return (await runFile("git", [
    "-C",
    cwd,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    ...args,
  ], {
    env: gitEnvironment(environment),
  })).stdout;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitOutput(cwd, args)).trim();
}
