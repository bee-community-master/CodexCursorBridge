import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AttestationData,
  WorkflowReportData,
} from "../application/workflow-ports.js";
import type { RuntimePaths } from "../domain/configuration.js";
import { redactSensitiveText } from "../application/redaction.js";
import { writeOwnerOnlyAtomic } from "./owner-only-atomic-file.js";

function redactedVerification(
  results: AttestationData["verification"],
): AttestationData["verification"] {
  return results.map((result) => ({
    ...result,
    ...(result.output
      ? { output: redactSensitiveText(result.output) }
      : {}),
  }));
}

export class WorkflowArtifactWriter {
  readonly #paths: RuntimePaths;

  constructor(paths: RuntimePaths) {
    this.#paths = paths;
  }

  async writeAttestation(data: AttestationData): Promise<string> {
    await mkdir(this.#paths.reportsDir, { recursive: true, mode: 0o700 });
    const attestationPath = path.join(
      this.#paths.reportsDir,
      `${data.job.id}.attestation.json`,
    );
    await writeOwnerOnlyAtomic(attestationPath, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      jobId: data.job.id,
      task: {
        id: data.task.id,
        specVersion: data.task.spec_version,
        specHash: data.task.spec_hash,
        policyVersion: data.task.policy_version,
        verificationProfileHash: data.task.verification.profile_hash,
        target: data.task.target,
      },
      source: {
        taskCommitSha: data.job.taskCommitSha,
        taskBlobSha: data.job.taskBlobSha,
      },
      candidate: data.tree,
      publication: data.publication,
      verification: redactedVerification(data.verification),
      attempts: data.attempts.map((attempt) => ({
        id: attempt.id,
        ordinal: attempt.ordinal,
        status: attempt.status,
        cursorAgentId: attempt.cursorAgentId,
        cursorRunId: attempt.cursorRunId,
        cursorRequestId: attempt.cursorRequestId,
        outcome: attempt.outcome,
        outcomeSummary: attempt.outcomeSummary
          ? redactSensitiveText(attempt.outcomeSummary)
          : undefined,
        outcomeReason: attempt.outcomeReason
          ? redactSensitiveText(attempt.outcomeReason)
          : undefined,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
      })),
    }, null, 2)}\n`);
    return attestationPath;
  }

  async writeReport(data: WorkflowReportData): Promise<string> {
    await mkdir(this.#paths.reportsDir, { recursive: true, mode: 0o700 });
    const currentAttempt = data.job.currentAttemptId
      ? data.attempts?.find((attempt) => attempt.id === data.job.currentAttemptId)
      : undefined;
    const reportOwner = data.reportOwner ?? (currentAttempt
      ? { attemptId: currentAttempt.id, workerToken: currentAttempt.workerToken }
      : undefined);
    const ownerSuffix = reportOwner
      ? `.${reportOwner.attemptId}.${createHash("sha256")
        .update(reportOwner.workerToken)
        .digest("hex")
        .slice(0, 16)}`
      : "";
    const reportPath = path.join(this.#paths.reportsDir, `${data.job.id}${ownerSuffix}.md`);
    const lines = [
      `# ${data.task.id} Cursor 실행 보고서`,
      "",
      `- 상태: ${data.job.status}`,
      `- 저장소: ${data.task.repository}`,
      `- 명세: v${data.task.spec_version} ${data.task.spec_hash}`,
      `- 대상 기준 SHA: ${data.task.target.base_sha}`,
      ...(data.publication ? [
        `- PR: ${data.publication.prUrl}`,
        `- 게시 HEAD: ${data.publication.headSha}`,
      ] : data.job.prUrl ? [`- PR: ${data.job.prUrl}`] : []),
      "",
      "## Cursor 요약",
      "",
      data.cursorSummary ? redactSensitiveText(data.cursorSummary) : "요약 없음.",
      "",
      "## 변경 파일",
      "",
      ...(data.changes?.files.map((file) => `- ${file}`) ?? ["- 수집되지 않음"]),
      "",
      "## 독립 검증",
      "",
      ...(data.verification?.flatMap((result) => [
        `- ${result.status.toUpperCase()}: \`${result.command}\` (${result.durationMs}ms)`,
        ...(result.output
          ? redactSensitiveText(result.output).split("\n").map((line) => `    ${line}`)
          : []),
      ]) ?? ["- 실행되지 않음"]),
      ...(data.attempts ? [
        "",
        "## 시도",
        "",
        ...data.attempts.map((attempt) =>
          `- #${attempt.ordinal} ${attempt.status}${attempt.cursorRunId ? ` (run ${attempt.cursorRunId})` : ""}`,
        ),
      ] : []),
      ...(data.assessment && !data.assessment.ok ? [
        "",
        "## 범위 위반",
        "",
        ...data.assessment.reasons.map((reason) => `- ${reason}`),
      ] : []),
      ...(data.error ? ["", "## 오류", "", redactSensitiveText(data.error)] : []),
      "",
    ];
    await writeOwnerOnlyAtomic(reportPath, lines.join("\n"));
    return reportPath;
  }
}
