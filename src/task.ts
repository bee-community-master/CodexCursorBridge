import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { z } from "zod";

const relativePath = z.string().min(1).refine((value) => {
  return !value.startsWith("/") && !value.split("/").includes("..");
}, "path must be repository-relative and may not traverse upward");

const verificationCommandSchema = z.object({
  command: z.string().min(1).refine((value) => !value.includes("/"), "command must be resolved through PATH"),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  timeout_seconds: z.number().int().positive().max(3600).default(900),
});

const pullRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new_draft") }),
  z.object({ mode: z.literal("existing_pr"), number: z.number().int().positive() }),
]);

export const taskSchema = z.object({
  id: z.string().regex(/^TASK-[A-Z0-9][A-Z0-9-]*$/),
  repository: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(200),
  spec_version: z.number().int().positive(),
  status: z.enum(["draft", "approved"]),
  spec_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  goal: z.string().min(1),
  context_files: z.array(relativePath).default([]),
  allowed_paths: z.array(relativePath).min(1),
  forbidden_paths: z.array(relativePath).default([]),
  non_goals: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).min(1),
  implementation_constraints: z.array(z.string()).default([]),
  verification: z.object({ commands: z.array(verificationCommandSchema).min(1) }),
  required_new_tests: z.array(z.string()).default([]),
  limits: z.object({
    max_changed_files: z.number().int().positive().max(500),
    max_diff_lines: z.number().int().positive().max(100_000),
    allow_test_deletion: z.boolean().default(false),
  }),
  stop_conditions: z.array(z.string()).default([]),
  pull_request: pullRequestSchema,
});

export type Task = z.infer<typeof taskSchema>;
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

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

export function parseTask(input: unknown): Task {
  return taskSchema.parse(input);
}

export function computeSpecHash(input: unknown): string {
  const withoutHash = input !== null && typeof input === "object"
    ? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key]) => key !== "spec_hash"))
    : input;
  const parsed = parseTask(withoutHash);
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(parsed))).digest("hex");
  return `sha256:${digest}`;
}

export async function loadTaskFile(file: string): Promise<Task> {
  return parseTask(parse(await readFile(file, "utf8")));
}

export async function approveTaskFile(file: string): Promise<Task> {
  const current = await loadTaskFile(file);
  if (current.status !== "draft") throw new Error(`Task ${current.id} is not draft`);
  const approved = parseTask({ ...current, status: "approved", spec_hash: undefined });
  const withHash = parseTask({ ...approved, spec_hash: computeSpecHash(approved) });
  await writeFile(file, stringify(withHash, { lineWidth: 100 }), "utf8");
  return withHash;
}

export function assertApprovedTask(task: Task, expectedVersion: number, expectedHash: string): void {
  if (task.status !== "approved") throw new Error(`Task ${task.id} is not approved`);
  if (task.spec_version !== expectedVersion) throw new Error("STALE_SPEC: spec version does not match");
  if (task.spec_hash !== expectedHash || computeSpecHash(task) !== expectedHash) {
    throw new Error("STALE_SPEC: spec hash does not match");
  }
}
