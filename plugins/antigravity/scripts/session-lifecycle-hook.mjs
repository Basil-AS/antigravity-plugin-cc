#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { listJobs, writeJobFile } from "./lib/state.mjs";
import { sweepOrphanIsolations } from "./lib/task-isolation.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "AGY_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) return;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);

  for (const job of jobs) {
    if (job.sessionId !== sessionId) continue;
    if (job.status === "queued" || job.status === "running") {
      if (job.pid) {
        try {
          terminateProcessTree(job.pid, { graceMs: 1500 });
        } catch {}
      }
      writeJobFile(workspaceRoot, job.id, {
        ...job,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt: new Date().toISOString()
      });
    }
  }
}

// Best-effort: a failed sweep must never block the session, but it is reported.
function sweepAbandonedWorktrees(cwd) {
  try {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const keepTempDirs = listJobs(workspaceRoot)
      .map((job) => job.result?.isolation)
      .filter((iso) => iso?.write && iso.tempDir && !iso.appliedAt && !iso.discardedAt)
      .map((iso) => iso.tempDir);
    sweepOrphanIsolations(workspaceRoot, { keepTempDirs });
  } catch (error) {
    process.stderr.write(`[antigravity] orphan worktree sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  sweepAbandonedWorktrees(input.cwd || process.cwd());
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
