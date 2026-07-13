import { Agent, Cursor } from "@cursor/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMachineConfig, runtimePaths } from "./config.js";
import { git } from "./git.js";
import { readCursorApiKey } from "./keychain.js";
import { assertCleanSuccessfulSmoke } from "./live-smoke.js";
import { chooseConfiguredGrok } from "./model.js";

const paths = runtimePaths();
const repository = await mkdtemp(path.join(os.tmpdir(), "cursor-bridge-live-smoke-"));

try {
  await git(repository, "init", "-b", "main");
  await writeFile(path.join(repository, "README.md"), "# Disposable Cursor smoke repository\n", "utf8");
  await git(repository, "add", "README.md");
  await git(repository, "-c", "user.name=Cursor Bridge Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "test: initialize disposable repository");

  const apiKey = await readCursorApiKey();
  const config = await loadMachineConfig(paths.configFile);
  const model = chooseConfiguredGrok(await Cursor.models.list({ apiKey }), config.cursorModelId);
  const agent = await Agent.create({
    apiKey,
    name: "codex-cursor-bridge-live-smoke",
    model: { id: model.id },
    mode: "agent",
    local: {
      cwd: repository,
      settingSources: [],
      sandboxOptions: { enabled: true },
      autoReview: true,
    },
  });

  try {
    const run = await agent.send("Inspect README.md without modifying files. Reply with exactly: CURSOR_BRIDGE_SMOKE_OK");
    const result = await run.wait();
    const porcelainStatus = await git(repository, "status", "--porcelain");
    assertCleanSuccessfulSmoke(result.status, porcelainStatus);
    if (!(result.result ?? "").includes("CURSOR_BRIDGE_SMOKE_OK")) {
      throw new Error("Cursor smoke run did not return the expected marker");
    }
    process.stdout.write(`${JSON.stringify({
      status: "passed",
      model: model.id,
      agentId: agent.agentId,
      runId: run.id,
      sandbox: true,
      repositoryClean: true,
    }, null, 2)}\n`);
  } finally {
    await agent[Symbol.asyncDispose]();
  }
} finally {
  await rm(repository, { recursive: true, force: true });
}
