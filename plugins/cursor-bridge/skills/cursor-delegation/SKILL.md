---
name: cursor-delegation
description: Create, approve, dispatch, monitor, cancel, and review asynchronous coding tasks delegated directly from the main Codex agent to Cursor Bridge.
---

# Cursor Delegation

The main Codex agent calls the narrow Cursor Bridge MCP tools directly. A launchd-managed durable supervisor claims the SQLite-backed job with a lease, so starting a job does not occupy the Codex task and a crashed process can be recovered safely.

## Task authoring

1. Register the target repository once with `pnpm repo:add -- --alias <alias> --path <absolute-path>`. The path must be a standalone clone: linked worktrees are rejected because `.git` must be a directory and `git-dir` must equal `git-common-dir`.
2. Copy `examples/TASK-template.yaml` to `tasks/<alias>/TASK-<ID>.yaml`.
3. Fill every acceptance, scope, verification, stop, limit, and PR-mode field. Never place secrets in a Task.
4. Keep `status: draft` while discussing it.
5. Run `pnpm task:approve -- --repository <alias> --task TASK-<ID>` only after explicit approval. Approval binds the target origin, base SHA, PR destination branch, context digest, policy version, and verification profile.
6. Commit the approved Task before dispatch.

## Dispatch

Call `cursor_start_task` directly with only the repository alias, Task ID, spec version, and spec hash. Normally call it once for an approved spec. It returns a job ID without waiting for Cursor to finish. If the response preserves a job ID but explicitly warns that the supervisor wake failed, retry only the same approved identity once. Report the job ID and initial status to the user; do not continuously poll unless the user asks to wait or check progress.

Do not pass conversation history, a free-form prompt, shell commands, or repository paths through MCP. The committed and hash-locked Task packet is the only implementation contract.

Use `cursor_get_task` for an explicit status check, `cursor_cancel_task` only on explicit cancellation, and `cursor_get_report` after a terminal state. Cancellation is confirmed asynchronously; `CANCEL_REQUESTED` is not yet `CANCELLED`. Once a job reaches `PUBLISHING`, publication is the point of no return: do not claim it was cancelled, and let the Bridge finish remote readback and delivery reconciliation.

Successful delivery is `DELIVERED_REVIEW_REQUIRED` with a Draft PR, final tree hash, independent verification, and an attestation artifact. Existing PR mode also accepts only an open Draft PR in the registered repository. Delivery is ready for Codex/human review, not automatically ready to merge.

Independent verification runs package-manager commands with the exact `packageManager` version declared by the candidate repository. Before dispatch, provision that exact version in the host Corepack cache (for example, with an explicit `corepack pack pnpm@<version>` operation). The verifier only stages that manager into a private read-only Corepack cache outside the writable scratch root, then executes its fixed entrypoint through the verifier's Node runtime (with a staged PATH shim for child invocations). It fails closed when the artifact is absent or its content digest changes, keeps network access denied for the sandboxed command, rejects `COREPACK_*` task overrides and package-manager switching arguments, and records the actual command/argv, manager version, Corepack integrity, artifact digest, cache source, and network policy in the report and attestation.

## Stop conditions

- Do not dispatch a draft, dirty, untracked, stale, or hash-mismatched Task.
- Do not alter a Task while its job is active.
- Treat `BLOCKED`, `FAILED`, `STALE_SPEC`, and `SCOPE_VIOLATION` as human-review states; do not auto-retry.
- Review the resulting draft PR, changed paths, verification evidence, attestation, and test integrity before marking it ready.
