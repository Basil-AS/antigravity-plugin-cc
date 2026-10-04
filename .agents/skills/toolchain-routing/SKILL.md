---
name: toolchain-routing
description: Use when deciding whether RTK, Superpowers, Gortex, Ponytail or Caveman should be activated for the current task.
---

# Toolchain routing

## Procedure

1. Classify task: design, implementation, debug, review, research, operations.
2. Select one primary process skill.
3. Use RTK for noisy output when installed; raw output for exact evidence.
4. Use Gortex only for strong graph/scale/cross-repo triggers; CLI before MCP.
5. Apply Ponytail's minimal-solution ladder after understanding the real flow.
6. Use Caveman only for optional terse prose.
7. Record selected profile, skills and tools in `TASK.md`.

## Verification

- Every enabled tool has a concrete purpose.
- No duplicate lifecycle, memory store or unnecessary MCP schema load.
