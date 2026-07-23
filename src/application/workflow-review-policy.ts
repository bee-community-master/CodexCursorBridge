import type { ApprovedTask } from "../domain/task.js";
import { assessChanges, type ChangeAssessment } from "./change-assessment.js";
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

export function firstVerificationFailure(
  results: readonly VerificationResult[],
): VerificationResult | undefined {
  return results.find((result) => result.status === "failed");
}

export function repairFeedbackFor(failure: VerificationResult): string {
  return [
    "Independent verification failed. Repair only the evidenced failure and stay within the approved scope.",
    `Command: ${failure.command}`,
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
