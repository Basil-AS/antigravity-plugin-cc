from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import subprocess
import sys

from agentlib import find_root, git_snapshot, now_iso, parse_current, read_text
from agent_doctor import collect, write_local

ROOT = Path(__file__).resolve().parents[1]


def run_init(root: Path) -> None:
    script = Path(__file__).with_name("init_agent_workspace.py")
    result = subprocess.run(
        [sys.executable, str(script), "--root", str(root)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)


def snapshot(root: Path) -> str:
    git = git_snapshot(root)
    current = parse_current(root)
    active = current.get("ACTIVE_TASK", "-")
    task_dir = root / active if active not in ("", "-") else None

    lines = [
        "# Cold-start context",
        "",
        f"GENERATED_AT: {now_iso()}",
        f"ROOT: {root}",
        f"ACTIVE_TASK: {active}",
        f"STATUS: {current.get('STATUS', '-')}",
        f"NEXT_ACTION: {current.get('NEXT_ACTION', '-')}",
        "",
        "## Git",
    ]
    if not git.get("is_repo"):
        lines.append("- Not a git repository yet.")
    else:
        lines += [
            f"- Branch: `{git.get('branch')}`",
            f"- HEAD: `{git.get('head')}`",
            f"- Dirty: `{git.get('dirty')}`",
            f"- Default remote ref: `{git.get('default_remote_ref')}`",
        ]
        if git.get("status"):
            lines += ["", "```text", git["status"], "```"]

    lines += ["", "## Required reading"]
    required = [
        "AGENTS.md",
        ".agents/reference/UNIVERSAL_AGENT_BOOTSTRAP.md",
        ".agents/context/PROJECT.md",
        ".agents/context/ENVIRONMENT.md",
        ".agents/tooling/TOOLCHAIN.yaml",
        ".agents/skills/CATALOG.yaml",
        ".agents/state/CURRENT.md",
    ]
    if task_dir:
        required += [
            str(task_dir.relative_to(root) / "TASK.md"),
            str(task_dir.relative_to(root) / "HANDOFF.md"),
            str(task_dir.relative_to(root) / "JOURNAL.md"),
        ]
    for rel in required:
        lines.append(f"- {'OK' if (root / rel).exists() else 'MISSING'} `{rel}`")

    if task_dir and task_dir.exists():
        for name, limit in (("TASK.md", 9000), ("HANDOFF.md", 7000)):
            path = task_dir / name
            lines += ["", f"## Active {name}", "", read_text(path, limit) or "(missing)"]

    doctor = collect(root)
    lines += ["", "## Tool capability summary"]
    for name in ("git", "gh", "rtk", "gortex", "rg", "fd", "jq", "yq", "ast-grep", "docker"):
        info = doctor["tools"].get(name, {})
        lines.append(
            f"- {name}: {info.get('version') if info.get('available') else 'absent'}"
        )

    lines += [
        "",
        "## Resume rule",
        "",
        "Reconcile this snapshot with git/tests/CI. Do not treat the snapshot as",
        "newer than source evidence. Preserve unknown work and continue the matching",
        "active task instead of creating a duplicate.",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--ensure", action="store_true")
    parser.add_argument("--write-local", action="store_true")
    parser.add_argument("--write-cache", action="store_true")
    args = parser.parse_args()

    root = find_root(args.root)
    if args.ensure:
        run_init(root)
    data = collect(root)
    if args.write_local:
        write_local(root, data)
    text = snapshot(root)
    if args.write_cache:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        path = root / ".agent-cache/context" / f"cold-start-{stamp}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"Context cached: {path}", file=sys.stderr)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
