from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    errors = []
    for path in ROOT.rglob("*.py"):
        try:
            source = path.read_text(encoding="utf-8")
            compile(source, str(path), "exec")
        except Exception as exc:
            errors.append(f"{path.relative_to(ROOT)}: {exc}")

    required = [
        "AGENTS.md",
        ".agents/reference/UNIVERSAL_AGENT_BOOTSTRAP.md",
        ".agents/reference/UNIVERSAL_AGENT_PROTOCOL.md",
        ".agents/state/CURRENT.md",
        ".agents/tasks/_template/TASK.md",
        ".agents/tooling/TOOLCHAIN.yaml",
        ".agents/skills/CATALOG.yaml",
        "scripts/agent_context.py",
        "scripts/cache_fetch.py",
    ]
    for rel in required:
        if not (ROOT / rel).exists():
            errors.append(f"missing: {rel}")

    for path in ROOT.rglob("*.md"):
        text = path.read_text(encoding="utf-8")
        if text.count("```") % 2:
            errors.append(f"unbalanced code fences: {path.relative_to(ROOT)}")

    if errors:
        print("FAILED")
        for error in errors:
            print(f"- {error}")
        return 1
    print("OK: Python syntax, required files and Markdown fences.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
