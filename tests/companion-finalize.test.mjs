import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { tryAcquireJobSlot } from "../plugins/antigravity/scripts/lib/job-slots.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT_DIR, "plugins", "antigravity", "scripts", "agy-companion.mjs");
const POSIX_ONLY = process.platform === "win32" ? "POSIX shell fake agy" : false;

const RESPONSE = "Checked src/a.js:3, all good.\n\n## Unverified\n- did not run the integration suite";

function git(cwd, ...args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

// Runs the real companion against a fake `agy` that emits a successful
// stream-json turn, so the finalisation path (path rewriting, caveats,
// isolation section, rendering) executes end to end without Gemini.
async function withSuccessfulAgy(fn, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-finalize-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const stream = [
    { event: "init", conversation_id: "conv-1" },
    { event: "step_update", step_update: { conversation_id: "conv-1", step_index: 0, state: "DONE", step_type: "agent_response", text_delta: RESPONSE } },
    { event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: RESPONSE, duration_seconds: 1 } }
  ].map((event) => JSON.stringify(event)).join("\n");
  fs.writeFileSync(path.join(dir, "stream.jsonl"), `${stream}\n`);
  fs.writeFileSync(path.join(bin, "agy"), [
    "#!/bin/sh",
    `if [ "$1" = "-p" ] && [ "$2" = "/usage" ]; then exit 0; fi`,
    `if [ "$1" = "--version" ]; then echo "agy 0.0.0-fake"; exit 0; fi`,
    "cat >/dev/null",
    `cat "${path.join(dir, "stream.jsonl")}"`,
    "exit 0"
  ].join("\n"), { mode: 0o755 });

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-finalize-ws-"));
  git(workspace, "init", "-q");
  git(workspace, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");

  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    JSON.stringify({ token: { access_token: "fake" } })
  );
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    ...extraEnv
  };
  delete env.AGY_COMPANION_SESSION_ID;
  try {
    return await fn({ env, workspace });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test("companion task returns the agent's answer after a successful turn", { skip: POSIX_ONLY }, async () => {
  await withSuccessfulAgy(({ env, workspace }) => {
    const run = spawnSync(process.execPath, [SCRIPT, "task", "--cwd", workspace, "hello"], {
      encoding: "utf8", cwd: workspace, env
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /is not defined/);
    assert.match(run.stdout, /Checked src\/a\.js:3, all good\./);
    assert.match(run.stdout, /Unverified by Antigravity/);
  });
});

test("companion task --json carries extracted caveats", { skip: POSIX_ONLY }, async () => {
  await withSuccessfulAgy(({ env, workspace }) => {
    const run = spawnSync(process.execPath, [SCRIPT, "task", "--json", "--cwd", workspace, "hello"], {
      encoding: "utf8", cwd: workspace, env
    });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(run.stdout);
    assert.equal(data.status, "SUCCESS");
    assert.deepEqual(data.caveats, ["did not run the integration suite"]);
  });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a background worker that cannot get a slot fails its job instead of staying queued", { skip: POSIX_ONLY }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-slot-data-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(dataDir, "data");
  let held;
  try {
    await withSuccessfulAgy(async ({ env, workspace }) => {
      // Occupy the only slot with this (live) process so the worker times out.
      held = tryAcquireJobSlot(workspace, { maxSlots: 1, pid: process.pid });
      assert.equal(held.acquired, true);
      const launch = spawnSync(process.execPath, [SCRIPT, "task", "--background", "--json", "--cwd", workspace, "hello"], {
        encoding: "utf8", cwd: workspace, env
      });
      assert.equal(launch.status, 0, launch.stderr);
      const { jobId } = JSON.parse(launch.stdout);

      let status = "queued";
      for (let i = 0; i < 50 && (status === "queued" || status === "running"); i += 1) {
        await sleep(200);
        const run = spawnSync(process.execPath, [SCRIPT, "status", jobId, "--json", "--cwd", workspace], {
          encoding: "utf8", cwd: workspace, env
        });
        status = JSON.parse(run.stdout).job?.status ?? status;
      }
      assert.equal(status, "failed");
    }, { AGY_SLOT_TIMEOUT_MS: "400", CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA });
  } finally {
    held?.release();
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("`task --help` prints usage and does not create a job", { skip: POSIX_ONLY }, async () => {
  await withSuccessfulAgy(({ env, workspace }) => {
    const help = spawnSync(process.execPath, [SCRIPT, "task", "--help", "--cwd", workspace], {
      encoding: "utf8", cwd: workspace, env
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Antigravity Companion CLI/);

    const status = spawnSync(process.execPath, [SCRIPT, "status", "--all", "--json", "--cwd", workspace], {
      encoding: "utf8", cwd: workspace, env
    });
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /--help/);
  });
});
