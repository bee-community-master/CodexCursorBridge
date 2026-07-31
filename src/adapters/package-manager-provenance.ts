import { lstat, mkdir, readFile, chmod } from "node:fs/promises";
import path from "node:path";
import type {
  PackageManagerSpec,
  ValidatedPackageManager,
} from "./package-manager-cache.js";
import {
  computePackageManagerArtifactDigest,
  hostCorepackHome,
  inspectPackageManagerCache,
  packageManagerDirectory,
  assertPackageManagerArtifactTree,
} from "./package-manager-cache.js";
import { writeOwnerOnlyAtomic } from "./owner-only-atomic-file.js";

export interface PackageManagerProvenanceRecord {
  name: "pnpm";
  version: string;
  binary: "pnpm" | "pnpx";
  treeDigest: string;
  entrypoint: string;
}

interface PackageManagerProvenanceFile {
  schemaVersion: 1;
  generatedAt: string;
  packages: Record<string, PackageManagerProvenanceRecord>;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;

function provenanceKey(name: string, version: string, binary: string): string {
  return `${name}@${version}:${binary}`;
}

function provenanceError(detail: string): Error {
  return new Error(`Independent verifier package-manager provisioning is invalid: ${detail}`);
}

function parseRecord(value: unknown, key: string): PackageManagerProvenanceRecord {
  if (value === null || typeof value !== "object") throw provenanceError(`missing ${key}`);
  const candidate = value as Record<string, unknown>;
  if (
    candidate.name !== "pnpm"
    || typeof candidate.version !== "string"
    || !/^\d+\.\d+\.\d+$/.test(candidate.version)
    || (candidate.binary !== "pnpm" && candidate.binary !== "pnpx")
    || typeof candidate.treeDigest !== "string"
    || !digestPattern.test(candidate.treeDigest)
    || typeof candidate.entrypoint !== "string"
    || !candidate.entrypoint
    || path.isAbsolute(candidate.entrypoint)
    || candidate.entrypoint.startsWith("../")
    || candidate.entrypoint.includes("/../")
  ) {
    throw provenanceError(`invalid ${key}`);
  }
  return {
    name: "pnpm",
    version: candidate.version,
    binary: candidate.binary,
    treeDigest: candidate.treeDigest,
    entrypoint: candidate.entrypoint,
  };
}

function parseManifest(value: unknown): PackageManagerProvenanceFile {
  if (value === null || typeof value !== "object") throw provenanceError("manifest must be an object");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.generatedAt !== "string"
    || candidate.packages === null
    || typeof candidate.packages !== "object"
  ) {
    throw provenanceError("manifest envelope is invalid");
  }
  const packages: Record<string, PackageManagerProvenanceRecord> = {};
  for (const [key, record] of Object.entries(candidate.packages as Record<string, unknown>)) {
    packages[key] = parseRecord(record, key);
  }
  return {
    schemaVersion: 1,
    generatedAt: candidate.generatedAt,
    packages,
  };
}

async function readManifest(file: string): Promise<PackageManagerProvenanceFile> {
  let metadata;
  try {
    const fileMetadata = await lstat(file);
    if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
      throw provenanceError("manifest must be a plain file");
    }
    if ((fileMetadata.mode & 0o077) !== 0) {
      throw provenanceError("manifest must be owner-only");
    }
    metadata = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Independent verifier")) throw error;
    throw provenanceError(`manifest is unavailable at ${file}`);
  }
  return parseManifest(metadata);
}

export async function loadPackageManagerProvenance(
  file: string,
  spec: PackageManagerSpec,
  binary: "pnpm" | "pnpx",
): Promise<PackageManagerProvenanceRecord> {
  const manifest = await readManifest(file);
  const key = provenanceKey(spec.name, spec.version, binary);
  const record = manifest.packages[key];
  if (!record) {
    throw provenanceError(
      `no trusted ${key} record; run the explicit package-manager provisioning command first`,
    );
  }
  if (record.name !== spec.name || record.version !== spec.version || record.binary !== binary) {
    throw provenanceError(`trusted record ${key} does not match the declared package manager`);
  }
  return record;
}

export async function provisionPackageManagerManifest(
  file: string,
  version: string,
  binary: "pnpm" | "pnpx" = "pnpm",
): Promise<PackageManagerProvenanceRecord> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw provenanceError(`package-manager version is not exact: ${version}`);
  }
  const spec: PackageManagerSpec = {
    name: "pnpm",
    version,
    reference: `pnpm@${version}`,
  };
  const sourceHome = hostCorepackHome();
  const sourceDirectory = packageManagerDirectory(sourceHome, spec);
  let validated: ValidatedPackageManager;
  try {
    await assertPackageManagerArtifactTree(sourceDirectory);
    validated = await inspectPackageManagerCache(sourceHome, spec, binary);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Independent verifier")) throw error;
    throw provenanceError(`host Corepack artifact is unavailable or invalid at ${sourceDirectory}`);
  }
  const treeDigest = `sha256:${await computePackageManagerArtifactDigest(sourceDirectory)}`;
  const record: PackageManagerProvenanceRecord = {
    name: "pnpm",
    version,
    binary,
    treeDigest,
    entrypoint: validated.entrypoint,
  };
  let packages: Record<string, PackageManagerProvenanceRecord> = {};
  try {
    packages = (await readManifest(file)).packages;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("unavailable")) throw error;
  }
  packages[provenanceKey(spec.name, version, binary)] = record;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeOwnerOnlyAtomic(file, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packages,
  }, null, 2)}\n`);
  return record;
}
