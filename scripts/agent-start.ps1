$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 "$ScriptDir\agent_context.py" --ensure --write-local --write-cache
    & py -3 "$ScriptDir\validate_agent_state.py" --soft
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python "$ScriptDir\agent_context.py" --ensure --write-local --write-cache
    & python "$ScriptDir\validate_agent_state.py" --soft
} else {
    throw "Python 3 not found."
}
