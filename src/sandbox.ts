import { realpathSync } from "node:fs";
import path from "node:path";

export interface VerificationSandboxInput {
  worktree: string;
  scratchDir: string;
  command: string;
  args: readonly string[];
  taskEnv?: Readonly<Record<string, string>>;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface VerificationInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function sandboxLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function canonicalRoot(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pathVariants(value: string): string[] {
  const resolved = path.resolve(value);
  return [...new Set([resolved, canonicalRoot(resolved)])];
}

function ancestorLiterals(roots: readonly string[]): string[] {
  const ancestors = new Set<string>();
  for (const root of roots) {
    let current = path.dirname(root);
    for (;;) {
      ancestors.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...ancestors];
}

function readableRoots(worktree: string, scratchDir: string): string[] {
  const roots = [
    worktree,
    scratchDir,
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/Library",
    "/Applications",
    "/opt",
    "/dev",
  ];
  return [...new Set(roots.flatMap(pathVariants))];
}

function profile(worktree: string, scratchDir: string): string {
  const writableRoots = [...new Set([
    ...pathVariants(worktree),
    ...pathVariants(scratchDir),
  ])];
  const reads = [
    ...readableRoots(worktree, scratchDir)
      .map((root) => `(subpath ${sandboxLiteral(root)})`),
    ...ancestorLiterals(writableRoots)
      .map((root) => `(literal ${sandboxLiteral(root)})`),
  ].join(" ");
  const writes = writableRoots
    .map((root) => `(subpath ${sandboxLiteral(root)})`)
    .join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.system"))',
    `(allow file-read* ${reads})`,
    `(allow file-write* ${writes} (literal "/dev/null"))`,
    "(deny network*)",
  ].join("\n");
}

export function createVerificationSandbox(input: VerificationSandboxInput): VerificationInvocation {
  const baseEnv = input.baseEnv ?? process.env;
  const worktree = path.resolve(input.worktree);
  const scratchDir = path.resolve(input.scratchDir);
  const pathValue = baseEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const env: NodeJS.ProcessEnv = {
    ...input.taskEnv,
    PATH: pathValue,
    HOME: path.join(scratchDir, "home"),
    TMPDIR: path.join(scratchDir, "tmp"),
    CI: "true",
    LANG: baseEnv.LANG ?? "en_US.UTF-8",
    LC_ALL: baseEnv.LC_ALL ?? baseEnv.LANG ?? "en_US.UTF-8",
  };

  if (process.platform !== "darwin") throw new Error("Verification sandbox requires macOS");
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", profile(worktree, scratchDir), input.command, ...input.args],
    env,
  };
}
