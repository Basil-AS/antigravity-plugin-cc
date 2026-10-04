from __future__ import annotations

import argparse
from pathlib import Path
import shutil

from agentlib import (
    CURSOR_IGNORE_BLOCK,
    KIT_IGNORE_BLOCK,
    find_root,
    replace_marked_block,
    write_if_missing,
)

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description="Repair/create Universal Agent Kit structure.")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = find_root(args.root)
    template_root = ROOT
    created: list[str] = []

    directories = [
        ".agents/context",
        ".agents/reference",
        ".agents/state",
        ".agents/tasks/_template",
        ".agents/tooling",
        ".agents/skills",
        ".agent-cache/docs",
        ".agent-cache/downloads",
        ".agent-cache/archives",
        ".agent-cache/extracted",
        ".agent-cache/logs",
        ".agent-cache/tools",
        ".agent-cache/tmp",
        ".agent-cache/context",
    ]
    for rel in directories:
        path = root / rel
        if not path.exists():
            created.append(rel + "/")
            if not args.dry_run:
                path.mkdir(parents=True, exist_ok=True)

    copy_if_missing = [
        "AGENT.local.example.md",
        ".agents/protocol-version",
        ".agents/reference/UNIVERSAL_AGENT_BOOTSTRAP.md",
        ".agents/reference/UNIVERSAL_AGENT_PROTOCOL.md",
        ".agents/context/PROJECT.md",
        ".agents/context/ENVIRONMENT.md",
        ".agents/state/CURRENT.md",
        ".agents/tooling/TOOLCHAIN.yaml",
        ".agents/tooling/LOCK.json",
        ".agents/skills/CATALOG.yaml",
        ".agents/tasks/_template/TASK.md",
        ".agents/tasks/_template/JOURNAL.md",
        ".agents/tasks/_template/HANDOFF.md",
    ]
    for rel in copy_if_missing:
        src = template_root / rel
        dst = root / rel
        if src.exists() and not dst.exists():
            created.append(rel)
            if not args.dry_run:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)

    if replace_marked_block(
        root / ".gitignore", "UNIVERSAL AGENT KIT", KIT_IGNORE_BLOCK, args.dry_run
    ):
        created.append(".gitignore marker")
    if replace_marked_block(
        root / ".cursorindexingignore",
        "UNIVERSAL AGENT KIT",
        CURSOR_IGNORE_BLOCK,
        args.dry_run,
    ):
        created.append(".cursorindexingignore marker")

    print(f"Root: {root}")
    if created:
        print(("Would create/update:" if args.dry_run else "Created/updated:"))
        for item in created:
            print(f"- {item}")
    else:
        print("No changes needed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
