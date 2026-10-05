---
description: Get the full final output of a completed Antigravity task or review
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result "$ARGUMENTS"`

Return the command output above to the user verbatim, without commentary.
