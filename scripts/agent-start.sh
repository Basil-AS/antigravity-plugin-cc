#!/usr/bin/env sh
set -eu
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else echo "Python 3 not found" >&2; exit 127
fi
"$PY" "$(dirname "$0")/agent_context.py" --ensure --write-local --write-cache
"$PY" "$(dirname "$0")/validate_agent_state.py" --soft
