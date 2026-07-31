/**
 * The pnpm command-line option contract for the staged pnpm version.
 *
 * This is intentionally a typed catalog rather than a flat "options that
 * consume the next token" list.  pnpm's nopt metadata distinguishes boolean
 * options, required values, and unions such as
 * `[Boolean, "always", "auto", "never"]`.  Treating the latter as an
 * unconditional value option lets a command such as `--color exec` hide the
 * dangerous `exec` command from the independent verifier.
 *
 * Source: pnpm@11.10.0 `pnpmTypes`, `npmConfigTypes`, GLOBAL_OPTIONS, and the
 * command `cliOptionsTypes`/`rcOptionsTypes` definitions in the provisioned
 * Corepack artifact.  Keep this catalog versioned with that exact staged
 * package-manager version.
 */

export type PackageManagerRequiredValueKind =
  | "array"
  | "enum"
  | "number"
  | "string"
  | "string-or-array";

export interface PackageManagerOptionalValueOption {
  readonly values: readonly string[];
  /** The type union also accepts literal true/false values. */
  readonly acceptsBoolean: true;
}

export interface PackageManagerRequiredValueOption {
  readonly kind: PackageManagerRequiredValueKind;
  readonly values?: readonly string[];
}

export interface PackageManagerCommandOptionCatalog {
  readonly requiredValueOptions: Readonly<Record<string, PackageManagerRequiredValueOption>>;
  readonly optionalValueOptions: Readonly<Record<string, PackageManagerOptionalValueOption>>;
  readonly booleanOptions: readonly string[];
}

