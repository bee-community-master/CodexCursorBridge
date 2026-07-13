# Cursor Bridge TDD evidence

## Source and journeys

The source was the approved implementation plan in the Codex task. It was normalized into these journeys:

1. A planner can approve a versioned Task whose hash cannot silently drift.
2. The main Codex agent can start and monitor only that approved Task through four narrow MCP tools without waiting for Cursor to finish.
3. Cursor changes stay in an isolated worktree and cannot publish outside the approved scope.
4. Passing Cursor prose is insufficient; Bridge verification must pass before commit, push, or draft PR.
5. Another Mac can clone the repository and bootstrap the same direct main-agent MCP registration without copying secrets or absolute paths.

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

## Guarantees

| # | Guarantee | Test or command | Type | Result |
|---|---|---|---|---|
| 1 | Task approval persists a stable SHA-256 spec hash and rejects stale versions/hashes. | `tests/task.test.ts` | Unit | PASS |
| 2 | Traversal, forbidden paths, out-of-scope paths, oversized diffs, and deleted tests block publication. | `tests/paths.test.ts`, `tests/verification.test.ts` | Unit | PASS |
| 3 | SQLite jobs deduplicate identical specs and enforce legal state transitions. | `tests/state.test.ts` | Integration | PASS |
| 4 | Tracked edits, deletions, and untracked files are all included in independent verification. | `tests/git.test.ts` | Integration | PASS |
| 5 | Publication occurs only after Bridge verification; scope violations preserve the worktree. | `tests/workflow.test.ts` | Integration with fake adapter | PASS |
| 6 | New and existing-PR worktree bases use collision-resistant or verified same-repository branches. | `tests/real-adapter.test.ts` | Integration with fake Git/GitHub | PASS |
| 7 | Bootstrap exposes exactly four MCP tools to the main Codex agent, preserves existing config across clone paths, migrates the managed legacy role, and refuses to overwrite an unmanaged registration. | `tests/bootstrap.test.ts`, `tests/managed-config.test.ts` | Integration | PASS |
| 8 | The built MCP server initializes and lists exactly start/status/cancel/report. | `pnpm smoke:mcp` | Protocol smoke | PASS |
| 9 | Plugin and delegation skill match Codex schemas and direct asynchronous delegation guidance. | `tests/plugin.test.ts`, plugin validator, skill quick validator | Packaging | PASS |
| 10 | No known dependency advisories remain. | `pnpm audit` | Security | PASS |

## Final verification

- `pnpm verify`: PASS — lint, typecheck, 30 tests, coverage, build, MCP smoke.
- `pnpm smoke:cursor`: PASS — selected `grok-4.5`, local sandbox enabled, disposable repository remained clean.
- Clean-clone install simulation: PASS — pnpm publicly hoisted only the Cursor platform helper so SDK sandbox discovery works across clone paths.
- Direct main-agent registration: PASS — live `~/.codex/config.toml` contains the managed MCP block with exactly four tools, and the obsolete managed custom-agent file was removed.
- Fresh Codex process direct-tool smoke: PASS — the main agent called `cursor_bridge.cursor_get_task` itself; the deliberately invalid non-UUID job ID reached Bridge schema validation and was rejected as expected.
- Coverage: statements 95.48%, branches 85.85%, functions 100%, lines 99.08% for the core policy modules.
- `codex --strict-config doctor` against a temporary `CODEX_HOME`: config parse PASS; auth intentionally absent in the temporary home.
- Repo-local marketplace and `cursor-bridge@coding-agent` install in a temporary `CODEX_HOME`: PASS.
- Plugin validator and skill quick validator: PASS.
- `codex --strict-config doctor`: configuration and MCP inventory PASS; the non-interactive `TERM=dumb` diagnostic remains unrelated.

## Known gaps

- The repository has no remote, so its own push/draft-PR smoke and draft PR creation remain unavailable until a remote is configured.
- v1 credential installation targets macOS Keychain; Linux and Windows backends are intentionally out of scope.
