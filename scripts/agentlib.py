from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
from typing import Iterable


KIT_IGNORE_BLOCK = [
    "AGENT.local.md",
    ".agent-cache/",
    "*.agent-local.*",
    ".agents/runtime/",
    ".agents/tmp/",
]

CURSOR_IGNORE_BLOCK = [
    ".agent-cache/**",
    ".agents/runtime/**",
    ".agents/tmp/**",
    "# Keep .agents/context, tasks, skills and reference indexable.",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def run(args: list[str], cwd: Path | None = None, timeout: int = 20) -> tuple[int, str, str]:
    try:
        p = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)


def find_root(start: Path | None = None) -> Path:
    start = (start or Path.cwd()).resolve()
    code, out, _ = run(["git", "rev-parse", "--show-toplevel"], cwd=start)
    if code == 0 and out:
        return Path(out).resolve()
    for candidate in [start, *start.parents]:
        if (candidate / "AGENTS.md").exists() or (candidate / ".agents").exists():
            return candidate
    return start


def command_version(command: str, args: list[str] | None = None) -> dict:
    exe = shutil.which(command)
    if not exe:
        return {"available": False}
    args = args or ["--version"]
    code, out, err = run([exe, *args], timeout=8)
    first = (out or err).splitlines()
    return {
        "available": True,
        "path": exe,
        "version": first[0][:300] if first else f"exit={code}",
        "exit_code": code,
    }


def git_snapshot(root: Path) -> dict:
    if not (root / ".git").exists():
        code, _, _ = run(["git", "rev-parse", "--git-dir"], cwd=root)
        if code != 0:
            return {"is_repo": False}
    branch_code, branch, _ = run(["git", "branch", "--show-current"], cwd=root)
    head_code, head, _ = run(["git", "rev-parse", "--verify", "HEAD"], cwd=root)
    status_code, status, _ = run(["git", "status", "--short"], cwd=root)
    default_code, default_ref, _ = run(
        ["git", "symbolic-ref", "refs/remotes/origin/HEAD"], cwd=root
    )
    _, remotes, _ = run(["git", "remote", "-v"], cwd=root)
    _, worktrees, _ = run(["git", "worktree", "list", "--porcelain"], cwd=root)
    return {
        "is_repo": True,
        "branch": branch if branch_code == 0 and branch else "(detached/unborn)",
        "head": head if head_code == 0 and head else "-",
        "dirty": status_code == 0 and bool(status),
        "status": status if status_code == 0 else "",
        "default_remote_ref": default_ref if default_code == 0 and default_ref else "-",
        "remotes": remotes,
        "worktrees": worktrees,
    }


def slugify(value: str, max_len: int = 48) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9а-яё]+", "-", value, flags=re.I)
    value = value.strip("-")
    if not value:
        value = "task"
    return value[:max_len].rstrip("-")


def read_text(path: Path, limit: int | None = None) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return ""
    return text if limit is None else text[:limit]


def write_if_missing(path: Path, content: str) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def replace_marked_block(path: Path, name: str, lines: Iterable[str], dry_run: bool = False) -> bool:
    start = f"# BEGIN {name}"
    end = f"# END {name}"
    block = "\n".join([start, *lines, end])
    current = read_text(path)
    pattern = re.compile(
        rf"(?ms)^{re.escape(start)}\n.*?^{re.escape(end)}\s*"
    )
    if pattern.search(current):
        updated = pattern.sub(block + "\n", current)
    else:
        sep = "" if not current else ("\n" if current.endswith("\n") else "\n\n")
        updated = current + sep + block + "\n"
    if updated == current:
        return False
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(updated, encoding="utf-8", newline="\n")
    return True


def parse_current(root: Path) -> dict:
    path = root / ".agents/state/CURRENT.md"
    text = read_text(path)
    result = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key and key.upper() == key:
            result[key] = value.strip()
    return result


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def append_jsonl(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False, sort_keys=True) + "\n")


def safe_filename(value: str, fallback: str = "download.bin") -> str:
    value = value.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1] or fallback
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", value)
    return value[:180] or fallback


def backup_file(root: Path, path: Path) -> Path | None:
    if not path.exists() or not path.is_file():
        return None
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    rel = path.resolve().relative_to(root.resolve())
    target = root / ".agent-cache/install-backups" / stamp / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, target)
    return target
