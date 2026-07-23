import { describe, expect, it } from "vitest";
import {
  attemptStatuses,
  canTransitionAttempt,
  terminalAttemptStatuses,
} from "../src/domain/job.js";

describe("job domain", () => {
  it("derives terminal attempt statuses from the transition model", () => {
    const statusesWithoutOutgoingTransitions = attemptStatuses.filter((status) =>
      attemptStatuses.every((candidate) =>
        candidate === status || !canTransitionAttempt(status, candidate)));

    expect([...terminalAttemptStatuses]).toEqual(statusesWithoutOutgoingTransitions);
  });
});
