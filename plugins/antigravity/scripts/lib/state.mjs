import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENVS = ["ANTIGRAVITY_COMPANION_DATA", "AGY_COMPANION_DATA", "CLAUDE_PLUGIN_DATA"];
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "antigravity-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function resolvePluginDataDir() {
  for (const name of PLUGIN_DATA_ENVS) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return null;
}

// Account-wide (not per-workspace) data root, e.g. for the agy quota cache.
export function resolveCompanionDataRoot() {
  return resolvePluginDataDir() ?? FALLBACK_STATE_ROOT_DIR;
}

export function resolveStateDir(cwd = process.cwd()) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = resolvePluginDataDir();
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd = process.cwd()) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd = process.cwd()) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function ensureStateDir(cwd = process.cwd()) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {}
  };
}

export function loadState(cwd = process.cwd()) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      version: STATE_VERSION,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      }
    };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const stateFile = resolveStateFile(cwd);
  atomicWriteJsonFile(stateFile, state);
}

export function getConfig(cwd = process.cwd()) {
  return loadState(cwd).config ?? {};
}

export function saveConfig(cwd, patch = {}) {
  const current = loadState(cwd);
  const updated = {
    ...current,
    config: {
      ...current.config,
      ...patch
    }
  };
  saveState(cwd, updated);
  return updated.config;
}

function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {}
  }
}

const RENAME_RETRY_ATTEMPTS = 50;
const RENAME_RETRY_DELAY_MS = 5;
const SHARING_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function renameWithRetry(tempFile, targetFile) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tempFile, targetFile);
      return;
    } catch (error) {
      if (attempt < RENAME_RETRY_ATTEMPTS && error && SHARING_ERROR_CODES.has(error.code)) {
        sleepSyncMs(RENAME_RETRY_DELAY_MS);
        continue;
      }
      try {
        fs.unlinkSync(tempFile);
      } catch {}
      throw error;
    }
  }
}

export function atomicWriteJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameWithRetry(tempFile, filePath);
}

export function writeJobFile(cwd, jobId, record) {
  ensureStateDir(cwd);
  const target = resolveJobFile(cwd, jobId);
  atomicWriteJsonFile(target, record);
}

export function readJobFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function listJobs(cwd = process.cwd()) {
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) {
    return [];
  }
  const entries = fs.readdirSync(jobsDir);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = path.join(jobsDir, entry);
    const parsed = readJobFile(fullPath);
    if (parsed && typeof parsed === "object" && parsed.id) {
      jobs.push(parsed);
    }
  }

  // Sort newest first
  jobs.sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")));

  // Prune older than MAX_JOBS
  if (jobs.length > MAX_JOBS) {
    const toDelete = jobs.slice(MAX_JOBS);
    for (const oldJob of toDelete) {
      try {
        fs.unlinkSync(resolveJobFile(cwd, oldJob.id));
        const logFile = resolveJobLogFile(cwd, oldJob.id);
        if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
      } catch {}
    }
    return jobs.slice(0, MAX_JOBS);
  }

  return jobs;
}

export function upsertJob(cwd, job) {
  writeJobFile(cwd, job.id, job);
}
