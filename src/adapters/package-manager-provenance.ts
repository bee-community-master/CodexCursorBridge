import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  PackageManagerSpec,
  ValidatedPackageManager,
} from "./package-manager-cache.js";
import {
  assertPackageManagerArtifactTree,
  computePackageManagerArtifactDigest,
  hostCorepackHome,
  inspectPackageManagerCache,
  packageManagerDirectory,
} from "./package-manager-cache.js";
import { writeOwnerOnlyAtomic } from "./owner-only-atomic-file.js";
import {
  packageManagerProvenanceKey,
  PACKAGE_MANAGER_DIGEST_VERSION,
  readPackageManagerProvenanceManifest,
  type PackageManagerProvenanceRecord,
} from "./package-manager-provenance-loader.js";

export { loadPackageManagerProvenance } from "./package-manager-provenance-loader.js";
export type { PackageManagerProvenanceRecord } from "./package-manager-provenance-loader.js";

function provenanceError(detail: string): Error {
  return new Error(`Independent verifier package-manager provisioning is invalid: ${detail}`);
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
    packages = (await readPackageManagerProvenanceManifest(file)).packages;
  } catch (error) {
    if (
      !(error instanceof Error)
      || (!error.message.includes("unavailable") && !error.message.includes("manifest envelope is invalid"))
    ) throw error;
  }
  packages[packageManagerProvenanceKey(spec.name, version, binary)] = record;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeOwnerOnlyAtomic(file, `${JSON.stringify({
    schemaVersion: 1,
    digestVersion: PACKAGE_MANAGER_DIGEST_VERSION,
    generatedAt: new Date().toISOString(),
    packages,
  }, null, 2)}\n`);
  return record;
}
