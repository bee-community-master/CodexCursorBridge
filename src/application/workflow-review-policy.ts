import type { ApprovedTask } from "../domain/task.js";
import {
  assessChanges,
  hasNonDeletedTestChange,
  type ChangeAssessment,
} from "./change-assessment.js";
import type {
  CandidateTree,
  CollectedChanges,
  VerificationResult,
} from "./workflow-ports.js";

export function assessCandidateChanges(
  task: ApprovedTask,
  changes: CollectedChanges,
): ChangeAssessment {
  return assessChanges({
    files: changes.files,
    deletedFiles: changes.deletedFiles,
    diffLines: changes.diffLines,
    allowedPatterns: task.allowed_paths,
    forbiddenPatterns: task.forbidden_paths,
    maxChangedFiles: task.limits.max_changed_files,
    maxDiffLines: task.limits.max_diff_lines,
    allowTestDeletion: task.limits.allow_test_deletion,
  });
}

export function verificationFailure(
  results: readonly VerificationResult[],
): VerificationResult | undefined {
  const failures = results.filter((result) => result.status === "failed");
  if (failures.length <= 1) return failures[0];
  return {
    command: failures.map((failure) => failure.command).join(", "),
    status: "failed",
    durationMs: failures.reduce(
      (duration, failure) => duration + failure.durationMs,
      0,
    ),
    output: failures.map((failure) => [
      `Command: ${failure.command}`,
      failure.output ?? "No verifier output was captured.",
    ].join("\n")).join("\n\n"),
  };
}

export function repairFeedbackFor(failure: VerificationResult): string {
  return [
    "Independent verification failed. Repair only the evidenced failures and stay within the approved scope.",
    `Failed checks: ${failure.command}`,
    `Output:\n${failure.output ?? "No verifier output was captured."}`,
  ].join("\n\n");
}

export function candidateTreeStabilityFailure(
  before: CandidateTree,
  after: CandidateTree,
): VerificationResult {
  return {
    command: "candidate-tree-stability",
    status: "failed",
    durationMs: 0,
    output: [
      "Candidate tree changed during independent verification.",
      `Before: ${before.treeHash}`,
      `After: ${after.treeHash}`,
      "The verification evidence does not cover the candidate that would be published.",
    ].join("\n"),
  };
}

export function candidateChangePresenceFailure(): VerificationResult {
  return {
    command: "candidate-change-presence",
    status: "failed",
    durationMs: 0,
    output: [
      "The completed implementation contains no changed files.",
      "A Draft PR cannot be delivered without a candidate change.",
    ].join("\n"),
  };
}

export function requiredTestChangeFailure(
  task: ApprovedTask,
  changes: CollectedChanges,
): VerificationResult | undefined {
  if (
    task.required_new_tests.length === 0
    || hasNonDeletedTestChange(changes.files, changes.deletedFiles)
  ) {
    return undefined;
  }
  return {
    command: "required-test-change",
    status: "failed",
    durationMs: 0,
    output: [
      "Required test changes are missing from the candidate.",
      "At least one non-deleted test file must change to satisfy the approved Task.",
      ...task.required_new_tests.map((requirement) => `- ${requirement}`),
    ].join("\n"),
  };
}
