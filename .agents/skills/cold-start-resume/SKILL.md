---
name: cold-start-resume
description: Use when starting or resuming work in a repository with unknown or potentially stale agent context.
---

# Cold-start resume

## Inputs

- Repository root.
- Current user request.
- Git, task-state and CI/PR state when available.

## Procedure

1. Run `python scripts/agent_context.py --ensure --write-local --write-cache`.
2. Read `AGENTS.md`, bootstrap, `CURRENT.md`, active `TASK.md` and `HANDOFF.md`.
3. Reconcile documents with git status/log/diff, worktrees, PR and CI.
4. Continue an existing matching task; otherwise create one with
   `scripts/new_task.py`.
5. Record assumptions and one exact next action before editing code.

## Verification

- Active task, branch, last verified commit and next command are unambiguous.
- Unknown work is preserved.
