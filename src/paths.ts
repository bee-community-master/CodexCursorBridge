import path from "node:path";
import { minimatch } from "minimatch";

export function assertRelativeRepoPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  return normalized.replace(/^\.\//, "");
}

function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(file, assertRelativeRepoPath(pattern), { dot: true }));
}

export interface ChangedPathEvaluation {
  allowed: string[];
  forbidden: string[];
  outOfScope: string[];
}

export function evaluateChangedPaths(
  files: readonly string[],
  allowedPatterns: readonly string[],
  forbiddenPatterns: readonly string[],
): ChangedPathEvaluation {
  const result: ChangedPathEvaluation = { allowed: [], forbidden: [], outOfScope: [] };
  for (const input of files) {
    const file = assertRelativeRepoPath(input);
    if (matchesAny(file, forbiddenPatterns)) result.forbidden.push(file);
    else if (matchesAny(file, allowedPatterns)) result.allowed.push(file);
    else result.outOfScope.push(file);
  }
  return result;
}

export function resolveInside(root: string, relative: string): string {
  const safe = assertRelativeRepoPath(relative);
  const resolved = path.resolve(root, safe);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`Path escapes repository: ${relative}`);
  return resolved;
}
