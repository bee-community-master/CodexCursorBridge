export interface RepositoryConfig {
  root: string;
  origin: string;
  defaultBranch: string;
}

export interface CursorModelParameter {
  id: string;
  value: string;
}

export interface MachineConfig {
  cursorModelId: string;
  cursorModelParams?: CursorModelParameter[];
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
