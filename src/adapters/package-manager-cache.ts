import { cp, chmod, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PackageManagerSpec {
  name: "pnpm";
  version: string;
  reference: string;
  integrity?: string;
}

export interface StagedPackageManager {
  name: PackageManagerSpec["name"];
  version: string;
  digest: string;
  corepackHome: string;
  source: "verifier-owned-corepack-cache";
  network: "denied";
}

interface CorepackMetadata {
  locator?: { name?: string; reference?: string };
  hash?: string;
}

interface PackageManifest {
  name?: string;
  version?: string;
}

function packageManagerError(version: string, detail?: string): Error {
  return new Error(
    `Independent verifier could not stage pnpm@${version} in its private Corepack cache${detail ? `: ${detail}` : ""}`,
  );
}

function parseExactVersion(reference: string): string | undefined {
  const version = reference.split("+", 1)[0];
  if (!version) return undefined;
  return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
}

export async function readPackageManager(worktree: string): Promise<PackageManagerSpec> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(worktree, "package.json"), "utf8"));
  } catch {
    throw new Error("Independent verifier requires an exact packageManager declaration");
  }
  const declaration = (manifest as { packageManager?: unknown })?.packageManager;
  if (typeof declaration !== "string") {
    throw new Error("Independent verifier requires an exact packageManager declaration");
  }
  const match = /^(pnpm)@([^\s]+)$/.exec(declaration);
  const version = match?.[2] ? parseExactVersion(match[2]) : undefined;
  const integrity = match?.[2]?.split("+", 2)[1];
  if (!match || !version || (integrity && !/^sha512\.[a-f0-9]+$/i.test(integrity))) {
    throw new Error("Independent verifier supports only an exact pnpm packageManager declaration");
  }
  return {
    name: "pnpm",
    version,
    reference: declaration,
    ...(integrity ? { integrity } : {}),
  };
}

function defaultCorepackHome(): string {
  const cacheRoot = process.env.XDG_CACHE_HOME
    ?? path.join(os.homedir(), ".cache");
  return process.env.COREPACK_HOME
    ?? path.join(cacheRoot, "node", "corepack");
}

function packageDirectory(corepackHome: string, spec: PackageManagerSpec): string {
  return path.join(corepackHome, "v1", spec.name, spec.version);
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const metadata = await lstat(candidate);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function copyReadOnlyCache(
  sourceHome: string,
  targetHome: string,
  spec: PackageManagerSpec,
): Promise<boolean> {
  const source = packageDirectory(sourceHome, spec);
  if (!await isDirectory(source)) return false;
  await mkdir(path.dirname(targetHome), { recursive: true, mode: 0o700 });
  await cp(sourceHome, targetHome, { recursive: true, force: false });
  return true;
}

async function assertPackageManagerCache(
  corepackHome: string,
  spec: PackageManagerSpec,
): Promise<string> {
  const directory = packageDirectory(corepackHome, spec);
  try {
    const metadata = JSON.parse(
      await readFile(path.join(directory, ".corepack"), "utf8"),
    ) as CorepackMetadata;
    const manifest = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    ) as PackageManifest;
    if (
      metadata.locator?.name !== spec.name
      || metadata.locator.reference !== spec.version
      || manifest.name !== spec.name
      || manifest.version !== spec.version
      || !metadata.hash
      || !/^sha512\.[a-f0-9]+$/i.test(metadata.hash)
      || (spec.integrity !== undefined && metadata.hash !== spec.integrity)
    ) {
      throw packageManagerError(spec.version, "the staged package failed integrity checks");
    }
    return metadata.hash;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Independent verifier")) throw error;
    throw packageManagerError(spec.version, "the staged package failed integrity checks");
  }
}

async function makeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Independent verifier package cache may not contain symbolic links");
    }
    if (entry.isDirectory()) await makeReadOnly(child);
    else await chmod(child, 0o444);
  }
  await chmod(root, 0o555);
}

export async function stagePackageManager(
  worktree: string,
  scratchDir: string,
): Promise<StagedPackageManager> {
  const spec = await readPackageManager(worktree);
  const corepackHome = path.join(scratchDir, "corepack");
  await mkdir(corepackHome, { recursive: true, mode: 0o700 });

  const copied = await copyReadOnlyCache(defaultCorepackHome(), corepackHome, spec);
  if (!copied) {
    throw packageManagerError(
      spec.version,
      "pre-provision the exact package in the host Corepack cache before dispatch",
    );
  }
  const digest = await assertPackageManagerCache(corepackHome, spec);
  await makeReadOnly(corepackHome);
  return {
    name: spec.name,
    version: spec.version,
    digest,
    corepackHome,
    source: "verifier-owned-corepack-cache",
    network: "denied",
  };
}
