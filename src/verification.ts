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
  const segments = file.split("/");
  const basename = segments.at(-1) ?? "";
  const testDirectories = new Set(["test", "tests", "__tests__", "spec", "specs"]);
  return segments.slice(0, -1).some((segment) =>
    testDirectories.has(segment.toLowerCase())
    || /(?:Tests?|Specs?)$/.test(segment))
    || /(?:^|[._-])(?:test|spec)s?(?:[._-]|$)/i.test(basename)
    || /(?:Tests?|Specs?)(?:\.[^.]+)+$/.test(basename)
    || /^(?:Test|Spec)[A-Z0-9].*(?:\.[^.]+)+$/.test(basename);
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