const requiredValueOptions = {
  access: { kind: "enum", values: ["restricted", "public"] },
  "audit-level": { kind: "enum", values: ["low", "moderate", "high", "critical"] },
  ca: { kind: "string-or-array" },
  "cache-dir": { kind: "string" },
  cafile: { kind: "string" },
  "catalog-mode": { kind: "enum", values: ["strict", "prefer", "manual"] },
  cert: { kind: "string" },
  "changed-files-ignore-pattern": { kind: "string-or-array" },
  "child-concurrency": { kind: "number" },
  "config-dir": { kind: "string" },
  cpu: { kind: "string-or-array" },
  depth: { kind: "number" },
  "dlx-cache-max-age": { kind: "number" },
  dir: { kind: "string" },
  "fetch-min-speed-ki-bps": { kind: "number" },
  "fetch-retries": { kind: "number" },
  "fetch-retry-factor": { kind: "number" },
  "fetch-retry-maxtimeout": { kind: "number" },
  "fetch-retry-mintimeout": { kind: "number" },
  "fetch-timeout": { kind: "number" },
  "fetch-warn-timeout-ms": { kind: "number" },
  "fetching-concurrency": { kind: "number" },
  filter: { kind: "string-or-array" },
  "filter-prod": { kind: "string-or-array" },
  git: { kind: "string" },
  "git-shallow-hosts": { kind: "array" },
  "global-bin-dir": { kind: "string" },
  "global-dir": { kind: "string" },
  "global-path": { kind: "string" },
  "global-pnpmfile": { kind: "string" },
  "global-virtual-store-dir": { kind: "string" },
  "hoist-pattern": { kind: "array" },
  "hoisting-limits": { kind: "enum", values: ["none", "workspaces", "dependencies"] },
  "http-proxy": { kind: "string" },
  "https-proxy": { kind: "string" },
  "init-author-email": { kind: "string" },
  "init-author-name": { kind: "string" },
  "init-author-url": { kind: "string" },
  "init-license": { kind: "string" },
  "init-type": { kind: "enum", values: ["commonjs", "module"] },
  "init-version": { kind: "string" },
  key: { kind: "string" },
  libc: { kind: "string-or-array" },
  "lockfile-dir": { kind: "string" },
  loglevel: { kind: "enum", values: ["silent", "error", "warn", "info", "debug"] },
  "local-address": { kind: "string" },
  maxsockets: { kind: "number" },
  message: { kind: "string" },
  "merge-git-branch-lockfiles-branch-pattern": { kind: "array" },
  "minimum-release-age": { kind: "number" },
  "minimum-release-age-exclude": { kind: "string-or-array" },
  "modules-cache-max-age": { kind: "number" },
  "modules-dir": { kind: "string" },
  "network-concurrency": { kind: "number" },
  "node-options": { kind: "string" },
  "node-package-map-type": { kind: "enum", values: ["standard", "loose"] },
  "node-version": { kind: "string" },
  "node-linker": { kind: "enum", values: ["pnp", "isolated", "hoisted"] },
  noproxy: { kind: "string" },
  "no-proxy": { kind: "string-or-array" },
  "npm-path": { kind: "string" },
  "npmrc-auth-file": { kind: "string" },
  only: { kind: "enum", values: ["dev", "development", "prod", "production"] },
  otp: { kind: "string" },
  os: { kind: "string-or-array" },
  "pack-destination": { kind: "string" },
  "pack-gzip-level": { kind: "number" },
  "package-import-method": { kind: "enum", values: ["auto", "hardlink", "clone", "copy"] },
  "patches-dir": { kind: "string" },
  "peers-suffix-max-length": { kind: "number" },
  pnpmfile: { kind: "string" },
  "pm-on-fail": { kind: "enum", values: ["download", "error", "warn", "ignore"] },
  prefix: { kind: "string" },
  proxy: { kind: "string" },
  "public-hoist-pattern": { kind: "array" },
  "publish-branch": { kind: "string" },
  "pnpr-server": { kind: "string" },
  registry: { kind: "string" },
  reporter: { kind: "string" },
  "resolution-mode": { kind: "enum", values: ["highest", "time-based", "lowest-direct"] },
  "runtime-on-fail": { kind: "enum", values: ["ignore", "warn", "error", "download"] },
  "save-catalog-name": { kind: "string" },
  "save-prefix": { kind: "string" },
  scope: { kind: "string" },
  "script-shell": { kind: "string" },
  "state-dir": { kind: "string" },
  "store-dir": { kind: "string" },
  "sync-injected-deps-after-scripts": { kind: "array" },
  tag: { kind: "string" },
  "tag-version-prefix": { kind: "string" },
  "test-pattern": { kind: "string-or-array" },
  "trust-policy": { kind: "enum", values: ["off", "no-downgrade"] },
  "trust-policy-exclude": { kind: "string-or-array" },
  "trust-policy-ignore-after": { kind: "number" },
  umask: { kind: "number" },
  "user-agent": { kind: "string" },
  userconfig: { kind: "string" },
  "virtual-store-dir": { kind: "string" },
  "virtual-store-dir-max-length": { kind: "number" },
  "workspace-concurrency": { kind: "number" },
  "workspace-packages": { kind: "string-or-array" },
} as const satisfies Readonly<Record<string, PackageManagerRequiredValueOption>>;

const optionalValueOptions = {
  color: { values: ["always", "auto", "never"], acceptsBoolean: true },
  dev: { values: [], acceptsBoolean: true },
  "link-workspace-packages": { values: ["deep"], acceptsBoolean: true },
  production: { values: [], acceptsBoolean: true },
} as const satisfies Readonly<Record<string, PackageManagerOptionalValueOption>>;

