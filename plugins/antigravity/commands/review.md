---
description: Run an Antigravity code review in an isolated shadow worktree against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--wait-for-quota <15m>] [focus]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an Antigravity review through the companion script.

Raw arguments:
`$ARGUMENTS`

Core constraints:
- This command is review-only.
- Do not fix issues or modify files.
- Return Antigravity's review output verbatim.

Execution mode rules:
- If `$ARGUMENTS` includes `--wait`, run in foreground.
- If `$ARGUMENTS` includes `--background`, run in background.
- Otherwise, ask the user with `AskUserQuestion`:
  - `Wait for results (Recommended)`
  - `Run in background`

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review $ARGUMENTS
```
Return the output verbatim to the user.

Background flow:
Launch with `run_in_background: true`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review $ARGUMENTS
```
Tell the user: "Antigravity review started in the background. Check `/agy:status` for progress."
