from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import getpass
import shutil

from agentlib import find_root, git_snapshot, now_iso, slugify

ROOT = Path(__file__).resolve().parents[1]


def render(text: str, values: dict[str, str]) -> str:
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def main() -> int:
    parser = argparse.ArgumentParser(description="Create canonical task state.")
    parser.add_argument("title")
    parser.add_argument("--request", default=None)
    parser.add_argument("--goal", default=None)
    parser.add_argument("--id", dest="task_id", default=None)
    parser.add_argument("--branch", default=None)
    parser.add_argument("--agent", default=None)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    root = find_root(args.root)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    slug = slugify(args.title)
    task_id = args.task_id or f"{stamp}-{slug}"
    task_dir = root / ".agents/tasks" / task_id
    if task_dir.exists() and not args.force:
        raise SystemExit(f"Task already exists: {task_dir}")

    git = git_snapshot(root)
    branch = args.branch or git.get("branch") or f"agent/chore-{slug}"
    base = git.get("head") or "-"
    base_ref = git.get("default_remote_ref") or "-"
    agent = args.agent or f"unknown ({getpass.getuser()})"
    created = now_iso()

    values = {
        "TASK_ID": task_id,
        "AGENT": agent,
        "BRANCH": branch,
        "BASE_REF": base_ref,
        "BASE_COMMIT": base,
        "CREATED_AT": created,
        "UPDATED_AT": created,
        "REQUEST": args.request or args.title,
        "GOAL": args.goal or args.title,
    }

    template = root / ".agents/tasks/_template"
    if not template.exists():
        raise SystemExit("Missing task template. Run scripts/init_agent_workspace.py.")
    task_dir.mkdir(parents=True, exist_ok=True)
    for name in ("TASK.md", "JOURNAL.md", "HANDOFF.md"):
        src = template / name
        dst = task_dir / name
        dst.write_text(render(src.read_text(encoding="utf-8"), values), encoding="utf-8")

    current = f"""# Current agent state

ACTIVE_TASK: .agents/tasks/{task_id}
STATUS: wip
BRANCH: {branch}
LAST_VERIFIED_COMMIT: -
UPDATED_AT: {created}
NEXT_ACTION: Read TASK.md and refine scope, DoD and verification before editing.
"""
    current_path = root / ".agents/state/CURRENT.md"
    current_path.parent.mkdir(parents=True, exist_ok=True)
    current_path.write_text(current, encoding="utf-8", newline="\n")

    print(f"Created task: {task_dir}")
    print(f"Current state: {current_path}")
    print("No git branch was created or changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
