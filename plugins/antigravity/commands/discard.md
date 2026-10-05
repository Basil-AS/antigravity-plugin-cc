---
description: Discard the isolated changes of a finished Antigravity write task
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" discard "$ARGUMENTS"`

Return the command output above to the user verbatim, without commentary.
