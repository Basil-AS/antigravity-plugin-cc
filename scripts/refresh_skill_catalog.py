from __future__ import annotations

import argparse
from pathlib import Path
import re

from agentlib import find_root

ROOT = Path(__file__).resolve().parents[1]


START = "# BEGIN AUTO-GENERATED LOCAL SKILLS"
END = "# END AUTO-GENERATED LOCAL SKILLS"


def parse_frontmatter(path: Path) -> tuple[str, str] | None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    fm = parts[1]
    name_match = re.search(r"(?m)^name:\s*(.+?)\s*$", fm)
    desc_match = re.search(r"(?ms)^description:\s*(?:>\s*\n)?(.+?)(?=\n[A-Za-z_-]+:|\Z)", fm)
    if not name_match or not desc_match:
        return None
    name = name_match.group(1).strip().strip("'\"")
    desc = " ".join(line.strip() for line in desc_match.group(1).splitlines()).strip().strip("'\"")
    return name, desc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    root = find_root(args.root)
    skills_root = root / ".agents/skills"
    catalog = skills_root / "CATALOG.yaml"
    current = catalog.read_text(encoding="utf-8") if catalog.exists() else "schema_version: 1\n\n"

    entries = []
    for skill_file in sorted(skills_root.glob("*/SKILL.md")):
        parsed = parse_frontmatter(skill_file)
        if not parsed:
            continue
        name, desc = parsed
        rel = skill_file.relative_to(root).as_posix()
        entries.append(
            f"""  - name: {name}
    description: {desc}
    source: local
    trust: project-reviewed
    status: enabled
    category: process
    path: {rel}"""
        )

    block = START + "\nlocal_skills:\n" + ("\n".join(entries) if entries else "  []") + "\n" + END
    pattern = re.compile(rf"(?ms)^{re.escape(START)}.*?^{re.escape(END)}")
    if pattern.search(current):
        updated = pattern.sub(block, current)
    else:
        updated = current.rstrip() + "\n\n" + block + "\n"
    catalog.write_text(updated, encoding="utf-8", newline="\n")
    print(f"Updated {catalog} with {len(entries)} local skills.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
