---
description: Show status and progress of active and recent Antigravity tasks
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status "$ARGUMENTS"`

Return the command output above to the user verbatim, without commentary.
