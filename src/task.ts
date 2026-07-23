import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { z } from "zod";

export const CURRENT_POLICY_VERSION = 2;
const EMPTY_HASH = `sha256:${"0".repeat(64)}`;
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

const relativePath = z.string().min(1).refine((value) => {
  return !value.startsWith("/") && !value.split("/").includes("..");
}, "path must be repository-relative and may not traverse upward");

const safeVerificationEnv = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string())
  .superRefine((env, context) => {
    const secretNames = Object.keys(env).filter((name) =>
      /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH)(?:_|$)/i.test(name),
    );
    if (secretNames.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Verification environment may not contain secret-shaped names: ${secretNames.join(", ")}`,
      });
    }
    const reservedNames = Object.keys(env).filter((name) =>
      ["HOME", "TMPDIR", "PATH", "SHELL", "SSH_AUTH_SOCK", "NODE_OPTIONS"].includes(name),
    );
    if (reservedNames.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Verification environment may not override reserved sandbox variables: ${reservedNames.join(", ")}`,
      });
    }
  });

const verificationCommandSchema = z.object({
  command: z.string().min(1).refine((value) => !value.includes("/"), "command must be resolved through PATH"),
  args: z.array(z.string()).default([]),
  env: safeVerificationEnv.optional(),
  timeout_seconds: z.number().int().positive().max(3600).default(900),
});

const verificationSchema = z.object({
  commands: z.array(verificationCommandSchema).min(1),
  profile_hash: hashSchema.optional(),
});

const pullRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new_draft") }),
  z.object({ mode: z.literal("existing_pr"), number: z.number().int().positive() }),
]);

const taskShape = {
  id: z.string().regex(/^TASK-[A-Z0-9][A-Z0-9-]*$/),
  repository: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(200),
  spec_version: z.number().int().positive(),
  goal: z.string().min(1),
  context_files: z.array(relativePath).default([]),
  allowed_paths: z.array(relativePath).min(1),
  forbidden_paths: z.array(relativePath).default([]),
  non_goals: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).min(1),
  implementation_constraints: z.array(z.string()).default([]),
  verification: verificationSchema,
  required_new_tests: z.array(z.string()).default([]),
  limits: z.object({
    max_changed_files: z.number().int().positive().max(500),
    max_diff_lines: z.number().int().positive().max(100_000),
    allow_test_deletion: z.boolean().default(false),
    max_repair_attempts: z.number().int().min(0).max(2).default(1),
  }),
  stop_conditions: z.array(z.string()).default([]),
  pull_request: pullRequestSchema,
};

const draftTaskSchema = z.object({
  ...taskShape,
  status: z.literal("draft"),
  spec_hash: hashSchema.optional(),
  policy_version: z.number().int().positive().optional(),
  target: z.object({
    origin: z.string(),
    base_ref: z.string(),
    base_sha: gitObjectSchema,
    context_digest: hashSchema,
  }).optional(),
  approval: z.object({
    approved_at: z.string().datetime(),
    approved_by: z.string().min(1),
  }).optional(),
});

const approvedTaskSchema = z.object({
  ...taskShape,
  status: z.literal("approved"),
  spec_hash: hashSchema,
  policy_version: z.literal(CURRENT_POLICY_VERSION),
  target: z.object({
    origin: z.string().regex(/^[^/]+\/[^/]+$/),
    base_ref: z.string().min(1),
    base_sha: gitObjectSchema,
    context_digest: hashSchema,
  }),
  approval: z.object({
    approved_at: z.string().datetime(),
    approved_by: z.string().min(1),
  }),
  verification: verificationSchema.extend({ profile_hash: hashSchema }),
});

export const taskSchema = z.discriminatedUnion("status", [draftTaskSchema, approvedTaskSchema]);

export type Task = z.infer<typeof taskSchema>;
export type ApprovedTask = z.infer<typeof approvedTaskSchema>;
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

export interface TaskApprovalContext {
  origin: string;
  baseRef: string;
  baseSha: string;
  contextDigest: string;
  approvedAt?: string;
  approvedBy?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "spec_hash")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function sha256(value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
  return `sha256:${digest}`;
}

export function parseTask(input: unknown): Task {
  return taskSchema.parse(input);
}

export function computeVerificationProfileHash(
  verification: Pick<Task["verification"], "commands">,
): string {
  const commands = z.array(verificationCommandSchema).min(1).parse(verification.commands);
  return sha256({ commands });
}

export function computeSpecHash(input: unknown): string {
  if (input === null || typeof input !== "object") return sha256(parseTask(input));
  const candidate = { ...(input as Record<string, unknown>) };
  if (candidate.status === "approved" && candidate.spec_hash === undefined) {
    candidate.spec_hash = EMPTY_HASH;
  }
  const parsed = parseTask(candidate);
  return sha256(parsed);
}

export async function loadTaskFile(file: string): Promise<Task> {
  return parseTask(parse(await readFile(file, "utf8")));
}

export async function approveTaskFile(file: string, context: TaskApprovalContext): Promise<ApprovedTask> {
  const current = await loadTaskFile(file);
  if (current.status !== "draft") throw new Error(`Task ${current.id} is not draft`);
  const verification = {
    ...current.verification,
    profile_hash: computeVerificationProfileHash(current.verification),
  };
  const approved = approvedTaskSchema.parse({
    ...current,
    status: "approved",
    spec_hash: EMPTY_HASH,
    policy_version: CURRENT_POLICY_VERSION,
    target: {
      origin: context.origin,
      base_ref: context.baseRef,
      base_sha: context.baseSha,
      context_digest: context.contextDigest,
    },
    approval: {
      approved_at: context.approvedAt ?? new Date().toISOString(),
      approved_by: context.approvedBy ?? process.env.USER ?? "local-user",
    },
    verification,
  });
  const withHash = approvedTaskSchema.parse({ ...approved, spec_hash: computeSpecHash(approved) });
  await writeFile(file, stringify(withHash, { lineWidth: 100 }), "utf8");
  return withHash;
}

export function assertApprovedTask(
  task: Task,
  expectedVersion: number,
  expectedHash: string,
  expectedTarget?: { origin: string; baseSha?: string },
): asserts task is ApprovedTask {
  if (task.status !== "approved") throw new Error(`Task ${task.id} is not approved`);
  if (task.spec_version !== expectedVersion) throw new Error("STALE_SPEC: spec version does not match");
  if (task.spec_hash !== expectedHash || computeSpecHash(task) !== expectedHash) {
    throw new Error("STALE_SPEC: spec hash does not match");
  }
  if (Number(task.policy_version) !== CURRENT_POLICY_VERSION) {
    throw new Error(`STALE_SPEC: unsupported policy version ${task.policy_version}`);
  }
  if (task.verification.profile_hash !== computeVerificationProfileHash(task.verification)) {
    throw new Error("STALE_SPEC: verification profile hash does not match");
  }
  if (expectedTarget && task.target.origin !== expectedTarget.origin) {
    throw new Error("STALE_SPEC: target origin does not match registered repository");
  }
  if (expectedTarget?.baseSha && task.target.base_sha !== expectedTarget.baseSha) {
    throw new Error("STALE_SPEC: target base does not match");
  }
}
