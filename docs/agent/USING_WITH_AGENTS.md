# Agent harness integration

## Preferred setup

Use root `SYSTEM_PROMPT.md` as the global system prompt. Keep the full protocol
in `.agents/reference/UNIVERSAL_AGENT_PROTOCOL.md`.

Harness adapters included:

| Agent/harness | File |
|---|---|
| Codex/OpenCode and compatible | `AGENTS.md` |
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursor/rules/00-universal-agent-kit.mdc` |
| Gemini CLI | `GEMINI.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Windsurf | `.windsurfrules` |
| Cline/Roo | `.clinerules` |

Adapters are intentionally small. They route to one canonical bootstrap rather
than duplicating the full protocol.

## No system-prompt support

Open the project root and explicitly tell the agent:

```text
Read AGENTS.md and perform cold start before working on this task:
<task>
```

## Existing project

Use `install_into_existing_repo.py`; it adds marker blocks and preserves
existing instructions.
