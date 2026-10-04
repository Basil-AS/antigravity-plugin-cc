param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$Title
)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 "$ScriptDir\new_task.py" $Title
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python "$ScriptDir\new_task.py" $Title
} else {
    throw "Python 3 not found."
}
