export interface RepositoryConfig {
  root: string;
  origin: string;
  defaultBranch: string;
}

export interface MachineConfig {
  cursorModelId: string;
  repositories: Record<string, RepositoryConfig>;
}

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
