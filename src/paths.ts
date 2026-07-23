import path from "node:path";
import { minimatch } from "minimatch";

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function assertRelativeRepoPath(value: string): string {
  if (
    value.length === 0
    || value.includes("\\")
    || containsControlCharacter(value)
    || path.posix.isAbsolute(value)
    || value.split("/").includes("..")
  ) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  const normalized = value.replace(/^\.\//, "");
  if (normalized.length === 0 || normalized === ".") {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  return normalized;
}

function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    minimatch(file, assertRelativeRepoPath(pattern), {
      dot: true,
      nocomment: true,
      nonegate: true,
    }),
  );
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
