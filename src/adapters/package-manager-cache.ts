import { createHash } from "node:crypto";
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
  binary: "pnpm" | "pnpx";
  version: string;
  digest: string;
  integrity?: string;
  artifactDigest: string;
  corepackHome: string;
  executable: string;
  entrypoint: string;
  source: "verifier-owned-corepack-cache";
  network: "denied";
}

interface CorepackMetadata {
  locator?: { name?: string; reference?: string };
  bin?: Record<string, unknown>;
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
  const referenceParts = match?.[2]?.split("+") ?? [];
  const version = referenceParts.length > 0
    ? parseExactVersion(referenceParts[0] ?? "")
    : undefined;
  const integrity = referenceParts.length === 2 ? referenceParts[1] : undefined;
  if (
    !match
    || referenceParts.length > 2
    || !version
    || (integrity !== undefined && !/^sha512\.[a-f0-9]+$/i.test(integrity))
  ) {
    throw new Error("Independent verifier supports only an exact pnpm packageManager declaration");
  }
  return {
    name: "pnpm",
    version,
    reference: declaration,
    ...(integrity ? { integrity } : {}),
  };
}

export function hostCorepackHome(): string {
  const cacheRoot = process.env.XDG_CACHE_HOME
    ?? path.join(os.homedir(), ".cache");
  return process.env.COREPACK_HOME
    ?? path.join(cacheRoot, "node", "corepack");
}

export function packageManagerDirectory(corepackHome: string, spec: PackageManagerSpec): string {
  return path.join(corepackHome, "v1", spec.name, spec.version);
}

export interface ValidatedPackageManager {
  digest: string;
  executable: string;
  entrypoint: string;
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
  const source = packageManagerDirectory(sourceHome, spec);
  if (!await isDirectory(source)) return false;
  await assertPackageManagerArtifactTree(source);
  const target = packageManagerDirectory(targetHome, spec);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await cp(source, target, { recursive: true, force: false });
  return true;
}

export async function assertPackageManagerArtifactTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Independent verifier package cache may not contain symbolic links");
    }
    if (entry.isDirectory()) await assertPackageManagerArtifactTree(child);
    else if (!entry.isFile()) {
      throw new Error("Independent verifier package cache contains an unsupported entry");
    }
  }
}

export async function inspectPackageManagerCache(
  corepackHome: string,
  spec: PackageManagerSpec,
  binary: "pnpm" | "pnpx",
): Promise<ValidatedPackageManager> {
  const directory = packageManagerDirectory(corepackHome, spec);
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
    const rawEntrypoint = metadata.bin?.[binary];
    if (typeof rawEntrypoint !== "string") {
      throw packageManagerError(spec.version, `the staged package has no ${binary} entrypoint`);
    }
    const executable = path.resolve(directory, rawEntrypoint);
    const relativeEntrypoint = path.relative(directory, executable);
    if (
      !relativeEntrypoint
      || relativeEntrypoint === ".."
      || relativeEntrypoint.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeEntrypoint)
    ) {
      throw packageManagerError(spec.version, "the staged package entrypoint escapes its artifact");
    }
    const entrypointMetadata = await lstat(executable);
    if (!entrypointMetadata.isFile() || entrypointMetadata.isSymbolicLink()) {
      throw packageManagerError(spec.version, "the staged package entrypoint is not a plain file");
    }
    return {
      digest: metadata.hash,
      executable,
      entrypoint: relativeEntrypoint.split(path.sep).join("/"),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Independent verifier")) throw error;
    throw packageManagerError(spec.version, "the staged package failed integrity checks");
  }
}

async function artifactDigest(root: string, relative = ""): Promise<string> {
  const hash = createHash("sha256");
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    if (entry.isSymbolicLink()) {
      throw new Error("Independent verifier package cache may not contain symbolic links");
    }
    if (entry.isDirectory()) {
      hash.update(`directory\0${childRelative}\0`);
      hash.update(await artifactDigest(child, ""));
    } else if (entry.isFile()) {
      hash.update(`file\0${childRelative}\0`);
      hash.update(await readFile(child));
      hash.update("\0");
    } else {
      throw new Error("Independent verifier package cache contains an unsupported entry");
    }
  }
  return hash.digest("hex");
}

