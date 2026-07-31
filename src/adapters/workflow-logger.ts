import { appendFile, chmod, readFile } from "node:fs/promises";
import { redactSensitiveText } from "../application/redaction.js";
import type { PublicationStatePort } from "../application/workflow-ports.js";

export interface WorkflowLogger {
  log(message: string): Promise<void>;
  logEvent?(eventKey: string, message: string): Promise<void>;
}

export class FileWorkflowLogger implements WorkflowLogger {
  readonly #store: Pick<PublicationStatePort, "get">;
  readonly #jobId: string;

  constructor(store: Pick<PublicationStatePort, "get">, jobId: string) {
    this.#store = store;
    this.#jobId = jobId;
  }

  async log(message: string): Promise<void> {
    const job = this.#store.get(this.#jobId);
    if (!job?.logPath) return;
    await appendFile(
      job.logPath,
      `[${new Date().toISOString()}] ${redactSensitiveText(message)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(job.logPath, 0o600);
  }

  async logEvent(eventKey: string, message: string): Promise<void> {
    const job = this.#store.get(this.#jobId);
    if (!job?.logPath) return;
    const marker = `CURSOR_RUN_EVENT:${eventKey}`;
    let existing = "";
    try {
      existing = await readFile(job.logPath, { encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing.split("\n").some((line) => line.includes(marker))) return;
    await appendFile(
      job.logPath,
      `[${new Date().toISOString()}] ${marker} ${redactSensitiveText(message)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(job.logPath, 0o600);
  }
}
