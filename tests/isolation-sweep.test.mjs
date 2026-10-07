import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { prepareTaskIsolation, sweepOrphanIsolations } from "../plugins/antigravity/scripts/lib/task-isolation.mjs";

const SKIP = process.platform === "win32" ? "Git CLI test skipped on Windows" : false;
const DAY = 24 * 60 * 60 * 1000;

function withRepo(fn) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-repo-")));
  try {
    execFileSync("git", ["init", "-q", repo]);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "a.txt"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo });
    return fn(repo);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test("sweep removes old orphaned agy-task worktrees and prunes them", { skip: SKIP }, () => {
  withRepo((repo) => {
    const iso = prepareTaskIsolation({ workspaceRoot: repo, write: true });
    try {
      const removed = sweepOrphanIsolations(repo, { now: Date.now() + 2 * DAY });
      assert.deepEqual(removed, [iso.tempDir]);
      assert.equal(fs.existsSync(iso.tempDir), false);
      const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
      assert.doesNotMatch(listed, /agy-task-/);
    } finally {
      fs.rmSync(iso.tempDir, { recursive: true, force: true });
    }
  });
});

test("sweep keeps fresh worktrees and those pending apply", { skip: SKIP }, () => {
  withRepo((repo) => {
    const fresh = prepareTaskIsolation({ workspaceRoot: repo, write: true });
    const pending = prepareTaskIsolation({ workspaceRoot: repo, write: true });
    try {
      assert.deepEqual(sweepOrphanIsolations(repo), []);
      const removed = sweepOrphanIsolations(repo, { keepTempDirs: [pending.tempDir], now: Date.now() + 2 * DAY });
      assert.deepEqual(removed, [fresh.tempDir]);
      assert.equal(fs.existsSync(pending.tempDir), true);
    } finally {
      fs.rmSync(fresh.tempDir, { recursive: true, force: true });
      fs.rmSync(pending.tempDir, { recursive: true, force: true });
    }
  });
});
