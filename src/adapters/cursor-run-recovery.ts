import { createHash } from "node:crypto";
import type { Run } from "@cursor/sdk";
import type { ImplementerOutcome } from "../application/workflow-ports.js";
import { redactSensitiveText } from "../application/redaction.js";
import type { Attempt } from "../domain/job.js";

const detachedRunSummary =
  "Recovery required: the persisted Cursor run is detached from a live executor and cannot be monitored safely.";

export function stableEventValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableEventValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableEventValue(record[key])}`).join(",")}}`;
}

export function eventKey(event: unknown, occurrence: number): string {
  const candidate = event as Record<string, unknown> | undefined;
  const authoritativeOffset = [
    candidate?.offset,
    candidate?.eventId,
    candidate?.event_id,
    candidate?.sequence,
    candidate?.seq,
    candidate?.id,
  ].find((value) => typeof value === "string" || typeof value === "number");
  if (authoritativeOffset !== undefined) return `offset:${String(authoritativeOffset)}`;
  const digest = createHash("sha256")
    .update(stableEventValue(event))
    .digest("hex");
  return `digest:${digest}:${occurrence}`;
}

export function supportsRunOperation(
  run: Run,
  operation: "wait" | "stream",
): boolean {
  const candidate = run as Run & {
    supports?: (supportedOperation: "wait" | "stream") => boolean;
    unsupportedReason?: (unsupportedOperation: "wait" | "stream") => string | undefined;
  };
  if (typeof candidate.supports === "function") {
    return candidate.supports(operation);
  }
  if (typeof candidate.unsupportedReason === "function") {
    return candidate.unsupportedReason(operation) === undefined;
  }
  return typeof run[operation] === "function";
}

export function recoveredRunMetadata(
  run: Run,
): Pick<ImplementerOutcome, "inputTokens" | "outputTokens" | "requestId"> {
  return {
    ...(run.requestId ? { requestId: run.requestId } : {}),
    ...(run.usage ? {
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
    } : {}),
  };
}

export function detachedRunOutcome(
  run: Run,
  attempt: Attempt,
  agentId: string,
): ImplementerOutcome {
  const reason = typeof run.unsupportedReason === "function"
    ? run.unsupportedReason("wait")
    : "The SDK did not expose a live wait capability for this running run.";
  return {
    status: "blocked",
    agentId,
    runId: run.id,
    ...recoveredRunMetadata(run),
    summary: redactSensitiveText(detachedRunSummary),
    reason: redactSensitiveText([
      "RECOVERY_REQUIRED: inspect the persisted Cursor run and recover it explicitly before retrying this task.",
      reason,
      `Attempt ${attempt.id} remains fenced; no automatic resume, send, cancel, or duplicate run was performed.`,
    ].filter(Boolean).join(" ")),
  };
}
