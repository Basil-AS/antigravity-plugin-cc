from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

from agentlib import append_jsonl, find_root, now_iso, safe_filename, sha256_file

ROOT = Path(__file__).resolve().parents[1]


ALLOWED_KINDS = {"docs", "downloads", "archives", "tools", "tmp"}


def latest_for_url(manifest: Path, url: str) -> dict | None:
    if not manifest.exists():
        return None
    latest = None
    for line in manifest.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("url") == url:
            latest = row
    return latest


def age_hours(iso_value: str) -> float:
    dt = datetime.fromisoformat(iso_value)
    return (datetime.now(timezone.utc) - dt.astimezone(timezone.utc)).total_seconds() / 3600


def main() -> int:
    parser = argparse.ArgumentParser(description="Download into .agent-cache with SHA256 manifest.")
    parser.add_argument("url")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--kind", choices=sorted(ALLOWED_KINDS), default="downloads")
    parser.add_argument("--name", default=None)
    parser.add_argument("--ttl-hours", type=float, default=168.0)
    parser.add_argument("--sha256", dest="expected_sha256", default=None)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    root = find_root(args.root)
    cache = root / ".agent-cache"
    manifest = cache / "manifest.jsonl"
    previous = latest_for_url(manifest, args.url)

    if previous and not args.force:
        path = root / previous.get("path", "")
        fetched_at = previous.get("fetched_at")
        if path.exists() and fetched_at and age_hours(fetched_at) <= args.ttl_hours:
            digest = sha256_file(path)
            if digest == previous.get("sha256"):
                print(path)
                print(f"CACHE_HIT sha256={digest}")
                return 0

    name = args.name or safe_filename(urlparse(args.url).path)
    target_dir = cache / args.kind
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / name
    tmp = target.with_suffix(target.suffix + ".part")

    headers = {"User-Agent": "UniversalAgentKit/3.0"}
    if previous and not args.force:
        if previous.get("etag"):
            headers["If-None-Match"] = previous["etag"]
        if previous.get("last_modified"):
            headers["If-Modified-Since"] = previous["last_modified"]

    request = urllib.request.Request(args.url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            with tmp.open("wb") as fh:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
            response_headers = response.headers
    except urllib.error.HTTPError as exc:
        if exc.code == 304 and previous:
            path = root / previous["path"]
            print(path)
            print("CACHE_REVALIDATED")
            return 0
        raise SystemExit(f"Download failed: HTTP {exc.code}: {exc.reason}")
    except Exception as exc:
        if tmp.exists():
            tmp.unlink()
        raise SystemExit(f"Download failed: {exc}")

    digest = sha256_file(tmp)
    if args.expected_sha256 and digest.lower() != args.expected_sha256.lower():
        tmp.unlink(missing_ok=True)
        raise SystemExit(
            f"SHA256 mismatch: expected {args.expected_sha256}, got {digest}"
        )
    tmp.replace(target)
    rel = target.relative_to(root).as_posix()
    row = {
        "url": args.url,
        "path": rel,
        "fetched_at": now_iso(),
        "sha256": digest,
        "size": target.stat().st_size,
        "etag": response_headers.get("ETag"),
        "last_modified": response_headers.get("Last-Modified"),
        "content_type": response_headers.get("Content-Type"),
        "ttl_hours": args.ttl_hours,
    }
    append_jsonl(manifest, row)
    print(target)
    print(f"DOWNLOADED sha256={digest} size={row['size']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
