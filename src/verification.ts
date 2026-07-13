import { evaluateChangedPaths } from "./paths.js";

export interface ChangeAssessmentInput {
  files: readonly string[];
  deletedFiles: readonly string[];
  diffLines: number;
  allowedPatterns: readonly string[];
  forbiddenPatterns: readonly string[];
  maxChangedFiles: number;
  maxDiffLines: number;
  allowTestDeletion: boolean;
}

export interface ChangeAssessment {
  ok: boolean;
  reasons: string[];
  allowed: string[];
  forbidden: string[];
  outOfScope: string[];
}

function isTestFile(file: string): boolean {
  return file.startsWith("tests/") || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(file);
}

export function assessChanges(input: ChangeAssessmentInput): ChangeAssessment {
  const paths = evaluateChangedPaths(input.files, input.allowedPatterns, input.forbiddenPatterns);
  const reasons: string[] = [];
  if (paths.forbidden.length > 0) reasons.push(`Forbidden paths changed: ${paths.forbidden.join(", ")}`);
  if (paths.outOfScope.length > 0) reasons.push(`Out-of-scope paths changed: ${paths.outOfScope.join(", ")}`);
  if (input.files.length > input.maxChangedFiles) {
    reasons.push(`Changed file limit exceeded: ${input.files.length} > ${input.maxChangedFiles}`);
  }
  if (input.diffLines > input.maxDiffLines) {
    reasons.push(`Diff line limit exceeded: ${input.diffLines} > ${input.maxDiffLines}`);
  }
  const deletedTests = input.deletedFiles.filter(isTestFile);
  if (!input.allowTestDeletion && deletedTests.length > 0) {
    reasons.push(`Deleted test files are not allowed: ${deletedTests.join(", ")}`);
  }
  return { ok: reasons.length === 0, reasons, ...paths };
}
