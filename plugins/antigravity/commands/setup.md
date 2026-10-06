---
description: Check whether the local Antigravity CLI (agy) and Google auth are ready
argument-hint: '[--enable-review-gate|--disable-review-gate] [--skip-auth-check|--enforce-auth-check]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup $ARGUMENTS
```

Output rules:
- Present the setup output to the user.
- If `agy` itself reports no login, remind the user to run `agy` in their terminal to log in.
- If the user says they are already logged in but the check still fails, suggest `/agy:setup --skip-auth-check` (persistent, also applies to subagents; undo with `--enforce-auth-check`).
