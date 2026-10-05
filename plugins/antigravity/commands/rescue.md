---
description: Delegate investigation, fix, or autonomous implementation to Google Antigravity (Gemini)
argument-hint: '[--background|--wait] [--write] [--model <gemini-model>] [what Antigravity should do]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the raw user request as the prompt.
`agy:agy-rescue` is a subagent, not a skill — do not call `Skill(...)`.

Raw user request:
$ARGUMENTS

Execution rules:
- If `$ARGUMENTS` contains `--background`, run in the background.
- If `$ARGUMENTS` contains `--write`, pass `--write` to allow Antigravity to modify files.
- Return the Antigravity output verbatim to the user without commentary.
