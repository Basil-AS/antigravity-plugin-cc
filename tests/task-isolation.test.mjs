import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTaskPatch,
  captureTreeState,
  finalizeTaskIsolation,
  prepareTaskIsolation,
  removeTaskIsolation
} from "../plugins/antigravity/scripts/lib/task-isolation.mjs";
import { renderVerifications, runVerifications } from "../plugins/antigravity/scripts/lib/verify.mjs";
import { parseArgs } from "../plugins/antigravity/scripts/lib/args.mjs";
import { enrichJob } from "../plugins/antigravity/scripts/lib/job-control.mjs";

const GIT_TEST_SKIP = process.platform === "win32" ? "Git CLI test skipped on Windows" : false;

function withTempGitRepo(fn) {
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-task-iso-git-")));
  try {
    execFileSync("git", ["init", repoDir]);
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
    const initialFile = path.join(repoDir, "initial.txt");
    fs.writeFileSync(initialFile, "initial content\n", "utf8");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "initial.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "initial snapshot"], { cwd: repoDir });
    return fn(repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

test(
  "prepareTaskIsolation with write:true includes uncommitted modifications and untracked files without altering caller repo",
  { skip: GIT_TEST_SKIP },
  () => {
    withTempGitRepo((repoDir) => {
      fs.writeFileSync(path.join(repoDir, "initial.txt"), "modified content\n", "utf8");
      fs.writeFileSync(path.join(repoDir, "untracked.txt"), "untracked content\n", "utf8");

      const stateBefore = captureTreeState(repoDir);
      const isolation = prepareTaskIsolation({ workspaceRoot: repoDir, write: true });
      try {
        assert.equal(isolation.mode, "worktree");
        assert.equal(
          fs.readFileSync(path.join(isolation.workPath, "initial.txt"), "utf8"),
          "modified content\n"
        );
        assert.equal(
          fs.readFileSync(path.join(isolation.workPath, "untracked.txt"), "utf8"),
          "untracked content\n"
        );

        assert.equal(captureTreeState(repoDir), stateBefore);
        assert.equal(fs.readFileSync(path.join(repoDir, "initial.txt"), "utf8"), "modified content\n");
        assert.equal(fs.readFileSync(path.join(repoDir, "untracked.txt"), "utf8"), "untracked content\n");
      } finally {
        removeTaskIsolation(isolation, repoDir);
      }
    });
  }
);

test(
  "finalizeTaskIsolation writes a patch for newly created files, applyTaskPatch applies it to caller repo, and removeTaskIsolation removes worktree",
  { skip: GIT_TEST_SKIP },
  () => {
    withTempGitRepo((repoDir) => {
      const isolation = prepareTaskIsolation({ workspaceRoot: repoDir, write: true });
      try {
        fs.writeFileSync(path.join(isolation.workPath, "new-file.txt"), "new file content\n", "utf8");

        const patchFile = path.join(repoDir, "task.patch");
        const finalized = finalizeTaskIsolation(isolation, { workspaceRoot: repoDir, patchFile });

        assert.equal(finalized.changedFiles.length, 1);
        assert.match(finalized.changedFiles[0], /new-file\.txt$/);
        assert.equal(finalized.patchFile, patchFile);
        assert.equal(fs.existsSync(patchFile), true);

        assert.equal(fs.existsSync(path.join(repoDir, "new-file.txt")), false);
        applyTaskPatch(repoDir, patchFile);
        assert.equal(fs.existsSync(path.join(repoDir, "new-file.txt")), true);
        assert.equal(fs.readFileSync(path.join(repoDir, "new-file.txt"), "utf8"), "new file content\n");

        assert.equal(fs.existsSync(isolation.tempDir), true);
        removeTaskIsolation(finalized, repoDir);
        assert.equal(fs.existsSync(isolation.tempDir), false);
      } finally {
        removeTaskIsolation(isolation, repoDir);
      }
    });
  }
);

test(
  "read-only isolation discards modifications, reports changed files, removes the worktree, and leaves caller repo unchanged",
  { skip: GIT_TEST_SKIP },
  () => {
    withTempGitRepo((repoDir) => {
      const isolation = prepareTaskIsolation({ workspaceRoot: repoDir, write: false });
      try {
        fs.writeFileSync(path.join(isolation.workPath, "initial.txt"), "modified in worktree\n", "utf8");

        const finalized = finalizeTaskIsolation(isolation, { workspaceRoot: repoDir });

        assert.equal(finalized.discarded, true);
        assert.equal(finalized.changedFiles.length, 1);
        assert.match(finalized.changedFiles[0], /initial\.txt$/);
        assert.equal(fs.existsSync(isolation.tempDir), false);
        assert.equal(fs.readFileSync(path.join(repoDir, "initial.txt"), "utf8"), "initial content\n");
      } finally {
        removeTaskIsolation(isolation, repoDir);
      }
    });
  }
);

test(
  "prepareTaskIsolation on non-git directory returns mode in-place with an explanatory note",
  { skip: GIT_TEST_SKIP },
  () => {
    const nonGitDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-task-iso-nongit-")));
    try {
      const isolation = prepareTaskIsolation({ workspaceRoot: nonGitDir, write: true });
      assert.equal(isolation.mode, "in-place");
      assert.equal(isolation.workPath, nonGitDir);
      assert.match(isolation.note, /Workspace is not a git repository/);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  }
);

test("prepareTaskIsolation with inPlace:true returns mode in-place with workPath equal to workspaceRoot", () => {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-task-iso-inplace-")));
  try {
    const isolation = prepareTaskIsolation({ workspaceRoot: tmpDir, write: true, inPlace: true });
    assert.equal(isolation.mode, "in-place");
    assert.equal(isolation.workPath, tmpDir);
    assert.match(isolation.note, /--in-place/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test(
  "applyTaskPatch throws a clear error when patch no longer applies or patchFile is missing",
  { skip: GIT_TEST_SKIP },
  () => {
    withTempGitRepo((repoDir) => {
      const isolation = prepareTaskIsolation({ workspaceRoot: repoDir, write: true });
      const patchFile = path.join(repoDir, "conflict.patch");
      try {
        fs.writeFileSync(path.join(isolation.workPath, "initial.txt"), "modified in worktree\n", "utf8");
        finalizeTaskIsolation(isolation, { workspaceRoot: repoDir, patchFile });
      } finally {
        removeTaskIsolation(isolation, repoDir);
      }

      // Modify the same line in caller repo first
      fs.writeFileSync(path.join(repoDir, "initial.txt"), "modified in caller\n", "utf8");

      assert.throws(
        () => applyTaskPatch(repoDir, patchFile),
        /Patch does not apply cleanly to the current workspace/
      );

      assert.throws(
        () => applyTaskPatch(repoDir, path.join(repoDir, "nonexistent.patch")),
        /This job has no patch to apply/
      );

      assert.throws(
        () => applyTaskPatch(repoDir, null),
        /This job has no patch to apply/
      );
    });
  }
);

test("runVerifications and renderVerifications report command results and format status labels", () => {
  const results = runVerifications([
    'node -e "console.log(\'ok\')"',
    'node -e "process.exit(3)"'
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].passed, true);
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[1].passed, false);
  assert.equal(results[1].exitCode, 3);

  const rendered = renderVerifications(results);
  assert.match(rendered, /PASS/);
  assert.match(rendered, /FAIL \(exit 3\)/);
});

test("parseArgs collects repeated flags into an array when configured in arrayOptions", () => {
  const { options, positionals } = parseArgs(["--verify", "a", "--verify", "b", "x"], {
    arrayOptions: ["verify"]
  });

  assert.deepEqual(options.verify, ["a", "b"]);
  assert.deepEqual(positionals, ["x"]);
});

test("enrichJob strips raw request, result, and rendered properties while exposing compact summary metrics", () => {
  const taskText = "Refactor task isolation workflow across the repository. ".repeat(80);
  const job = {
    id: "job-task-iso-001",
    status: "completed",
    jobClass: "task",
    request: {
      taskText
    },
    result: {
      isolation: {
        mode: "worktree",
        changedFiles: ["A\tfile-a.txt", "M\tfile-b.txt"],
        patchFile: "/tmp/sample.patch"
      }
    },
    rendered: "# Detailed rendered job markdown output..."
  };

  const enriched = enrichJob(job);

  assert.equal("request" in enriched, false);
  assert.equal("result" in enriched, false);
  assert.equal("rendered" in enriched, false);
  assert.equal(enriched.taskChars, taskText.length);
  assert.equal(enriched.changedFiles, 2);
  assert.equal(enriched.pendingPatch, true);
});
