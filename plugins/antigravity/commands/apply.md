---
description: Apply the isolated changes of a finished Antigravity write task to the workspace
argument-hint: '[job-id] [--keep-worktree]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" apply "$ARGUMENTS"`

Return the command output above to the user verbatim, without commentary.
