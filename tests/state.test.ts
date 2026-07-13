import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "../src/state.js";

const stores: JobStore[] = [];

afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe("job state", () => {
  it("deduplicates the same approved task and hash", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const store = new JobStore(path.join(dir, "jobs.sqlite"));
    stores.push(store);
    const first = store.createOrGet({ repositoryAlias: "demo", taskId: "TASK-1", specVersion: 1, specHash: "sha256:a" });
    const second = store.createOrGet({ repositoryAlias: "demo", taskId: "TASK-1", specVersion: 1, specHash: "sha256:a" });
    expect(second.id).toBe(first.id);
  });

  it("enforces legal state transitions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cursor-state-"));
    const store = new JobStore(path.join(dir, "jobs.sqlite"));
    stores.push(store);
    const job = store.createOrGet({ repositoryAlias: "demo", taskId: "TASK-1", specVersion: 1, specHash: "sha256:a" });
    expect(() => store.transition(job.id, "DONE")).toThrow();
    store.transition(job.id, "RUNNING");
    store.transition(job.id, "VERIFYING");
    expect(store.get(job.id)?.status).toBe("VERIFYING");
  });
});