const booleanOptions = [
  "allow-same-version",
  "aggregate-output",
  "auto-install-peers",
  "bail",
  "bin-links",
  "block-exotic-subdeps",
  "ci",
  "commit-hooks",
  "dangerously-allow-all-builds",
  "dedupe-direct-deps",
  "dedupe-injected-deps",
  "dedupe-peer-dependents",
  "dedupe-peers",
  "deploy-all-files",
  "description",
  "disallow-workspace-cycles",
  "dry-run",
  "embed-readme",
  "enable-global-virtual-store",
  "enable-modules-dir",
  "enable-pre-post-scripts",
  "engine-strict",
  "exclude-links-from-lockfile",
  "extend-node-path",
  "fail-if-no-match",
  "force",
  "force-legacy-deploy",
  "frozen-lockfile",
  "frozen-store",
  "git-branch-lockfile",
  "git-checks",
  "git-tag-version",
  "global",
  "hoist",
  "hoist-workspace-packages",
  "ignore-compatibility-db",
  "ignore-pnpmfile",
  "ignore-scripts",
  "ignore-workspace",
  "ignore-workspace-cycles",
  "ignore-workspace-root-check",
  "include-workspace-root",
  "init-package-manager",
  "inject-workspace-packages",
  "json",
  "legacy-dir-filtering",
  "lockfile",
  "lockfile-include-tarball-url",
  "lockfile-only",
  "merge-git-branch-lockfiles",
  "minimum-release-age-ignore-missing-time",
  "minimum-release-age-strict",
  "node-experimental-package-map",
  "offline",
  "long",
  "optional",
  "optimistic-repeat-install",
  "package-lock",
  "parseable",
  "prefer-frozen-lockfile",
  "prefer-offline",
  "prefer-symlinked-executables",
  "prefer-workspace-packages",
  "preserve-absolute-paths",
  "progress",
  "provenance",
  "recursive-install",
  "reporter-hide-prefix",
  "resolve-peers-from-workspace-root",
  "registry-supports-time-field",
  "runtime",
  "save",
  "save-dev",
  "save-exact",
  "save-optional",
  "save-peer",
  "save-prod",
  "save-workspace-protocol",
  "sign-git-tag",
  "shamefully-hoist",
  "shared-workspace-lockfile",
  "shell-emulator",
  "side-effects-cache",
  "side-effects-cache-readonly",
  "skip-manifest-obfuscation",
  "sort",
  "stream",
  "strict-dep-builds",
  "strict-peer-dependencies",
  "strict-ssl",
  "strict-store-pkg-content-check",
  "symlink",
  "trust-lockfile",
  "unsafe-perm",
  "update-notifier",
  "use-beta-cli",
  "use-stderr",
  "verify-deps-before-run",
  "verify-store-integrity",
  "version",
  "virtual-store-only",
  "workspace-root",
  "yes",
] as const;

const commandLevelOptions = {
  exec: {
    requiredValueOptions: {
      "resume-from": { kind: "string" },
    },
    optionalValueOptions: {},
    booleanOptions: ["shell-mode"] as const,
  },
  run: {
    requiredValueOptions: {
      "resume-from": { kind: "string" },
    },
    optionalValueOptions: {
      // Present in npmConfigTypes, but only in run's cliOptionsTypes.  It is
      // deliberately not treated as an exec option.
      "scripts-prepend-node-path": {
        values: ["auto", "warn-only"],
        acceptsBoolean: true,
      },
    },
    booleanOptions: ["if-present", "parallel", "recursive", "reverse", "sequential"] as const,
  },
} as const satisfies Readonly<Record<string, PackageManagerCommandOptionCatalog>>;

const allRequiredValueOptions = {
  ...requiredValueOptions,
  ...commandLevelOptions.exec.requiredValueOptions,
  ...commandLevelOptions.run.requiredValueOptions,
} as const;

const allOptionalValueOptions = {
  ...optionalValueOptions,
  ...commandLevelOptions.exec.optionalValueOptions,
  ...commandLevelOptions.run.optionalValueOptions,
} as const;

/**
 * `valueOptions` remains as a compatibility view for callers that only need
 * the required-value names.  New parser code should use the typed views above.
 */
export const packageManagerOptionCatalog = {
  source: "pnpm@11.10.0 pnpmTypes+ npmConfigTypes + GLOBAL_OPTIONS + command cli/rc option metadata",
  requiredValueOptions,
  optionalValueOptions,
  allRequiredValueOptions,
  allOptionalValueOptions,
  booleanOptions,
  commandLevelOptions,
  valueOptions: Object.keys(allRequiredValueOptions),
  shortValueOptions: {
    C: "dir",
    F: "filter",
  },
} as const;

export type PackageManagerOptionCatalog = typeof packageManagerOptionCatalog;
