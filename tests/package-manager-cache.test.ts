import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFile } from "../src/adapters/command-runner.js";
import {
  assertPackageManagerControlArgs,
  assertPackageManagerEnvironment,
} from "../src/adapters/independent-verifier.js";
import {
  assertStagedPackageManager,
  computePackageManagerArtifactDigest,
  hostCorepackHome,
  packageManagerDirectory,
  readPackageManager,
  stagePackageManager,
} from "../src/adapters/package-manager-cache.js";
import { provisionPackageManagerManifest } from "../src/adapters/package-manager-provenance.js";
import { PACKAGE_MANAGER_DIGEST_VERSION } from "../src/adapters/package-manager-provenance-loader.js";
import { packageManagerOptionCatalog } from "../src/adapters/package-manager-option-catalog.js";
import { createVerificationSandbox } from "../src/sandbox.js";

const fakePackageManagerSpec = {
  name: "pnpm" as const,
  version: "11.10.0",
  reference: "pnpm@11.10.0",
};

async function fakePackageManagerFixture(prefix: string): Promise<{
  sourceHome: string;
  sourceDirectory: string;
  manifest: string;
}> {
  const sourceHome = await mkdtemp(path.join(tmpdir(), `${prefix}-host-`));
  const sourceDirectory = packageManagerDirectory(sourceHome, fakePackageManagerSpec);
  await mkdir(path.join(sourceDirectory, "bin"), { recursive: true, mode: 0o755 });
  await writeFile(
    path.join(sourceDirectory, ".corepack"),
    JSON.stringify({
      locator: { name: "pnpm", reference: fakePackageManagerSpec.version },
      bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" },
      hash: `sha512.${"a".repeat(128)}`,
    }),
    "utf8",
  );
  await writeFile(
    path.join(sourceDirectory, "package.json"),
    JSON.stringify({ name: "pnpm", version: fakePackageManagerSpec.version }),
    "utf8",
  );
  await writeFile(path.join(sourceDirectory, "bin", "pnpm.mjs"), "fake pnpm\n", { mode: 0o755 });
  await writeFile(path.join(sourceDirectory, "bin", "pnpx.mjs"), "fake pnpx\n", { mode: 0o755 });
  const manifestRoot = await mkdtemp(path.join(tmpdir(), `${prefix}-manifest-`));
  const manifest = path.join(manifestRoot, "manifest.json");
  const treeDigest = `sha256:${await computePackageManagerArtifactDigest(sourceDirectory)}`;
  await writeFile(manifest, `${JSON.stringify({
    schemaVersion: 1,
    digestVersion: PACKAGE_MANAGER_DIGEST_VERSION,
    generatedAt: "2026-07-31T00:00:00.000Z",
    packages: {
      "pnpm@11.10.0:pnpm": {
        name: "pnpm",
        version: fakePackageManagerSpec.version,
        binary: "pnpm",
        treeDigest,
        entrypoint: "bin/pnpm.mjs",
      },
    },
  }, null, 2)}\n`, "utf8");
  await chmod(manifest, 0o600);
  return { sourceHome, sourceDirectory, manifest };
}

async function withCorepackHome<T>(sourceHome: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.COREPACK_HOME;
  process.env.COREPACK_HOME = sourceHome;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.COREPACK_HOME;
    else process.env.COREPACK_HOME = previous;
  }
}

type ExtractedCommandOptionKind = "boolean" | "optional" | "required";
type ExtractedCommandMetadata = {
  required: string[];
  optional: string[];
  boolean: string[];
  shorthands: Record<string, string | string[]>;
};

