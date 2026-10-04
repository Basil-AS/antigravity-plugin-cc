import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { pidIsAlive } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS = 1;
const SLOT_DIR_NAME = "slots";
const SLOT_SUFFIX = ".slot";
const DEFAULT_INFLIGHT_GRACE_MS = 30_000;

export function resolveSlotDir(cwd) {
  return path.join(resolveStateDir(cwd), SLOT_DIR_NAME);
}

function ensureSlotDir(cwd) {
  const dir = resolveSlotDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseOwnerPid(raw) {
  if (!raw || !raw.trim()) return Number.NaN;
  try {
    return Number(JSON.parse(raw).pid);
  } catch {
    return Number.NaN;
  }
}

function reapDeadSlots(slotDir, graceMs = DEFAULT_INFLIGHT_GRACE_MS) {
  let held = 0;
  let entries;
  try {
    entries = fs.readdirSync(slotDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.endsWith(SLOT_SUFFIX)) continue;
    const slotPath = path.join(slotDir, entry);
    try {
      const stat = fs.statSync(slotPath);
      const raw = fs.readFileSync(slotPath, "utf8");
      const ownerPid = parseOwnerPid(raw);

      if (Number.isFinite(ownerPid)) {
        if (!pidIsAlive(ownerPid)) {
          fs.unlinkSync(slotPath);
          continue;
        }
      } else {
        if (Date.now() - stat.mtimeMs >= graceMs) {
          fs.unlinkSync(slotPath);
          continue;
        }
      }
      held += 1;
    } catch {
      // Entry may have been unlinked concurrently
    }
  }

  return held;
}

export function tryAcquireJobSlot(cwd, options = {}) {
  const slotDir = ensureSlotDir(cwd);
  reapDeadSlots(slotDir, options.inflightGraceMs);

  const maxSlots = Number.isInteger(options.maxSlots) && options.maxSlots > 0
    ? options.maxSlots
    : DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS;
  const pid = options.pid ?? process.pid;

  for (let index = 0; index < maxSlots; index += 1) {
    const slotPath = path.join(slotDir, `slot-${index}${SLOT_SUFFIX}`);
    let fd = null;
    try {
      fd = fs.openSync(slotPath, "wx");
      try {
        const payload = JSON.stringify({ pid, acquiredAt: new Date().toISOString() }) + "\n";
        fs.writeSync(fd, payload, 0, "utf8");
        fs.closeSync(fd);
        fd = null;
      } catch (writeErr) {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch {}
          fd = null;
        }
        try { fs.unlinkSync(slotPath); } catch {}
        throw writeErr;
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(slotPath);
        } catch {}
      };

      return {
        acquired: true,
        slotIndex: index,
        slotPath,
        release
      };
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (error && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  return { acquired: false, slotIndex: -1, slotPath: null, release: () => {} };
}

export async function acquireJobSlot(cwd, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const attempt = tryAcquireJobSlot(cwd, options);
    if (attempt.acquired) {
      return attempt;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for a free Antigravity job slot in ${cwd} after ${timeoutMs}ms.`);
}
