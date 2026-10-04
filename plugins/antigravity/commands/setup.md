---
description: Check whether the local Antigravity CLI (agy) and Google auth are ready
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup $ARGUMENTS
```

Output rules:
- Present the setup output to the user.
- If Antigravity is installed but not authenticated, remind the user to run `agy` in their terminal to log in.