export async function computePackageManagerArtifactDigest(root: string): Promise<string> {
  return artifactDigest(root);
}

async function makeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Independent verifier package cache may not contain symbolic links");
    }
    if (entry.isDirectory()) {
      await makeReadOnly(child);
    } else {
      const metadata = await lstat(child);
      await chmod(child, 0o444 | (metadata.mode & 0o111));
    }
  }
  await chmod(root, 0o555);
}

async function addEntrypointShim(
  executable: string,
  binary: "pnpm" | "pnpx",
  version: string,
): Promise<string> {
  const shim = path.join(path.dirname(executable), binary);
  try {
    await lstat(shim);
    throw packageManagerError(
      version,
      `the staged package already contains an unexpected ${binary} shim`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Independent verifier")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await cp(executable, shim, { force: false, errorOnExist: true });
  await chmod(shim, 0o555);
  return shim;
}

async function assertEntrypointShim(
  executable: string,
  binary: "pnpm" | "pnpx",
  version: string,
): Promise<void> {
  const shim = path.join(path.dirname(executable), binary);
  try {
    const metadata = await lstat(shim);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not a plain file");
    const [source, copy] = await Promise.all([readFile(executable), readFile(shim)]);
    if (!source.equals(copy)) throw new Error("content differs");
  } catch {
    throw packageManagerError(version, `the staged package ${binary} shim changed after preparation`);
  }
}

export async function stagePackageManager(
  worktree: string,
  scratchDir: string,
  provenanceFile: string,
  binary: "pnpm" | "pnpx" = "pnpm",
): Promise<StagedPackageManager> {
  const spec = await readPackageManager(worktree);
  const corepackHome = path.join(scratchDir, "corepack");
  await mkdir(corepackHome, { recursive: true, mode: 0o700 });

  const copied = await copyReadOnlyCache(hostCorepackHome(), corepackHome, spec);
  if (!copied) {
    throw packageManagerError(
      spec.version,
      "pre-provision the exact package in the host Corepack cache before dispatch",
    );
  }
  const validated = await inspectPackageManagerCache(corepackHome, spec, binary);
  const sourceDigest = `sha256:${await artifactDigest(packageManagerDirectory(corepackHome, spec))}`;
  const { loadPackageManagerProvenance } = await import("./package-manager-provenance.js");
  const trusted = await loadPackageManagerProvenance(provenanceFile, spec, binary);
  if (trusted.treeDigest !== sourceDigest || trusted.entrypoint !== validated.entrypoint) {
    throw packageManagerError(
      spec.version,
      "the staged package does not match the explicitly provisioned artifact digest",
    );
  }
  await addEntrypointShim(validated.executable, binary, spec.version);
  const digest = await artifactDigest(packageManagerDirectory(corepackHome, spec));
  await makeReadOnly(corepackHome);
  return {
    name: spec.name,
    binary,
    version: spec.version,
    digest: validated.digest,
    ...(spec.integrity ? { integrity: spec.integrity } : {}),
    artifactDigest: `sha256:${digest}`,
    corepackHome,
    executable: validated.executable,
    entrypoint: validated.entrypoint,
    source: "verifier-owned-corepack-cache",
    network: "denied",
  };
}

export async function assertStagedPackageManager(
  staged: StagedPackageManager,
): Promise<void> {
  const spec: PackageManagerSpec = {
    name: staged.name,
    version: staged.version,
    reference: `${staged.name}@${staged.version}`,
    ...(staged.integrity ? { integrity: staged.integrity } : {}),
  };
  const validated = await inspectPackageManagerCache(staged.corepackHome, spec, staged.binary);
  await assertEntrypointShim(validated.executable, staged.binary, staged.version);
  const actualArtifactDigest = `sha256:${await artifactDigest(
    packageManagerDirectory(staged.corepackHome, spec),
  )}`;
  if (
    validated.digest !== staged.digest
    || validated.entrypoint !== staged.entrypoint
    || validated.executable !== staged.executable
    || actualArtifactDigest !== staged.artifactDigest
  ) {
    throw packageManagerError(staged.version, "the staged package digest changed after preparation");
  }
}
