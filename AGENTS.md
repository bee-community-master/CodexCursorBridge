# Cursor Bridge Development Contract

- Use Node.js 22.13 or newer and pnpm 11.10.0.
- Keep MCP inputs narrow; never add arbitrary prompt, shell, or repository-path parameters.
- Keep secrets in macOS Keychain and machine-specific paths under `~/.config/codex-cursor-bridge`.
- Write tests before changing task, state, verification, workflow, bootstrap, or MCP behavior.
- Run `pnpm verify` and the plugin validator before committing.
- Do not weaken scope, hash, worktree, verification, or draft-PR gates to make a test pass.
