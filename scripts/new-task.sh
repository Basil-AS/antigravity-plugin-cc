#!/usr/bin/env sh
set -eu
if [ "$#" -lt 1 ]; then echo "Usage: $0 <task title>" >&2; exit 2; fi
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else echo "Python 3 not found" >&2; exit 127
fi
"$PY" "$(dirname "$0")/new_task.py" "$@"
