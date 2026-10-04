---
name: task-handoff
description: Use when pausing, completing, transferring or recovering an in-progress task across agents or sessions.
---

# Task handoff

## Procedure

1. Update `TASK.md` current state, decisions, verification and delivery.
2. Append one factual `JOURNAL.md` entry.
3. Rewrite `HANDOFF.md` with branch/base/head, active tools/skills, exact
   uncommitted state, evidence, failed approaches, risks and one next command.
4. Run `python scripts/validate_agent_state.py`.
5. Perform a cold-start test: another agent must continue without chat history.

## Verification

- Next command and expected output are explicit.
- Last verified commit is not confused with current HEAD.
