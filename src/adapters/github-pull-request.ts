import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PreparedWorktree,
  PublicationInput,
  PublicationStatePort,
} from "../application/workflow-ports.js";
import type { RepositoryConfig } from "../domain/configuration.js";
import type { Attempt } from "../domain/job.js";
import type { ApprovedTask } from "../domain/task.js";
import { safeErrorMessage } from "../application/redaction.js";
import { runFile } from "./command-runner.js";
import type { PreparedWorktreeGuard } from "./prepared-worktree-guard.js";
import type { WorkflowLogger } from "./workflow-logger.js";

type PullRequestEffectPort = Pick<
  PublicationStatePort,
  "beginEffect" | "completeEffect"
>;

export interface PullRequestInfo {
  state: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string;
  headRepository: { nameWithOwner: string };
  url: string;
  isDraft?: boolean;
}

interface PublishedPullRequestInfo {
  url: string;
  isDraft: boolean;
  headRefOid: string;
}

function draftPullRequestBody(
  task: ApprovedTask,
  input: PublicationInput,
): string {
  return [
    `승인된 작업 \`${task.id}\`의 자동 구현 결과입니다.`,
    "",
    "## 인수 조건",
    ...task.acceptance_criteria.map((item) => `- ${item}`),
    "",
    "## 독립 검증",
    ...input.verification.map((item) =>
      `- ${item.status === "passed" ? "PASS" : "FAIL"}: \`${item.command}\``),
    "",
    `- 후보 트리: \`${input.tree.treeHash}\``,
    `- 패치 증명: \`${input.tree.patchHash}\``,
    "",
    "Codex Cursor Bridge가 생성했습니다. 리뷰 완료 전까지 Draft 상태를 유지해야 합니다.",
  ].join("\n");
}

export class GitHubPullRequestAdapter {
  readonly #store: PullRequestEffectPort;
  readonly #jobId: string;
  readonly #guard: PreparedWorktreeGuard;
  readonly #logger: WorkflowLogger;

  constructor(
    store: PullRequestEffectPort,
    jobId: string,
    guard: PreparedWorktreeGuard,
    logger: WorkflowLogger,
  ) {
    this.#store = store;
    this.#jobId = jobId;
    this.#guard = guard;
    this.#logger = logger;
  }

  async readExisting(
    task: ApprovedTask,
    repository: RepositoryConfig,
  ): Promise<PullRequestInfo | undefined> {
    if (task.pull_request.mode !== "existing_pr") return undefined;
    const output = await runFile("gh", [
      "pr",
      "view",
      String(task.pull_request.number),
      "--repo",
      repository.origin,
      "--json",
      "state,baseRefName,headRefName,headRefOid,headRepository,url,isDraft",
    ]);
    const info = JSON.parse(output.stdout) as PullRequestInfo;
    if (info.state !== "OPEN") {
      throw new Error(`Existing PR is not open: #${task.pull_request.number}`);
    }
    if (info.headRepository.nameWithOwner !== repository.origin) {
      throw new Error("Existing PR head is in a fork and cannot be updated safely");
    }
    if (!info.isDraft) throw new Error("Existing pull request must remain a draft");
    if (info.headRefName !== task.target.base_ref) {
      throw new Error("STALE_SPEC: existing PR head branch changed after task approval");
    }
    if (info.baseRefName !== task.target.destination_ref) {
      throw new Error("STALE_SPEC: existing PR destination branch changed after task approval");
    }
    return info;
  }

  async ensure(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    repository: RepositoryConfig,
    input: PublicationInput,
    attempt: Attempt,
  ): Promise<PublishedPullRequestInfo> {
    this.#guard.assertPublicationLease(attempt);
    const key = `pull_request:${this.#jobId}:${prepared.pushBranch}`;
    const effect = this.#store.beginEffect(this.#jobId, attempt.id, "pull_request", key);
    let prUrl: string;
    if (task.pull_request.mode === "existing_pr") {
      const existing = await this.readExisting(task, repository);
      if (!existing) throw new Error("Existing pull request disappeared");
      prUrl = existing.url;
    } else {
      prUrl = await this.#findOrCreateDraft(prepared, task, repository, input);
    }

    const readback = await runFile("gh", [
      "pr",
      "view",
      prUrl,
      "--repo",
      repository.origin,
      "--json",
      "state,url,isDraft,baseRefName,headRefName,headRefOid,headRepository",
    ]);
    const info = JSON.parse(readback.stdout) as PublishedPullRequestInfo & {
      state: string;
      baseRefName: string;
      headRefName: string;
      headRepository: { nameWithOwner: string };
    };
    if (info.state !== "OPEN") throw new Error("Pull request is no longer open");
    if (
      info.headRefName !== prepared.pushBranch
      || info.headRepository.nameWithOwner !== repository.origin
    ) {
      throw new Error("Pull request readback does not match the published head branch");
    }
    if (info.baseRefName !== task.target.destination_ref) {
      throw new Error("Pull request readback does not match the approved base branch");
    }
    if (effect.status !== "COMPLETED") {
      this.#store.completeEffect(effect.id, {
        url: info.url,
        isDraft: info.isDraft,
        headRefOid: info.headRefOid,
      });
    }
    return info;
  }

  async #findOrCreateDraft(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    repository: RepositoryConfig,
    input: PublicationInput,
  ): Promise<string> {
    const open = await this.#findOpenPullRequest(
      prepared.pushBranch,
      repository,
    );
    if (open) return open;

    try {
      return await this.#createDraft(prepared, task, repository, input);
    } catch (error) {
      const reconciled = await this.#findOpenPullRequest(
        prepared.pushBranch,
        repository,
      );
      if (!reconciled) {
        throw new Error(
          `Draft pull request creation failed and no matching PR was found: ${safeErrorMessage(error)}`,
        );
      }
      await this.#logger.log(
        "Draft PR creation reported an error, but exact branch lookup found the created PR.",
      );
      return reconciled;
    }
  }

  async #findOpenPullRequest(
    headBranch: string,
    repository: RepositoryConfig,
  ): Promise<string | undefined> {
    const listed = await runFile("gh", [
      "pr",
      "list",
      "--repo",
      repository.origin,
      "--state",
      "open",
      "--head",
      headBranch,
      "--json",
      "url",
    ]);
    const open = JSON.parse(listed.stdout) as Array<{ url: string }>;
    return open[0]?.url;
  }

  async #createDraft(
    prepared: PreparedWorktree,
    task: ApprovedTask,
    repository: RepositoryConfig,
    input: PublicationInput,
  ): Promise<string> {
    const bodyDirectory = await mkdtemp(path.join(os.tmpdir(), "cursor-bridge-pr-"));
    const bodyFile = path.join(bodyDirectory, "body.md");
    try {
      await writeFile(
        bodyFile,
        draftPullRequestBody(task, input),
        { encoding: "utf8", mode: 0o600 },
      );
      const created = await runFile("gh", [
        "pr",
        "create",
        "--draft",
        "--repo",
        repository.origin,
        "--base",
        task.target.destination_ref,
        "--head",
        prepared.pushBranch,
        "--title",
        task.title,
        "--body-file",
        bodyFile,
      ]);
      return created.stdout.trim();
    } finally {
      await rm(bodyDirectory, { recursive: true, force: true });
    }
  }
}
