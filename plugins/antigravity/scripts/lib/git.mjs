import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";
import { isSecretFilePath, redactSecretContent, sanitizeDiffText, REDACTED_FILE_CONTENT } from "./secrets.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_UNTRACKED_FILES = 50;
const MAX_AGGREGATE_UNTRACKED_BYTES = 128 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

export function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

export function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  const hasHead = git(cwd, ["rev-parse", "-q", "--verify", "HEAD"]).status === 0;
  if (hasHead) {
    return "HEAD";
  }

  return "main";
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  const baseExists = git(cwd, ["rev-parse", "-q", "--verify", detectedBase]).status === 0;
  if (!baseExists) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  if (isSecretFilePath(relativePath)) {
    return `### ${relativePath}\n${REDACTED_FILE_CONTENT}`;
  }
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  const content = redactSecretContent(buffer.toString("utf8").trimEnd(), relativePath);
  return [`### ${relativePath}`, "```", content, "```"].join("\n");
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const branch = getCurrentBranch(cwd);
  const state = getWorkingTreeState(cwd);

  if (target.mode === "working-tree") {
    const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
    const rawStaged = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff"]).stdout;
    const rawUnstaged = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff"]).stdout;
    const stagedDiff = sanitizeDiffText(rawStaged);
    const unstagedDiff = sanitizeDiffText(rawUnstaged);
    let totalUntrackedBytes = 0;
    const formattedUntracked = [];
    let omittedCount = 0;

    for (let i = 0; i < state.untracked.length; i++) {
      const file = state.untracked[i];
      if (i >= MAX_UNTRACKED_FILES || totalUntrackedBytes >= MAX_AGGREGATE_UNTRACKED_BYTES) {
        omittedCount++;
        continue;
      }
      const formatted = formatUntrackedFile(cwd, file);
      totalUntrackedBytes += Buffer.byteLength(formatted, "utf8");
      formattedUntracked.push(formatted);
    }

    if (omittedCount > 0) {
      formattedUntracked.push(`... and ${omittedCount} more untracked file(s) omitted to fit context budget.`);
    }

    const untrackedBody = formattedUntracked.join("\n\n");
    const diffText = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ].join("\n\n");

    const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
    return {
      repoRoot,
      branch,
      target,
      changedFiles,
      summary: `${changedFiles.length} files changed (working tree)`,
      diffText
    };
  }

  // Branch diff
  const baseRef = target.baseRef;
  const mergeBaseRes = git(cwd, ["merge-base", "HEAD", baseRef]);
  const mergeBase = mergeBaseRes.status === 0 ? mergeBaseRes.stdout.trim() : (git(cwd, ["rev-parse", "HEAD"]).stdout.trim() || "HEAD");
  const commitLogRes = git(cwd, ["log", "--oneline", `${mergeBase}..HEAD`]);
  const commitLog = commitLogRes.status === 0 ? commitLogRes.stdout.trim() : "";
  const rawDiffRes = git(cwd, ["diff", "--binary", "--no-ext-diff", `${baseRef}...HEAD`]);
  const rawDiff = rawDiffRes.status === 0 ? rawDiffRes.stdout : (git(cwd, ["diff", "--binary", "--no-ext-diff", "HEAD~1...HEAD"]).stdout || "");
  const diffText = sanitizeDiffText(rawDiff);
  const nameOnlyRes = git(cwd, ["diff", "--name-only", `${baseRef}...HEAD`]);
  const nameOnly = nameOnlyRes.status === 0 ? nameOnlyRes.stdout.trim() : "";
  const changedFiles = nameOnly.split("\n").filter(Boolean);

  return {
    repoRoot,
    branch,
    target,
    changedFiles,
    summary: `${changedFiles.length} files changed against ${baseRef}`,
    commitLog,
    diffText
  };
}

export function createReadOnlyWorktree(repoRoot) {
  const hasCommit = git(repoRoot, ["rev-parse", "-q", "--verify", "HEAD"]).status === 0;
  if (!hasCommit) {
    return { isFallback: true, worktreePath: repoRoot, tempDir: null };
  }
  const stashSnap = git(repoRoot, ["stash", "create"]).stdout.trim();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ro-"));
  const worktreePath = path.join(tempDir, "ro");
  const targetCommit = stashSnap || "HEAD";
  const result = git(repoRoot, ["worktree", "add", "--detach", "-q", worktreePath, targetCommit]);
  if (result.status !== 0) {
    try { fs.rmdirSync(tempDir); } catch {}
    return { isFallback: true, worktreePath: repoRoot, tempDir: null };
  }
  return { isFallback: false, tempDir, worktreePath, targetCommit };
}

export function removeReadOnlyWorktree(repoRoot, worktreePath, tempDir) {
  if (!tempDir || worktreePath === repoRoot) return;
  try {
    git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch {}
  if (fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

export function captureGitFingerprint(repoRoot) {
  try {
    const head = git(repoRoot, ["rev-parse", "-q", "--verify", "HEAD"]).stdout.trim();
    const branch = git(repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout.trim() || "detached";
    const stashCount = git(repoRoot, ["rev-list", "--walk-reflogs", "--count", "refs/stash"]).stdout.trim() || "0";
    return { head, branch, stashCount };
  } catch {
    return null;
  }
}
