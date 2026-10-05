---
description: Delegate investigation, fix, or autonomous implementation to Google Antigravity (Gemini)
argument-hint: '[--background|--wait] [--write] [--model <gemini-model>] [--effort low|medium|high] [--prompt-file <path>] [--resume-last] [--wait-for-quota <15m>] [--dry-run] [what Antigravity should do]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the raw user request as the prompt.
`agy:agy-rescue` is a subagent, not a skill — do not call `Skill(...)`.

Raw user request:
$ARGUMENTS

Execution rules:
- If `$ARGUMENTS` contains `--background`, run in the background.
- If `$ARGUMENTS` contains `--write`, pass `--write` to allow Antigravity to modify files.
- Forward `--model`, `--effort`, `--prompt-file`, `--resume-last`, `--wait-for-quota` and `--dry-run` (with their values) to the subagent unchanged.
- If Antigravity reports `Antigravity Gemini quota exhausted`, return that message verbatim (it includes the reset time); do not retry.
- `--wait` (or no mode flag) means a foreground run.
- Return the Antigravity output verbatim to the user without commentary.
