import { Agent, Cursor, type Run } from "@cursor/sdk";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import type { MachineConfig, RepositoryConfig, RuntimePaths } from "./config.js";
import { chooseConfiguredGrok } from "./model.js";
import { collectChanges, git, runFile } from "./git.js";
import { readCursorApiKey } from "./keychain.js";
import type { JobStore } from "./state.js";
import type { Task } from "./task.js";
import type {
  CursorExecution, PreparedWorktree, VerificationResult, WorkflowAdapter, WorkflowReportData,
} from "./workflow.js";

let activeRun: Run | undefined;
export async function cancelActiveCursorRun(): Promise<void> {
  if (activeRun) await activeRun.cancel();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function tail(value: string, limit = 4000): string {
  return value.length <= limit ? value : value.slice(-limit);
}

function redact(value: string): string {
  return value
    .replace(/\b(?:sk|gh[opusr])[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/((?:api[_ -]?key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function eventSummary(event: { type: string; name?: string; status?: string }): string {
  return [event.type, event.name, event.status].filter(Boolean).join(" ");
}

interface PullRequestInfo {
  state: string;
  headRefName: string;
  headRepository: { nameWithOwner: string };
  url: string;
}

export class RealWorkflowAdapter implements WorkflowAdapter {
  readonly #paths: RuntimePaths;
  readonly #config: MachineConfig;
  readonly #store: JobStore;
  readonly #jobId: string;

  constructor(paths: RuntimePaths, config: MachineConfig, store: JobStore, jobId: string) {
    this.#paths = paths;
    this.#config = config;
    this.#store = store;
    this.#jobId = jobId;
  }

  async #log(message: string): Promise<void> {
    const job = this.#store.get(this.#jobId);
    if (job?.logPath) await appendFile(job.logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  }

  async prepare(job: { id: string }, task: Task, repository: RepositoryConfig): Promise<PreparedWorktree> {
    const worktree = path.join(this.#paths.worktreesDir, task.repository, job.id);
    await mkdir(path.dirname(worktree), { recursive: true });
    await git(repository.root, "fetch", "--prune", "origin");

    let startRef = `origin/${repository.defaultBranch}`;
    let pushBranch = `codex/cursor/${task.id.toLowerCase()}-${slug(task.title)}-v${task.spec_version}-${job.id.slice(0, 8)}`;
    if (task.pull_request.mode === "existing_pr") {
      const output = await runFile("gh", [
        "pr", "view", String(task.pull_request.number), "--repo", repository.origin,
        "--json", "state,headRefName,headRepository,url",
      ]);
      const info = JSON.parse(output.stdout) as PullRequestInfo;
      if (info.state !== "OPEN") throw new Error(`Existing PR is not open: #${task.pull_request.number}`);
      if (info.headRepository.nameWithOwner !== repository.origin) throw new Error("Existing PR head is in a fork and cannot be updated safely");
      pushBranch = info.headRefName;
      startRef = `origin/${pushBranch}`;
    }
    const localBranch = task.pull_request.mode === "new_draft"
      ? pushBranch
      : `codex/cursor/${task.id.toLowerCase()}-followup-${job.id.slice(0, 8)}`;
    await git(repository.root, "worktree", "add", "-b", localBranch, worktree, startRef);
    const baseSha = await git(worktree, "rev-parse", "HEAD");
    await this.#log(`Prepared worktree ${worktree} from ${startRef}`);
    return { worktree, baseSha, pushBranch, localBranch };
  }

  async runCursor(prepared: PreparedWorktree, task: Task): Promise<CursorExecution> {
    const apiKey = await readCursorApiKey();
    const selected = chooseConfiguredGrok(await Cursor.models.list({ apiKey }), this.#config.cursorModelId);
    const agent = await Agent.create({
      apiKey,
      name: `codex-delegated:${task.id}`,
      model: { id: selected.id },
      mode: "agent",
      local: {
        cwd: prepared.worktree,
        settingSources: ["project"],
        sandboxOptions: { enabled: true },
        autoReview: true,
      },
    });
    try {
      const run = await agent.send([
        "Read AGENTS.md and project rules before editing.",
        "Implement exactly the approved task packet below.",
        "Do not weaken acceptance criteria, widen scope, delete tests, add unapproved dependencies, or access production.",
        "Reproduce bugs first, add regression tests, run every verification command, and stop on any stop condition.",
        "Do not commit or push; the bridge verifies and publishes independently.",
        "--- APPROVED TASK ---",
        stringify(task, { lineWidth: 100 }),
        "--- END TASK ---",
      ].join("\n\n"));
      activeRun = run;
      this.#store.update(this.#jobId, { cursorAgentId: agent.agentId, cursorRunId: run.id });
      for await (const event of run.stream()) await this.#log(eventSummary(event));
      const result = await run.wait();
      if (result.status !== "finished") throw new Error(result.error?.message ?? `Cursor run ended with ${result.status}`);
      return { agentId: agent.agentId, runId: run.id, summary: redact(result.result ?? "") };
    } finally {
      activeRun = undefined;
      await agent[Symbol.asyncDispose]();
    }
  }

  async collectChanges(prepared: PreparedWorktree): Promise<Awaited<ReturnType<typeof collectChanges>>> {
    return collectChanges(prepared.worktree, prepared.baseSha);
  }

  async runVerification(prepared: PreparedWorktree, task: Task): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const item of task.verification.commands) {
      const started = Date.now();
      try {
        await runFile(item.command, item.args, {
          cwd: prepared.worktree,
          env: { ...process.env, ...item.env },
          timeoutMs: item.timeout_seconds * 1000,
        });
        await this.#log(`Verification passed: ${item.command} ${item.args.join(" ")}`);
        results.push({ command: [item.command, ...item.args].join(" "), status: "passed", durationMs: Date.now() - started });
      } catch (error) {
        const output = redact(tail(error instanceof Error ? error.message : String(error)));
        await this.#log(`Verification failed: ${item.command} ${item.args.join(" ")}`);
        results.push({ command: [item.command, ...item.args].join(" "), status: "failed", durationMs: Date.now() - started, output });
        break;
      }
    }
    return results;
  }

  async publish(
    prepared: PreparedWorktree,
    task: Task,
    repository: RepositoryConfig,
    reportData: WorkflowReportData,
  ): Promise<{ prUrl: string }> {
    if ((await git(prepared.worktree, "status", "--porcelain")) === "") throw new Error("Cursor produced no changes");
    await git(prepared.worktree, "add", "-A");
    await git(prepared.worktree, "commit", "-m", `chore(cursor): ${task.title}`);
    await git(prepared.worktree, "push", "origin", `HEAD:${prepared.pushBranch}`);
    if (task.pull_request.mode === "existing_pr") {
      const result = await runFile("gh", ["pr", "view", String(task.pull_request.number), "--repo", repository.origin, "--json", "url", "--jq", ".url"]);
      return { prUrl: result.stdout.trim() };
    }
    const body = [
      `Automated implementation of ${task.id}.`, "", "## Acceptance criteria",
      ...task.acceptance_criteria.map((item) => `- ${item}`), "", "## Verification",
      ...(reportData.verification ?? []).map((item) => `- ${item.status === "passed" ? "PASS" : "FAIL"}: \`${item.command}\``),
      "", "Generated by Codex Cursor Bridge. Review is required before marking ready.",
    ].join("\n");
    const result = await runFile("gh", [
      "pr", "create", "--draft", "--repo", repository.origin, "--base", repository.defaultBranch,
      "--head", prepared.pushBranch, "--title", task.title, "--body", body,
    ]);
    return { prUrl: result.stdout.trim() };
  }

  async writeReport(data: WorkflowReportData): Promise<string> {
    await mkdir(this.#paths.reportsDir, { recursive: true, mode: 0o700 });
    const reportPath = path.join(this.#paths.reportsDir, `${data.job.id}.md`);
    const lines = [
      `# ${data.task.id} Cursor execution report`, "", `- Status: ${data.job.status}`,
      `- Repository: ${data.task.repository}`, `- Spec: v${data.task.spec_version} ${data.task.spec_hash ?? ""}`,
      ...(data.job.prUrl ? [`- PR: ${data.job.prUrl}`] : []), "", "## Cursor summary", "", data.cursorSummary || "No summary.",
      "", "## Changed files", "", ...(data.changes?.files.map((file) => `- ${file}`) ?? ["- Not collected"]),
      "", "## Verification", "",
      ...(data.verification?.map((result) => `- ${result.status.toUpperCase()}: \`${result.command}\` (${result.durationMs}ms)`) ?? ["- Not run"]),
      ...(data.assessment && !data.assessment.ok ? ["", "## Scope violations", "", ...data.assessment.reasons.map((reason) => `- ${reason}`)] : []),
      ...(data.error ? ["", "## Error", "", data.error] : []), "",
    ];
    await writeFile(reportPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
    return reportPath;
  }

  async cleanup(prepared: PreparedWorktree, repository: RepositoryConfig): Promise<void> {
    await git(repository.root, "worktree", "remove", prepared.worktree);
    await git(repository.root, "branch", "-D", prepared.localBranch);
  }
}
