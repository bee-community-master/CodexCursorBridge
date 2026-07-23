# Cursor Bridge TDD evidence

## Source and journeys

The source was the approved implementation plan in the Codex task. It was normalized into these journeys:

1. A planner can approve a versioned Task whose hash cannot silently drift.
2. The main Codex agent can start and monitor only that approved Task through four narrow MCP tools without waiting for Cursor to finish.
3. Cursor changes stay in an isolated worktree and cannot publish outside the approved scope.
4. Passing Cursor prose is insufficient; Bridge verification must pass before commit, push, or draft PR.
5. Another Mac can clone the repository and bootstrap the same direct main-agent MCP registration without copying secrets or absolute paths.
6. A supervisor crash, duplicate delivery effect, or cancellation request cannot silently create a second attempt, publish an unverified tree, or report cancellation before confirmation.

## RED/GREEN checkpoints

| Stage | Commit | Evidence |
|---|---|---|
| RED: core contracts | `bd06d6a` | `pnpm test` failed because task, path, state, model, config, and response modules did not exist. |
| GREEN: core contracts | `0a51f6c` | Six suites and 11 tests passed; `pnpm typecheck` passed. |
| RED: execution boundaries | `193f1c2` | New config, Git change collection, and scope verification suites failed on missing modules. |
| GREEN: execution boundaries | `dfe2083` | Nine suites and 16 tests passed; `pnpm typecheck` passed. |
| RED: workflow publication | `474e47d` | Workflow suite failed on missing orchestration module. |
| GREEN: workflow publication | `c21192b` | Verified publication and scope-violation preservation cases passed. |
| RED: portable CURSOR role | `a5abadb` | Bootstrap suite failed on missing role renderer. |
| GREEN: original bridge | `f262734` | Full verify, plugin validation, temporary Codex-home parse, marketplace install, MCP smoke, and sandboxed live Grok smoke passed. |
| RED: direct main MCP | `ce988ca` | Six tests failed because bootstrap still installed the custom role and had no managed main MCP block. |
| GREEN: direct main MCP | `624a016` | Main MCP registration, clone-path update, legacy-role migration, and unmanaged-registration protection passed. |
| RED: direct delegation guidance | `b10e29b` | Plugin contract test failed because the skill still instructed Codex to spawn the custom role. |
| GREEN: direct delegation guidance | Current branch | Plugin skill now starts an asynchronous job directly and avoids continuous polling. |
| RED: durable controller | Current branch | New approval binding, lease recovery, confirmed cancellation, post-verification scope, sandbox, attestation, and idempotent publication tests initially failed against the detached-worker implementation. |
| GREEN: durable controller | Current branch | SQLite schema v3, launchd supervisor, structured outcomes, bounded repair, final-tree attestation, and publication readback pass the full gate. |

## Guarantees

| # | Guarantee | Test or command | Type | Result |
|---|---|---|---|---|
| 1 | Task approval binds a locale-independent stable spec hash to target origin/base SHA, PR destination branch, context blobs, policy version, and verification profile; unknown fields and linked-file writes fail closed. | `tests/task.test.ts`, `tests/dispatch.test.ts` | Integration | PASS |
| 2 | Traversal, minimatch negation, forbidden paths, out-of-scope paths, oversized diffs, and deleted tests block publication. | `tests/paths.test.ts`, `tests/verification.test.ts` | Unit | PASS |
| 3 | SQLite jobs preserve immutable task provenance and atomically manage Job/Attempt/Event/Lease/Effect state, publication records, delivery completion, recovery, confirmed cancellation, and local effectiveness metrics. | `tests/state.test.ts` | Integration | PASS |
| 4 | Tracked edits, deletions, untracked files, symbolic links, whitespace paths, and cross-platform test naming conventions are included without following untrusted links; an approved-base index prevents assume-unchanged/skip-worktree flags or a prior Bridge commit from hiding candidate content, and byte-changing Git attribute transforms fail closed. | `tests/git.test.ts`, `tests/verification.test.ts` | Integration and unit | PASS |
| 5 | Publication occurs only after verification covers one stable immutable tree and a second scope check; bounded repair evidence survives lease reclaim without rerunning completed implementation, and stale workers cannot prepare, fail, or report for a replacement lease. | `tests/workflow.test.ts`, `tests/worker.test.ts` | Integration with fake adapter | PASS |
| 6 | Worktrees start at the approved SHA, implementer-owned commits are rejected, Git hooks/signing are disabled, exact fetch/push remotes are checked, and Draft PR results are read back against the attested tree. | `tests/real-adapter.test.ts`, `tests/git.test.ts`, `tests/dispatch.test.ts` | Integration with fake Git/GitHub | PASS |
| 7 | Bootstrap parses exact Codex plugin JSON state, exposes four MCP tools, escapes managed TOML, and installs an owner-local launchd supervisor with umask `077` and no credentials in its environment. | `tests/bootstrap-plugin.test.ts`, `tests/bootstrap.test.ts`, `tests/managed-config.test.ts`, `tests/launchd.test.ts` | Integration | PASS |
| 8 | The built MCP server initializes and lists exactly start/status/cancel/report. | `pnpm smoke:mcp` | Protocol smoke | PASS |
| 9 | Plugin and delegation skill describe durable supervisor execution, `DELIVERED_REVIEW_REQUIRED`, and attestation review. | `tests/plugin.test.ts`, plugin validator, skill quick validator | Packaging | PASS |
| 10 | No known dependency advisories remain. | `pnpm audit` | Security | PASS |
| 11 | Verifier processes reject dynamic-loader/control overrides, receive a credential-scrubbed environment and macOS sandbox profile with network denied, and cannot resolve executables through writable path aliases; persisted diagnostics are bounded, redacted, and owner-readable only. | `tests/task.test.ts`, `tests/sandbox.test.ts`, `tests/redaction.test.ts`, `tests/real-adapter.test.ts` | Unit and integration | PASS |

## Final verification

- `pnpm verify`: PASS — lint, typecheck, 165 tests, coverage, build, MCP smoke.
- Coverage: statements 86.43%, branches 80.99%, functions 96.47%, lines 89.44% for the core policy modules.
- Built supervisor runtime smoke: PASS — schema v3 DB initialized with mode `0600`, zero-job stats read back, and SIGINT shut down cleanly.
- Real macOS verifier sandbox smoke: PASS — an allowlisted worktree write succeeded while network access and reads from a non-sensitive test Keychain outside the allowlisted roots were denied.
- `pnpm smoke:cursor`: BLOCKED BEFORE SDK CALL — this Mac has no `codex-cursor-bridge/cursor-api-key` Keychain item; bootstrap/authentication remains an explicit owner action.
- Plugin validator and skill quick validator: PASS.
- `pnpm audit`: PASS — `fast-uri` and `@hono/node-server` transitive dependencies are pinned to patched versions; no known vulnerabilities remain.

## Known gaps

- A live Cursor account smoke still requires the owner to run `pnpm bootstrap` and configure the Keychain item.
- Verification runs in the candidate worktree, not a hermetic rebuilt checkout. Ignored dependency/build artifacts may affect a repository's own verification commands and must be controlled by those commands.
- A crash during post-delivery cleanup can leave `cleanupStatus: PENDING` after partial local cleanup; the Draft PR and attestation remain authoritative even if the worktree path no longer exists.
- SSH or HTTPS Git credentials must already work non-interactively from launchd; the supervisor deliberately does not inherit a shell credential environment.
- Credential installation and the launchd supervisor intentionally target personal macOS use; Linux and Windows are out of scope.