function extractBalancedObject(source: string, marker: string): string {
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) throw new Error(`Authoritative pnpm metadata marker missing: ${marker}`);
  const open = source.indexOf("{", markerStart);
  if (open < 0) throw new Error(`Authoritative pnpm metadata object missing: ${marker}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`Authoritative pnpm metadata object is unterminated: ${marker}`);
}

function extractPickedOptionNames(block: string): string[] {
  const names: string[] = [];
  for (const match of block.matchAll(/pick_default\(\s*\[([\s\S]*?)\]\s*,\s*types2\s*\)/g)) {
    for (const name of match[1]?.matchAll(/["']([^"']+)["']/g) ?? []) {
      if (name[1]) names.push(name[1]);
    }
  }
  return names;
}

function extractDirectOptionTypes(block: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^\s*(?:"([^"]+)"|([A-Za-z][\w-]*))\s*:\s*(.+?)(?:,\s*)?$/.exec(line);
    const name = match?.[1] ?? match?.[2];
    if (name && match?.[3]) entries.set(name, match[3].trim());
  }
  return entries;
}

function classifyExtractedOptionType(type: string): ExtractedCommandOptionKind {
  const normalized = type.trim();
  if (normalized === "Boolean") return "boolean";
  if (/\[.*(?:Boolean|\btrue\b|\bfalse\b).*\]/s.test(normalized)) return "optional";
  return "required";
}

function extractAuthoritativeTypes(source: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const marker of ["pnpmTypes = {", "npmConfigTypes = {"]) {
    for (const [name, type] of extractDirectOptionTypes(extractBalancedObject(source, marker))) {
      merged.set(name, type);
    }
  }
  return merged;
}

function extractCommandMetadata(
  source: string,
  functionNames: readonly string[],
  types: Map<string, string>,
  includeIfPresent: boolean,
): Omit<ExtractedCommandMetadata, "shorthands"> {
  const entries = new Map<string, ExtractedCommandOptionKind>();
  for (const functionName of functionNames) {
    const marker = source.includes(`function ${functionName}()`)
      ? `function ${functionName}()`
      : `${functionName} = () =>`;
    const block = extractBalancedObject(source, marker);
    for (const name of extractPickedOptionNames(block)) {
      const type = types.get(name);
      if (!type) throw new Error(`Authoritative pnpm option type missing: ${name}`);
      entries.set(name, classifyExtractedOptionType(type));
    }
    for (const [name, type] of extractDirectOptionTypes(block)) {
      entries.set(name, classifyExtractedOptionType(type));
    }
  }
  if (includeIfPresent) {
    const ifPresent = extractDirectOptionTypes(extractBalancedObject(source, "IF_PRESENT_OPTION = {"));
    for (const [name, type] of ifPresent) entries.set(name, classifyExtractedOptionType(type));
  }
  const base: Record<ExtractedCommandOptionKind, Set<string>> = {
    required: new Set(Object.keys(packageManagerOptionCatalog.requiredValueOptions)),
    optional: new Set(Object.keys(packageManagerOptionCatalog.optionalValueOptions)),
    boolean: new Set(packageManagerOptionCatalog.booleanOptions),
  };
  const result = { required: [], optional: [], boolean: [] } as Omit<ExtractedCommandMetadata, "shorthands">;
  for (const [name, kind] of entries) {
    const target = kind === "boolean" ? result.boolean : kind === "optional" ? result.optional : result.required;
    const baseOptions = base[kind === "boolean" ? "boolean" : kind === "optional" ? "optional" : "required"];
    if (!baseOptions.has(name)) target.push(name);
  }
  for (const values of Object.values(result)) values.sort();
  return result;
}

function extractShorthands(source: string, marker: string, references: Readonly<Record<string, string | string[]>> = {}): Record<string, string | string[]> {
  const block = extractBalancedObject(source, marker);
  const result: Record<string, string | string[]> = {};
  for (const match of block.matchAll(/(?:^|[,\n])\s*([A-Za-z][\w-]*)\s*:\s*(\[[\s\S]*?\]|"[^"]*"|'[^']*'|[A-Za-z][\w.]+)/g)) {
    const name = match[1];
    const value = match[2];
    if (!name || !value) continue;
    if (value.startsWith("[")) {
      result[name] = [...value.matchAll(/["']([^"']+)["']/g)].flatMap((item) => item[1] ? [item[1]] : []);
    } else if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      result[name] = value.slice(1, -1);
    } else if (references[value] !== undefined) {
      result[name] = references[value];
    } else {
      result[name] = value;
    }
  }
  return result;
}

async function legacyArtifactDigest(root: string, relative = ""): Promise<string> {
  const hash = createHash("sha256");
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    if (entry.isDirectory()) {
      hash.update(`directory\0${childRelative}\0`);
      hash.update(await legacyArtifactDigest(child));
    } else {
      hash.update(`file\0${childRelative}\0`);
      const content = await readFile(child);
      hash.update(content);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

describe("independent package-manager staging", () => {
  it("uses unambiguous framing for split and merged artifact entries", async () => {
    const split = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-digest-split-"));
    const merged = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-digest-merged-"));
    await writeFile(path.join(split, "a"), "left\0file\0c\0right", "utf8");
    await writeFile(path.join(merged, "a"), "left", "utf8");
    await writeFile(path.join(merged, "c"), "right", "utf8");

    expect(await legacyArtifactDigest(split)).toBe(await legacyArtifactDigest(merged));

    const [splitDigest, mergedDigest] = await Promise.all([
      computePackageManagerArtifactDigest(split),
      computePackageManagerArtifactDigest(merged),
    ]);
    expect(splitDigest).not.toBe(mergedDigest);
  });

  it.each([
    ["unset", undefined],
    ["defined-empty", ""],
  ] as const)("treats COREPACK_HOME=%s as the host default", async (_label, value) => {
    const previousCorepackHome = process.env.COREPACK_HOME;
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-default-cache-"));
    try {
      process.env.XDG_CACHE_HOME = cacheRoot;
      if (value === undefined) delete process.env.COREPACK_HOME;
      else process.env.COREPACK_HOME = value;
      expect(hostCorepackHome()).toBe(path.join(cacheRoot, "node", "corepack"));
    } finally {
      if (previousCorepackHome === undefined) delete process.env.COREPACK_HOME;
      else process.env.COREPACK_HOME = previousCorepackHome;
      if (previousXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  });

  it("matches exact authoritative exec/run command metadata", async () => {
    const source = await readFile(
      path.join(
        packageManagerDirectory(hostCorepackHome(), fakePackageManagerSpec),
        "dist",
        "pnpm.mjs",
      ),
      "utf8",
    );
    const types = extractAuthoritativeTypes(source);
    const runMetadata = extractCommandMetadata(
      source,
      ["rcOptionsTypes40", "cliOptionsTypes39"],
      types,
      true,
    );
    const execMetadata = extractCommandMetadata(
      source,
      ["rcOptionsTypes41", "cliOptionsTypes40"],
      types,
      false,
    );
    const runShorthands = extractShorthands(source, "shorthands13 = {");
    const execShorthands = extractShorthands(source, "shorthands14 = {", {
      "shorthands13.parallel": runShorthands.parallel ?? [],
    });

    expect(runMetadata).toEqual({
      required: ["resume-from"],
      optional: ["scripts-prepend-node-path"],
      boolean: ["if-present", "recursive", "report-summary", "reverse"],
    });
    expect(execMetadata).toEqual({
      required: ["resume-from"],
      optional: [],
      boolean: ["recursive", "report-summary", "reverse", "shell-mode"],
    });
    expect(runShorthands).toEqual({
      parallel: [
        "--workspace-concurrency=Infinity",
        "--no-sort",
        "--stream",
        "--recursive",
      ],
      sequential: ["--workspace-concurrency=1"],
    });
    expect(execShorthands).toEqual({
      parallel: runShorthands.parallel,
      c: "--shell-mode",
    });
    expect({
      required: Object.keys(packageManagerOptionCatalog.commandLevelOptions.run.requiredValueOptions).sort(),
      optional: Object.keys(packageManagerOptionCatalog.commandLevelOptions.run.optionalValueOptions).sort(),
      boolean: [...packageManagerOptionCatalog.commandLevelOptions.run.booleanOptions].sort(),
      shorthands: packageManagerOptionCatalog.commandLevelOptions.run.shorthands,
    }).toEqual({
      ...runMetadata,
      shorthands: runShorthands,
    });
    expect({
      required: Object.keys(packageManagerOptionCatalog.commandLevelOptions.exec.requiredValueOptions).sort(),
      optional: Object.keys(packageManagerOptionCatalog.commandLevelOptions.exec.optionalValueOptions).sort(),
      boolean: [...packageManagerOptionCatalog.commandLevelOptions.exec.booleanOptions].sort(),
      shorthands: packageManagerOptionCatalog.commandLevelOptions.exec.shorthands,
    }).toEqual({
      ...execMetadata,
      shorthands: execShorthands,
    });
  });

  it.each([
    ["self-update"],
    ["--self-update"],
    ["--exec"],
    ["--env"],
    ["--setup"],
    ["with", "11.12.0", "--version"],
    ["exec", "pnpm", "--version"],
    ["--dir", ".", "exec", "pnpm", "--version"],
    ["-C", ".", "exec", "pnpm", "--version"],
    ["-C=.", "exec", "pnpm", "--version"],
    ["-C.", "exec", "pnpm", "--version"],
    ["-F", "codex-cursor-bridge", "exec", "pnpm", "--version"],
    ["-F=codex-cursor-bridge", "exec", "pnpm", "--version"],
    ["-Fcodex-cursor-bridge", "exec", "pnpm", "--version"],
    ["-r", "-C", ".", "-F", "codex-cursor-bridge", "exec", "pnpm", "--version"],
    ["-rC", ".", "-Fcodex-cursor-bridge", "exec", "pnpm", "--version"],
    ["-C", "-F", "codex-cursor-bridge", "exec", "pnpm", "--version"],
    ["--dir", "--filter", "codex-cursor-bridge", "exec", "pnpm", "--version"],
    ["--aggregate-output", "exec", "pnpm", "--version"],
    ["--resolution-only", "exec", "pnpm", "--version"],
    ["--loglevel", "debug", "exec", "pnpm", "--version"],
    ["--resume-from", "pkg", "exec", "pnpm", "--version"],
    ["--changed-files-ignore-pattern", "*.md", "exec", "pnpm", "--version"],
    ["--filter-prod", "workspace", "exec", "pnpm", "--version"],
    ["--test-pattern", "*.test.ts", "exec", "pnpm", "--version"],
    ["--node-package-map-type", "-F", "exec", "node", "--version"],
    ["--changed-files-ignore-pattern", "-F", "exec", "node", "--version"],
    ["--loglevel", "-F", "exec", "node", "--version"],
    ["--test-pattern", "-F", "exec", "node", "--version"],
    ["--workspace-packages", "-F", "exec", "node", "--version"],
    ["--node-package-map-type", "loose", "exec", "node", "--version"],
    ["--node-package-map-type=loose", "exec", "node", "--version"],
    ["--pm-on-fail=ignore"],
    ["--filter", "workspace", "dlx", "pnpm", "--version"],
    ["--config.manage-package-manager-versions=true"],
    ["--config", "pm-on-fail=download"],
  ])("rejects package-manager control arguments: %s", (...args: string[]) => {
    expect(() => assertPackageManagerControlArgs(args)).toThrow(/package-manager|switch/i);
  });

  const requiredValueSentinels = [
    "-F",
    "-C",
    "-r",
    "-x",
    "-abc",
    "-1",
    "--exec",
    "--env",
    "--setup",
    "--color",
    "--filter",
    "--dir",
    "--loglevel",
    "--resume-from",
    "--node-package-map-type",
    "--changed-files-ignore-pattern",
    "--test-pattern",
    "--workspace-packages",
    "--pm-on-fail",
    "--config",
    "--no-color",
    "--aggregate-output",
    "--resolution-only",
    "--foo",
    "--bar",
  ] as const;
  const requiredValueSentinelMatrix = [
    "node-package-map-type",
    "changed-files-ignore-pattern",
    "loglevel",
    "test-pattern",
    "workspace-packages",
  ].flatMap((option) => requiredValueSentinels.flatMap((sentinel) =>
    (["exec", "env", "setup"] as const).map((command) => [option, sentinel, command] as const),
  ));

  it.each(requiredValueSentinelMatrix)(
    "keeps checking the command after a required option consumes an option-looking value: --%s %s %s",
    (option, sentinel, command) => {
      expect(() => assertPackageManagerControlArgs([`--${option}`, sentinel, command, "node"]))
        .toThrow(/package-manager|switch/i);
    },
  );

  it.each([
    ["run", "exec"],
    ["run", "env"],
    ["run", "setup"],
    ["-C", ".", "run", "exec"],
    ["-F", "codex-cursor-bridge", "run", "env"],
  ])("allows dangerous words as pnpm script names: %s", (...args: string[]) => {
    expect(() => assertPackageManagerControlArgs(args)).not.toThrow();
  });

  it.each(packageManagerOptionCatalog.valueOptions)(
    "treats pnpm required value option as an option value: --%s",
    (option) => {
      expect(() => assertPackageManagerControlArgs([`--${option}`, "value", "exec", "node"]))
        .toThrow(/package-manager|switch/i);
    },
  );

  const optionalValueOptions = packageManagerOptionCatalog.allOptionalValueOptions;
  const optionalValueCases = Object.entries(optionalValueOptions)
    .map(([option, spec]) => [option, spec.values[0] ?? "true"] as const);

  it.each(optionalValueCases)(
    "consumes a declared optional value before a dangerous command: --%s %s",
    (option, value) => {
      for (const command of ["exec", "env", "setup"] as const) {
        expect(() => assertPackageManagerControlArgs([`--${option}`, value, command, "node"]))
          .toThrow(/package-manager|switch/i);
      }
    },
  );

  it.each(Object.keys(optionalValueOptions))(
    "treats an omitted optional value as the command: --%s exec",
    (option) => {
      for (const command of ["exec", "env", "setup"] as const) {
        expect(() => assertPackageManagerControlArgs([`--${option}`, command, "node"]))
          .toThrow(/package-manager|switch/i);
      }
    },
  );

  it.each([
    ["--color", "always"],
    ["--color", "auto"],
    ["--color", "never"],
    ["--link-workspace-packages", "deep"],
    ["--scripts-prepend-node-path", "auto"],
    ["--scripts-prepend-node-path", "warn-only"],
  ])("recognizes the authoritative optional-value domain: %s %s", (option, value) => {
    expect(() => assertPackageManagerControlArgs([option, value, "run", "build"])).not.toThrow();
  });

  it("keeps command-level option provenance separate from exec metadata", () => {
    expect(packageManagerOptionCatalog.commandLevelOptions.run.optionalValueOptions)
      .toMatchObject({ "scripts-prepend-node-path": { values: ["auto", "warn-only"] } });
    expect(packageManagerOptionCatalog.commandLevelOptions.exec.optionalValueOptions)
      .not.toHaveProperty("scripts-prepend-node-path");
    expect(packageManagerOptionCatalog.commandLevelOptions.exec.requiredValueOptions)
      .toHaveProperty("resume-from");
    expect(packageManagerOptionCatalog.commandLevelOptions.run.requiredValueOptions)
      .toHaveProperty("resume-from");
  });

  it("rejects every COREPACK_* task environment override", () => {
    expect(() => assertPackageManagerEnvironment({ COREPACK_ROOT: "/tmp/attacker" }))
      .toThrow(/COREPACK_/);
    expect(() => assertPackageManagerEnvironment({ COREPACK_CUSTOM: "1" }))
      .toThrow(/COREPACK_/);
    expect(() => assertPackageManagerEnvironment({ NPM_CONFIG_PM_ON_FAIL: "download" }))
      .toThrow(/COREPACK|package-manager/i);
    expect(() => assertPackageManagerEnvironment({ NODE_ENV: "test" })).not.toThrow();
  });

  it("requires an exact pnpm packageManager declaration", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-"));
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );

    await expect(readPackageManager(worktree)).resolves.toEqual({
      name: "pnpm",
      version: "11.10.0",
      reference: "pnpm@11.10.0",
    });
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@^11.10.0" }),
      "utf8",
    );
    await expect(readPackageManager(worktree)).rejects.toThrow(/exact pnpm/i);
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0+sha512.abc+unexpected" }),
      "utf8",
    );
    await expect(readPackageManager(worktree)).rejects.toThrow(/exact pnpm/i);
  });

  it("rejects old provenance framing until it is explicitly re-provisioned", async () => {
    const fixture = await fakePackageManagerFixture("cursor-package-manager-migration");
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-migration-worktree-"));
    const stagingRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-migration-stage-"));
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );
    const oldManifest = JSON.parse(await readFile(fixture.manifest, "utf8")) as Record<string, unknown>;
    delete oldManifest.digestVersion;
    await writeFile(fixture.manifest, `${JSON.stringify(oldManifest)}\n`, "utf8");
    await chmod(fixture.manifest, 0o600);

    await withCorepackHome(fixture.sourceHome, async () => {
      await expect(stagePackageManager(worktree, stagingRoot, fixture.manifest))
        .rejects.toThrow(/manifest envelope|provisioning/i);
      await expect(provisionPackageManagerManifest(fixture.manifest, "11.10.0"))
        .resolves.toMatchObject({ version: "11.10.0", binary: "pnpm" });
      await expect(stagePackageManager(worktree, stagingRoot, fixture.manifest)).resolves.toBeDefined();
    });
  });

  it("fails closed when the exact host Corepack artifact is absent", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-missing-"));
    const scratch = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-missing-scratch-"));
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );
    const previous = process.env.COREPACK_HOME;
    process.env.COREPACK_HOME = path.join(scratch, "empty-host-cache");
    try {
      await expect(stagePackageManager(worktree, scratch, path.join(scratch, "manifest.json")))
        .rejects.toThrow(/pre-provision.*Corepack cache/i);
    } finally {
      if (previous === undefined) delete process.env.COREPACK_HOME;
      else process.env.COREPACK_HOME = previous;
    }
  });

  it("records top-level manager identity while a candidate launches an absolute dynamic child", async () => {
    if (process.platform !== "darwin") return;
    try {
      await stat(packageManagerDirectory(hostCorepackHome(), fakePackageManagerSpec));
    } catch {
      return;
    }
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-worktree-"));
    const scratch = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-scratch-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-cache-"));
    const hostilePath = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-hostile-path-"));
    const marker = path.join(hostilePath, "ran");
    const dynamicMarker = path.join(worktree, "hostile-dynamic-ran");
    const dynamicChild = path.join(hostilePath, "dynamic-pnpm");
    const dynamicLauncher = path.join(hostilePath, "dynamic-launcher");
    await writeFile(
      path.join(hostilePath, "pnpm"),
      `#!/bin/sh\nprintf ran > ${marker}\nexit 99\n`,
      { mode: 0o755 },
    );
    await writeFile(
      dynamicChild,
      `#!/bin/sh\nprintf ran > ${dynamicMarker}\n`,
      { mode: 0o755 },
    );
    await writeFile(
      dynamicLauncher,
      `#!/bin/sh\nchild="$(dirname "$0")/dynamic-pnpm"\n"$child"\n`,
      { mode: 0o755 },
    );
    const localBin = path.join(worktree, "node_modules", ".bin");
    const localMarker = path.join(worktree, "hostile-child-ran");
    await mkdir(localBin, { recursive: true });
    await writeFile(
      path.join(localBin, "pnpm"),
      `#!/bin/sh\nprintf ran > ${localMarker}\nprintf 99.99.99-hostile-child\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@11.10.0",
        scripts: { probe: dynamicLauncher, shadow: "pnpm --version" },
      }),
      "utf8",
    );

    const provenanceFile = path.join(cacheRoot, "manifest.json");
    await provisionPackageManagerManifest(provenanceFile, "11.10.0");
    expect((await stat(provenanceFile)).mode & 0o777).toBe(0o600);
    const staged = await stagePackageManager(worktree, cacheRoot, provenanceFile);
    const cacheMode = (await stat(staged.corepackHome)).mode & 0o777;
    expect(cacheMode & 0o222).toBe(0);

    const invocation = createVerificationSandbox({
      worktree,
      scratchDir: scratch,
      command: process.execPath,
      args: [staged.executable, "--version"],
      corepackHome: staged.corepackHome,
      readOnlyRoots: [staged.corepackHome, hostilePath],
      pathPrefix: [path.dirname(staged.executable), path.dirname(process.execPath)],
      baseEnv: { PATH: `${hostilePath}:/opt/homebrew/bin:/usr/bin:/bin` },
    });
    expect(invocation.args[1]).toContain("(deny network*)");
    const result = await runFile(invocation.command, invocation.args, {
      cwd: worktree,
      env: invocation.env,
      timeoutMs: 15_000,
    });

    expect(result.stdout.trim()).toBe("11.10.0");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const childInvocation = createVerificationSandbox({
      worktree,
      scratchDir: scratch,
      command: "/usr/bin/env",
      args: ["pnpm", "--version"],
      corepackHome: staged.corepackHome,
      readOnlyRoots: [staged.corepackHome, hostilePath],
      pathPrefix: [path.dirname(staged.executable), path.dirname(process.execPath)],
      baseEnv: { PATH: `${hostilePath}:/opt/homebrew/bin:/usr/bin:/bin` },
    });
    const childResult = await runFile(childInvocation.command, childInvocation.args, {
      cwd: worktree,
      env: childInvocation.env,
      timeoutMs: 15_000,
    });
    expect(childResult.stdout.trim()).toBe("11.10.0");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const dynamicInvocation = createVerificationSandbox({
      worktree,
      scratchDir: scratch,
      command: process.execPath,
      args: [staged.executable, "run", "probe"],
      corepackHome: staged.corepackHome,
      readOnlyRoots: [staged.corepackHome, hostilePath],
      pathPrefix: [path.dirname(staged.executable), path.dirname(process.execPath)],
      blockedProcessPaths: [path.join(localBin, "pnpm")],
      baseEnv: { PATH: `${hostilePath}:/opt/homebrew/bin:/usr/bin:/bin` },
    });
    await expect(runFile(dynamicInvocation.command, dynamicInvocation.args, {
      cwd: worktree,
      env: dynamicInvocation.env,
      timeoutMs: 15_000,
    })).resolves.toBeDefined();
    await expect(stat(dynamicMarker)).resolves.toBeDefined();

    const shadowInvocation = createVerificationSandbox({
      worktree,
      scratchDir: scratch,
      command: process.execPath,
      args: [staged.executable, "run", "shadow"],
      corepackHome: staged.corepackHome,
      readOnlyRoots: [staged.corepackHome, hostilePath],
      pathPrefix: [path.dirname(staged.executable), path.dirname(process.execPath)],
      blockedProcessPaths: [path.join(localBin, "pnpm")],
      baseEnv: { PATH: `${hostilePath}:/opt/homebrew/bin:/usr/bin:/bin` },
    });
    await expect(runFile(shadowInvocation.command, shadowInvocation.args, {
      cwd: worktree,
      env: shadowInvocation.env,
      timeoutMs: 15_000,
    })).rejects.toBeDefined();
    await expect(stat(localMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(staged).toMatchObject({
      name: "pnpm",
      binary: "pnpm",
      version: "11.10.0",
      entrypoint: "bin/pnpm.mjs",
      source: "verifier-owned-corepack-cache",
      network: "denied",
      scope: "top_level_only",
    });
    expect(staged.digest).toMatch(/^sha512\.[a-f0-9]+$/i);
    expect(staged.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, 30_000);

  it("rejects staged artifact tampering after preparation", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-tamper-worktree-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-tamper-cache-"));
    const fixture = await fakePackageManagerFixture("cursor-package-manager-tamper");
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );
    await withCorepackHome(fixture.sourceHome, async () => {
      const staged = await stagePackageManager(worktree, cacheRoot, fixture.manifest);
      await expect(assertStagedPackageManager(staged)).resolves.toBeUndefined();
      await chmod(staged.executable, 0o644);
      await writeFile(staged.executable, "tampered\n", "utf8");
      await expect(assertStagedPackageManager(staged)).rejects.toThrow(/digest changed|integrity|shim changed/i);
    });
  });

  it("rejects a source cache tamper after explicit provisioning", async () => {
    const stagingRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-trusted-stage-"));
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-trusted-worktree-"));
    const fixture = await fakePackageManagerFixture("cursor-package-manager-trusted");
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );
    await withCorepackHome(fixture.sourceHome, async () => {
      await chmod(path.join(fixture.sourceDirectory, "bin", "pnpm.mjs"), 0o644);
      await writeFile(path.join(fixture.sourceDirectory, "bin", "pnpm.mjs"), "pre-stage tamper\n", "utf8");
      await expect(stagePackageManager(worktree, stagingRoot, fixture.manifest))
        .rejects.toThrow(/provisioned artifact digest/i);
    });
  });

  it("keeps the staged cache outside writable scratch roots", async () => {
    if (process.platform !== "darwin") return;
    const worktree = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-rename-worktree-"));
    const scratch = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-rename-scratch-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "cursor-package-manager-rename-cache-"));
    const fixture = await fakePackageManagerFixture("cursor-package-manager-rename");
    await writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
      "utf8",
    );
    await withCorepackHome(fixture.sourceHome, async () => {
      const staged = await stagePackageManager(worktree, cacheRoot, fixture.manifest);
      const replacement = `${staged.corepackHome}.replacement`;
      const invocation = createVerificationSandbox({
        worktree,
        scratchDir: scratch,
        command: "/bin/mv",
        args: [staged.corepackHome, replacement],
        corepackHome: staged.corepackHome,
        readOnlyRoots: [staged.corepackHome],
      });
      await expect(runFile(invocation.command, invocation.args, {
        cwd: worktree,
        env: invocation.env,
        timeoutMs: 15_000,
      })).rejects.toBeDefined();
      await expect(stat(staged.corepackHome)).resolves.toBeDefined();
      await expect(stat(replacement)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }, 30_000);
});
