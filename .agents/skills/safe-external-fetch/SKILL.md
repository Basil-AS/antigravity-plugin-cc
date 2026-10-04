---
name: safe-external-fetch
description: Use when an agent needs to download documentation, archives, tools, logs, datasets or other reusable external files.
---

# Safe external fetch

## Procedure

1. Prefer an existing fresh cache entry.
2. Run `python scripts/cache_fetch.py <URL> --kind docs|downloads|archives`.
3. Supply `--sha256` when an authoritative digest exists.
4. Read/review the downloaded content before executing or importing it.
5. Pin vendor versions in `.agents/tooling/LOCK.json` when adopted.

## Verification

- Manifest contains source URL, path, time, size and SHA256.
- Download is outside git and semantic indexing.
- No downloaded script executes automatically.
