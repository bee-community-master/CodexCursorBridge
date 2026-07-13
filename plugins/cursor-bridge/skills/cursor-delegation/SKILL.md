---
name: cursor-delegation
description: Create, approve, dispatch, monitor, cancel, and review asynchronous coding tasks delegated directly from the main Codex agent to Cursor Bridge.
---

# Cursor Delegation

The main Codex agent calls the narrow Cursor Bridge MCP tools directly. The bridge runs Cursor in a detached worker, so starting a job does not occupy the Codex task until implementation finishes.

## Task authoring

1. Register the target repository once with `pnpm repo:add -- --alias <alias> --path <absolute-path>`.
2. Copy `examples/TASK-template.yaml` to `tasks/<alias>/TASK-<ID>.yaml`.
3. Fill every acceptance, scope, verification, stop, limit, and PR-mode field. Never place secrets in a Task.
4. Keep `status: draft` while discussing it.
5. Run `pnpm task:approve -- --repository <alias> --task TASK-<ID>` only after explicit approval.
6. Commit the approved Task before dispatch.

## Dispatch

Call `cursor_start_task` directly with only the repository alias, Task ID, spec version, and spec hash. Call it exactly once for an approved spec. It returns a job ID without waiting for Cursor to finish. Report that job ID and the initial status to the user; do not continuously poll unless the user asks to wait or check progress.

Do not pass conversation history, a free-form prompt, shell commands, or repository paths through MCP. The committed and hash-locked Task packet is the only implementation contract.

Use `cursor_get_task` for an explicit status check, `cursor_cancel_task` only on explicit cancellation, and `cursor_get_report` after a terminal state. Completion requires Bridge verification and a PR URL, not Cursor's final prose.

## Stop conditions

- Do not dispatch a draft, dirty, untracked, stale, or hash-mismatched Task.
- Do not alter a Task while its job is active.
- Treat `BLOCKED`, `FAILED`, `STALE_SPEC`, and `SCOPE_VIOLATION` as human-review states; do not auto-retry.
- Review the resulting draft PR, changed paths, verification evidence, and test integrity before marking it ready.
