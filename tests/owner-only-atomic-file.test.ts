import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeOwnerOnlyAtomic } from "../src/adapters/owner-only-atomic-file.js";

describe("owner-only atomic file writes", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "cursor-bridge-atomic-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("replaces content while enforcing owner-only permissions", async () => {
    const file = path.join(directory, "managed.conf");
    await writeFile(file, "stale", { encoding: "utf8", mode: 0o644 });

    await writeOwnerOnlyAtomic(file, "current");

    expect(await readFile(file, "utf8")).toBe("current");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
