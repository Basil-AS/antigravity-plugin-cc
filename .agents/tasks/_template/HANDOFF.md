# Handoff

TASK_ID: {{TASK_ID}}
STATUS: wip
BRANCH: {{BRANCH}}
BASE_COMMIT: {{BASE_COMMIT}}
HEAD: {{BASE_COMMIT}}
LAST_VERIFIED_COMMIT: -
PR: -
PROFILE: balanced
ACTIVE_SKILLS: -
TOOLS_USED: scripts/new_task.py
UPDATED_AT: {{UPDATED_AT}}

## Read first

1. `AGENTS.md`
2. `.agents/reference/UNIVERSAL_AGENT_BOOTSTRAP.md`
3. This task's `TASK.md`
4. This task's `JOURNAL.md`
5. Relevant git diff, tests and PR/CI

## Done

- Task state initialized.

## Current work

- Request still needs project-specific analysis.

## Uncommitted or running state

- Unknown: inspect `git status` and running processes.

## Verification evidence

- None yet.

## Failed approaches

- None.

## Risks and blockers

- Project context and verification commands may still be unknown.

## Exact next action

COMMAND: `python scripts/agent_context.py --ensure --write-local --write-cache`
EXPECTED: A current repository snapshot, tool capability report and active-task
context without modifying project code.

## Completion path

Implement → targeted verification → full relevant verification → diff review →
update task/journal/handoff → PR or documented local fallback.
