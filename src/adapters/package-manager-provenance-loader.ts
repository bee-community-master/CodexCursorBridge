import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

interface PackageManagerSpecForProvenance {
  name: "pnpm";
  version: string;
}

export interface PackageManagerProvenanceRecord {
  name: "pnpm";
  version: string;
  binary: "pnpm" | "pnpx";
  treeDigest: string;
  entrypoint: string;
}

export interface PackageManagerProvenanceFile {
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
  spec: PackageManagerSpecForProvenance,
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

export async function readPackageManagerProvenanceManifest(
  file: string,
): Promise<PackageManagerProvenanceFile> {
  return readManifest(file);
}

export function packageManagerProvenanceKey(
  name: string,
  version: string,
  binary: string,
): string {
  return provenanceKey(name, version, binary);
}
