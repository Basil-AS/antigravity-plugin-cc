import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { findLastTaskConversation } from "../plugins/antigravity/scripts/lib/job-control.mjs";
import { resolveTaskModel } from "../plugins/antigravity/scripts/lib/quota.mjs";
import { writeJobFile } from "../plugins/antigravity/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/antigravity/scripts/lib/tracked-jobs.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT_DIR, "plugins", "antigravity", "scripts", "agy-companion.mjs");

function withTempWorkspace(fn) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-rescue-ws-")));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rescue-data-"));
  // Isolate from the host session: job state dir and session-scoped job filtering.
  const saved = { data: process.env.CLAUDE_PLUGIN_DATA, session: process.env[SESSION_ID_ENV] };
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  delete process.env[SESSION_ID_ENV];
  try {
    return fn(workspace, pluginData);
  } finally {
    if (saved.data === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = saved.data;
    if (saved.session !== undefined) process.env[SESSION_ID_ENV] = saved.session;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
}

test("resolveTaskModel maps --effort onto the default Gemini family", () => {
  assert.equal(resolveTaskModel({}).model, "gemini-3.8-flash-medium");
  assert.equal(resolveTaskModel({ effort: "high" }).model, "gemini-3.8-flash-high");
  assert.equal(resolveTaskModel({ effort: "low" }).model, "gemini-3.8-flash-low");
});

test("resolveTaskModel lets an explicit --model win over --effort", () => {
  assert.equal(resolveTaskModel({ model: "gemini-3.1-pro-high", effort: "low" }).model, "gemini-3.1-pro-high");
});

test("resolveTaskModel rejects unsupported effort levels", () => {
  assert.throws(() => resolveTaskModel({ effort: "max" }), /Invalid --effort "max"/);
});

test("findLastTaskConversation returns the newest task with a conversation id", () => {
  withTempWorkspace((workspace) => {
    assert.equal(findLastTaskConversation(workspace), null);

    writeJobFile(workspace, "task-old", {
      id: "task-old", jobClass: "task", threadId: "conv-old", updatedAt: "2026-10-01T00:00:00Z"
    });
    writeJobFile(workspace, "review-new", {
      id: "review-new", jobClass: "review", threadId: "conv-review", updatedAt: "2026-10-03T00:00:00Z"
    });
    writeJobFile(workspace, "task-new", {
      id: "task-new", jobClass: "task", threadId: "conv-new", updatedAt: "2026-10-02T00:00:00Z"
    });
    writeJobFile(workspace, "task-running", {
      id: "task-running", jobClass: "task", threadId: null, updatedAt: "2026-10-04T00:00:00Z"
    });

    assert.deepEqual(findLastTaskConversation(workspace), { jobId: "task-new", threadId: "conv-new", isolation: null });
  });
});

test("companion task --dry-run honours --effort, --prompt-file and --wait", () => {
  withTempWorkspace((workspace, pluginData) => {
    const promptFile = path.join(workspace, "task.md");
    fs.writeFileSync(promptFile, "Write unit tests for lib/args.mjs");

    const output = execFileSync(
      process.execPath,
      [SCRIPT, "task", "--dry-run", "--json", "--wait", "--effort", "high", "--prompt-file", promptFile, "--cwd", workspace],
      { encoding: "utf8", cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, PATH: "" } }
    );
    const data = JSON.parse(output);
    assert.equal(data.model, "gemini-3.8-flash-high");
    assert.equal(data.effort, "high");
    assert.equal(data.resumeThreadId, null);
    assert.equal(data.promptChars, "Write unit tests for lib/args.mjs".length);
  });
});

test("companion task --resume-last fails clearly without a previous conversation", () => {
  withTempWorkspace((workspace, pluginData) => {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, "task", "--dry-run", "--resume-last", "--cwd", workspace], {
          encoding: "utf8",
          cwd: workspace,
          stdio: "pipe",
          env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, PATH: "" }
        }),
      /No previous Antigravity task conversation/
    );
  });
});

test("companion task --dry-run --resume-last picks the stored conversation", () => {
  withTempWorkspace((workspace, pluginData) => {
    writeJobFile(workspace, "task-prev", {
      id: "task-prev", jobClass: "task", threadId: "conv-123", updatedAt: "2026-10-02T00:00:00Z"
    });

    const output = execFileSync(
      process.execPath,
      [SCRIPT, "task", "--dry-run", "--json", "--resume-last", "--cwd", workspace],
      { encoding: "utf8", cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, PATH: "" } }
    );
    const data = JSON.parse(output);
    assert.equal(data.resumeThreadId, "conv-123");
  });
});
