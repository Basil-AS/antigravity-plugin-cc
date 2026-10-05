import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { git } from "./git.mjs";

// agy edits files in every mode (no --write, --mode plan and --sandbox all
// still write), so isolation has to come from the plugin: tasks run in a
// throw-away git worktree seeded with the caller's current state (HEAD +
// uncommitted + untracked files). Read-only tasks discard it; write tasks keep
// it and hand back a patch that is applied explicitly with `apply`.

const ISOLATION_ROOT_PREFIX = "agy-task-";
// Ignored dependency/tooling dirs are not part of the snapshot; link them so
// builds and verification commands work inside the isolated copy.
const LINKED_DEPENDENCY_DIRS = ["node_modules", ".venv", "venv", "vendor", ".gradle", ".mvn"];

function isGitRepo(dir) {
  return git(dir, ["rev-parse", "-q", "--verify", "HEAD"]).status === 0;
}

function listUntracked(repoRoot) {
  const result = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (result.status !== 0) return [];
  return result.stdout.split("\0").filter(Boolean);
}

// Porcelain status of the caller's tree, used to detect writes that escaped
// the isolated copy (e.g. absolute paths in the prompt).
export function captureTreeState(repoRoot) {
  const result = git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return result.status === 0 ? result.stdout : null;
}

function stagedTree(worktreePath) {
  git(worktreePath, ["add", "-A"]);
  const result = git(worktreePath, ["write-tree"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function prepareTaskIsolation({ workspaceRoot, write, inPlace = false, reuse = null }) {
  if (inPlace) {
    return { mode: "in-place", workPath: workspaceRoot, note: "Edits applied directly to the workspace (--in-place)." };
  }
  if (!isGitRepo(workspaceRoot)) {
    return {
      mode: "in-place",
      workPath: workspaceRoot,
      note: "Workspace is not a git repository with commits; isolation unavailable, ran in place."
    };
  }

  if (reuse && reuse.mode === "worktree" && reuse.workPath && fs.existsSync(reuse.workPath)) {
    return { ...reuse, write, reused: true };
  }

  const snapshot = git(workspaceRoot, ["stash", "create"]).stdout.trim() || "HEAD";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), ISOLATION_ROOT_PREFIX));
  const workPath = path.join(tempDir, path.basename(workspaceRoot) || "repo");
  const added = git(workspaceRoot, ["worktree", "add", "--detach", "-q", workPath, snapshot]);
  if (added.status !== 0) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Could not create isolated worktree: ${(added.stderr || added.stdout).trim()}`);
  }

  for (const rel of listUntracked(workspaceRoot)) {
    const src = path.join(workspaceRoot, rel);
    const dst = path.join(workPath, rel);
    try {
      if (!fs.lstatSync(src).isFile()) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch {}
  }

  for (const dir of LINKED_DEPENDENCY_DIRS) {
    const src = path.join(workspaceRoot, dir);
    const dst = path.join(workPath, dir);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst, "dir");
    } catch {}
  }

  const baselineTree = stagedTree(workPath);
  return { mode: "worktree", write, workPath, tempDir, baselineTree, snapshot, reused: false };
}

// Collects what agy changed relative to the seeded baseline. For write tasks
// the patch is saved next to the job; read-only worktrees are removed.
export function finalizeTaskIsolation(isolation, { workspaceRoot, patchFile = null, keepReadOnly = false }) {
  if (isolation.mode !== "worktree") {
    return { ...isolation, changedFiles: [], diffStat: "" };
  }

  const tree = stagedTree(isolation.workPath);
  const names = git(isolation.workPath, ["diff", "--cached", "--name-status", isolation.baselineTree]);
  const changedFiles = names.stdout.split(/\r?\n/).filter(Boolean);
  const diffStat = git(isolation.workPath, ["diff", "--cached", "--stat", isolation.baselineTree]).stdout.trim();

  if (!isolation.write) {
    if (!keepReadOnly) removeTaskIsolation(isolation, workspaceRoot);
    return { ...isolation, changedFiles, diffStat, discarded: true, finalTree: tree };
  }

  let savedPatch = null;
  if (patchFile && changedFiles.length > 0) {
    const patch = git(isolation.workPath, ["diff", "--cached", "--binary", isolation.baselineTree]);
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, patch.stdout, "utf8");
    savedPatch = patchFile;
  }
  return { ...isolation, changedFiles, diffStat, patchFile: savedPatch, discarded: false, finalTree: tree };
}

export function removeTaskIsolation(isolation, workspaceRoot) {
  if (!isolation || isolation.mode !== "worktree") return;
  try {
    git(workspaceRoot, ["worktree", "remove", "--force", isolation.workPath]);
  } catch {}
  if (isolation.tempDir && fs.existsSync(isolation.tempDir)) {
    fs.rmSync(isolation.tempDir, { recursive: true, force: true });
  }
}

export function applyTaskPatch(workspaceRoot, patchFile) {
  if (!patchFile || !fs.existsSync(patchFile)) {
    throw new Error("This job has no patch to apply (no changes, or it was already applied/discarded).");
  }
  const check = git(workspaceRoot, ["apply", "--check", "--whitespace=nowarn", patchFile]);
  if (check.status !== 0) {
    throw new Error(
      `Patch does not apply cleanly to the current workspace:\n${(check.stderr || check.stdout).trim()}\n` +
        `Inspect it with: git apply --stat ${patchFile}; resolve with: git apply --3way ${patchFile}`
    );
  }
  const applied = git(workspaceRoot, ["apply", "--whitespace=nowarn", patchFile]);
  if (applied.status !== 0) {
    throw new Error(`git apply failed: ${(applied.stderr || applied.stdout).trim()}`);
  }
  return git(workspaceRoot, ["apply", "--stat", patchFile]).stdout.trim();
}
