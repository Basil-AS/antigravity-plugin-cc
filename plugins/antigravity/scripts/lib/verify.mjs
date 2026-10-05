import { spawnSync } from "node:child_process";
import process from "node:process";

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_LINES = 60;

function tail(text, maxLines = MAX_OUTPUT_LINES) {
  const lines = String(text ?? "").replace(/\s+$/, "").split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join("\n");
  return [`… (${lines.length - maxLines} earlier lines omitted)`, ...lines.slice(-maxLines)].join("\n");
}

// Runs the caller-supplied verification commands itself, so the report
// carries real exit codes and output instead of the model's claims.
export function runVerifications(commands, { cwd, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, onStart = null } = {}) {
  const results = [];
  for (const command of commands) {
    onStart?.(command);
    const started = Date.now();
    const run = spawnSync(command, {
      cwd,
      shell: process.platform === "win32" ? true : "/bin/sh",
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: process.env
    });
    const timedOut = run.error?.code === "ETIMEDOUT";
    results.push({
      command,
      exitCode: Number.isInteger(run.status) ? run.status : null,
      signal: run.signal ?? null,
      timedOut,
      passed: run.status === 0 && !run.error,
      durationMs: Date.now() - started,
      output: tail(`${run.stdout ?? ""}${run.stderr ? `\n${run.stderr}` : ""}${run.error && !timedOut ? `\n${run.error.message}` : ""}`)
    });
  }
  return results;
}

export function renderVerifications(results) {
  if (!results || results.length === 0) return "";
  const lines = ["## Verification (run by the companion, not reported by the model)", ""];
  for (const r of results) {
    const status = r.passed
      ? "PASS"
      : r.timedOut
        ? "TIMEOUT"
        : `FAIL (exit ${r.exitCode ?? r.signal ?? "?"})`;
    lines.push(`### ${status} \`${r.command}\` (${Math.round(r.durationMs / 1000)}s)`, "```", r.output || "(no output)", "```", "");
  }
  return lines.join("\n");
}
