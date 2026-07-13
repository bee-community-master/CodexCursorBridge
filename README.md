# Codex Cursor Bridge

Codex plans and approves a versioned Task; the isolated `CURSOR` role delegates it to Cursor in a dedicated Git worktree. The Bridge independently checks scope and verification before pushing to an existing PR or creating a draft PR.

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 22.13 or newer, pnpm 11.10.0
- Codex CLI/app and Cursor account with an API key
- Git and authenticated GitHub CLI

## Install on each Mac

```bash
git clone <repository-url> codingAgent
cd codingAgent
pnpm install --frozen-lockfile
pnpm bootstrap
```

`pnpm bootstrap` builds the bridge, stores the Cursor API key in macOS Keychain, asks you to choose an exact available Grok model, installs the repo-local `cursor-bridge` plugin, and registers `~/.codex/agents/cursor.toml`. Restart Codex and start a new task afterward.

Machine-local repository paths and model choice live in `~/.config/codex-cursor-bridge/config.json`; jobs, reports, and logs remain beside it. They are never committed.

## Register a target repository

```bash
pnpm repo:add -- --alias my-service --path /absolute/path/to/my-service
```

The command requires a GitHub `origin` and records its actual default branch.

## Author and approve a Task

```bash
mkdir -p tasks/my-service
cp examples/TASK-template.yaml tasks/my-service/TASK-001.yaml
# Edit while status is draft, then obtain explicit user approval.
pnpm task:approve -- --repository my-service --task TASK-001
git add tasks/my-service/TASK-001.yaml
git commit -m "docs: approve TASK-001"
```

Ask Codex to delegate the alias, Task ID, spec version, and printed hash to the `CURSOR` role. The role exposes only start/status/cancel/report MCP tools.

## Update or uninstall

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm bootstrap

pnpm uninstall
# Also delete the Keychain item:
pnpm uninstall -- --delete-key
```

Bootstrap is idempotent and backs up `~/.codex/config.toml` before replacing its marked `[agents.cursor]` block. Uninstall preserves job history and registered repository data.

## Development verification

```bash
pnpm verify
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/cursor-bridge
```

After bootstrap, verify the selected Grok model, Cursor authentication, local sandbox, and a clean
disposable Git run with:

```bash
pnpm smoke:cursor
```

The smoke creates and removes a temporary local repository. It neither pushes nor creates a PR.

Because this repository currently has no remote, its own draft PR cannot be created until a remote is configured.
