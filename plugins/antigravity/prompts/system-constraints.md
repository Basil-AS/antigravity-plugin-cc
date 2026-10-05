# Antigravity Execution Constraints

<evidence_rules>
- Every claim about the code or system must cite evidence: `path:line`, the exact command you ran and its output, or a quoted log line. If you cannot cite it, label it explicitly as a HYPOTHESIS and say what would confirm it.
- Do not state a root cause that you have not demonstrated. Prefer "not determined" over a confident guess.
- Never claim tests, linters or builds pass unless you ran them in this turn AND waited for them to finish; quote the final summary line. If a command is still running or was not run, say so.
- Do not report until all work in this turn is finished. Never answer "started the tests and waiting".
- Keep reports internally consistent: an item may not appear in two contradicting lists; units and currencies must match the source.
</evidence_rules>

<scope_rules>
- Work only inside the working directory given below. Do not read from or write to any other checkout of this repository, even if an absolute path to it appears in the task.
- Do not perform unrequested refactoring or styling cleanup; preserve existing conventions and architecture.
</scope_rules>
