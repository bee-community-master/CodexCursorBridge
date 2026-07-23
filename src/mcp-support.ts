import { readFile } from "node:fs/promises";
import { safeErrorMessage } from "./redaction.js";
import { terminalJobStatuses, type JobStatus } from "./state.js";

interface WakeableJob {
  id: string;
  status: JobStatus;
  currentAttemptId?: string;
}

interface EventRecorder {
  recordEvent(
    jobId: string,
    attemptId: string | undefined,
    type: string,
    data: Record<string, unknown>,
  ): void;
}

type TextReader = (file: string, encoding: "utf8") => Promise<string>;

export type ReportReadResult =
  | { ok: true; report: string }
  | { ok: false; error: string };

export async function readReportText(
  file: string,
  reader: TextReader = readFile,
): Promise<ReportReadResult> {
  try {
    return { ok: true, report: await reader(file, "utf8") };
  } catch (error) {
    return { ok: false, error: safeErrorMessage(error) };
  }
}

export async function wakeJobSupervisor(
  store: EventRecorder,
  job: WakeableJob,
  wake: () => Promise<void>,
): Promise<string | undefined> {
  if (terminalJobStatuses.has(job.status)) return undefined;
  try {
    await wake();
    return undefined;
  } catch (error) {
    const wakeError = safeErrorMessage(error);
    try {
      store.recordEvent(
        job.id,
        job.currentAttemptId,
        "SUPERVISOR_WAKE_FAILED",
        { error: wakeError },
      );
      return wakeError;
    } catch (eventError) {
      return `${wakeError}; wake failure event could not be recorded: ${safeErrorMessage(eventError)}`;
    }
  }
}
