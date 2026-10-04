from __future__ import annotations

import argparse
from pathlib import Path
import re

from agentlib import find_root, parse_current, run

ROOT = Path(__file__).resolve().parents[1]


REQUIRED_TASK_FIELDS = [
    "TASK_ID", "STATUS", "AGENT", "BRANCH", "BASE_REF", "BASE_COMMIT",
    "LAST_CHECKPOINT_COMMIT", "LAST_VERIFIED_COMMIT", "PROFILE",
    "ACTIVE_SKILLS", "TOOLS_USED", "CREATED_AT", "UPDATED_AT",
]
REQUIRED_HANDOFF_FIELDS = [
    "TASK_ID", "STATUS", "BRANCH", "BASE_COMMIT", "HEAD",
    "LAST_VERIFIED_COMMIT", "PROFILE", "ACTIVE_SKILLS", "TOOLS_USED",
    "UPDATED_AT",
]


def fields(text: str) -> set[str]:
    result = set()
    for line in text.splitlines():
        if ":" in line:
            key = line.split(":", 1)[0].strip()
            if key and key.upper() == key:
                result.add(key)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--soft", action="store_true", help="Always exit 0.")
    args = parser.parse_args()
    root = find_root(args.root)
    errors: list[str] = []
    warnings: list[str] = []

    required = [
        "AGENTS.md",
        ".agents/reference/UNIVERSAL_AGENT_BOOTSTRAP.md",
        ".agents/reference/UNIVERSAL_AGENT_PROTOCOL.md",
        ".agents/context/PROJECT.md",
        ".agents/context/ENVIRONMENT.md",
        ".agents/state/CURRENT.md",
        ".agents/tooling/TOOLCHAIN.yaml",
        ".agents/tooling/LOCK.json",
        ".agents/skills/CATALOG.yaml",
    ]
    for rel in required:
        if not (root / rel).exists():
            errors.append(f"missing: {rel}")

    current = parse_current(root)
    active = current.get("ACTIVE_TASK", "-")
    if active not in ("", "-"):
        task_dir = root / active
        if not task_dir.exists():
            errors.append(f"active task does not exist: {active}")
        else:
            task_path = task_dir / "TASK.md"
            handoff_path = task_dir / "HANDOFF.md"
            journal_path = task_dir / "JOURNAL.md"
            for path in (task_path, handoff_path, journal_path):
                if not path.exists():
                    errors.append(f"missing active task file: {path.relative_to(root)}")
            if task_path.exists():
                missing = set(REQUIRED_TASK_FIELDS) - fields(task_path.read_text(encoding="utf-8"))
                if missing:
                    errors.append(f"TASK.md missing fields: {', '.join(sorted(missing))}")
            if handoff_path.exists():
                text = handoff_path.read_text(encoding="utf-8")
                missing = set(REQUIRED_HANDOFF_FIELDS) - fields(text)
                if missing:
                    errors.append(f"HANDOFF.md missing fields: {', '.join(sorted(missing))}")
                if "## Exact next action" not in text or "EXPECTED:" not in text:
                    errors.append("HANDOFF.md lacks exact next action/expected result")
    else:
        warnings.append("no active task")

    code, tracked, _ = run(["git", "ls-files", ".agent-cache"], cwd=root)
    if code == 0 and tracked:
        errors.append(".agent-cache contains tracked files")

    gitignore = (root / ".gitignore").read_text(encoding="utf-8") if (root / ".gitignore").exists() else ""
    if ".agent-cache/" not in gitignore:
        errors.append(".gitignore does not ignore .agent-cache/")

    print(f"Root: {root}")
    for item in warnings:
        print(f"WARN: {item}")
    for item in errors:
        print(f"ERROR: {item}")
    if not errors:
        print("OK: agent structure/state is valid.")
    return 0 if (not errors or args.soft) else 1


if __name__ == "__main__":
    raise SystemExit(main())
