---
description: Cancel an active Antigravity background task and terminate its process tree
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel "$ARGUMENTS"`

Return the command output above to the user verbatim, without commentary.
