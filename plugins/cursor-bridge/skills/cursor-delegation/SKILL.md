---
name: cursor-delegation
description: Create, approve, dispatch, monitor, cancel, and review coding tasks delegated from Codex to Cursor Bridge. Use when the user asks CURSOR to implement an approved task or asks about a Cursor Bridge job.
---

# Cursor Delegation

Use the `CURSOR` custom agent only after the user has approved a committed Task packet.

## Task authoring

1. Register the target repository once with `pnpm repo:add -- --alias <alias> --path <absolute-path>`.
2. Copy `examples/TASK-template.yaml` to `tasks/<alias>/TASK-<ID>.yaml`.
3. Fill every acceptance, scope, verification, stop, limit, and PR-mode field. Never place secrets in a Task.
4. Keep `status: draft` while discussing it.
5. Run `pnpm task:approve -- --repository <alias> --task TASK-<ID>` only after explicit approval.
6. Commit the approved Task before dispatch.

## Dispatch

Spawn the `cursor` role with only the repository alias, Task ID, spec version, and spec hash. The role must call `cursor_start_task` exactly once and return the job ID. Do not pass conversation history, a free-form prompt, shell commands, or repository paths through MCP.

Use `cursor_get_task` to monitor, `cursor_cancel_task` only on explicit cancellation, and `cursor_get_report` after a terminal state. Completion requires Bridge verification and a PR URL, not Cursor's final prose.

## Stop conditions

- Do not dispatch a draft, dirty, untracked, stale, or hash-mismatched Task.
- Do not alter a Task while its job is active.
- Treat `BLOCKED`, `FAILED`, `STALE_SPEC`, and `SCOPE_VIOLATION` as human-review states; do not auto-retry.
- Review the resulting draft PR, changed paths, verification evidence, and test integrity before marking it ready.
