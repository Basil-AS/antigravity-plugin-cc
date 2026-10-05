import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./process.mjs";
import { resolveCompanionDataRoot } from "./state.mjs";

export const DEFAULT_EXHAUSTED_PERCENT = 2;
export const DEFAULT_LOG_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "log");

// Gemini-only fallback chain (strictly no Claude/GPT models)
export const GEMINI_MODEL_FALLBACKS = {
  "gemini-3.8-flash-high": "gemini-3.8-flash-medium",
  "gemini-3.8-flash-medium": "gemini-3.8-flash-low",
  "gemini-3.8-flash-low": "gemini-3.7-flash-medium",
  "gemini-3.7-flash-high": "gemini-3.7-flash-medium",
  "gemini-3.7-flash-medium": "gemini-3.7-flash-low",
  "gemini-3.7-flash-low": "gemini-3.6-flash-medium",
  "gemini-3.1-pro-high": "gemini-3.8-flash-medium",
  "gemini-3.1-pro-low": "gemini-3.8-flash-medium"
};

const WINDOW_NAMES = [
  [/five.?hour/i, "five-hour"],
  [/week/i, "weekly"],
  [/day|daily/i, "daily"]
];

function windowName(label) {
  for (const [pattern, name] of WINDOW_NAMES) {
    if (pattern.test(label)) return name;
  }
  return label.trim().toLowerCase() || "limit";
}

// `agy -p /usage` prints one line per pool and window, e.g.
//   Gemini Models<TAB>Five Hour Limit Remaining<TAB>9%<TAB>2026-10-05T21:16:24Z
// A pool is only as available as its tightest window, so report the minimum.
export function parsePoolGauge(text, poolName = "gemini") {
  const windows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().toLowerCase().startsWith(poolName.toLowerCase())) continue;
    const match = line.match(/([0-9.]+)%\s*(.*)$/);
    if (!match) continue;
    const label = line.slice(0, match.index).split("\t").slice(1).join(" ").trim();
    windows.push({
      window: windowName(label),
      percent: Math.round(parseFloat(match[1])),
      reset: match[2]?.trim() || null
    });
  }
  if (windows.length === 0) {
    return { percent: null, reset: null, window: null, windows };
  }
  const tightest = windows.reduce((min, w) => (w.percent < min.percent ? w : min));
  return { percent: tightest.percent, reset: tightest.reset, window: tightest.window, windows };
}

export function probeAgyUsage(options = {}) {
  const agyBinary = options.agyBinary || "agy";
  const env = {
    ...process.env,
    MSYS_NO_PATHCONV: "1",
    ...(options.env || {})
  };

  const result = runCommand(agyBinary, ["-p", "/usage", "--output-format", "text", "--print-timeout", "30s"], {
    env,
    cwd: options.cwd || process.cwd(),
    // Hard ceiling above agy's own --print-timeout so a hung CLI cannot stall setup.
    timeout: options.timeoutMs ?? 45_000
  });

  if (result.status !== 0) {
    return {
      available: false,
      error: result.stderr || result.stdout || `exit ${result.status}`,
      gemini: { percent: null, reset: null, window: null, windows: [] },
      claude: { percent: null, reset: null, window: null, windows: [] }
    };
  }

  const output = result.stdout;
  return {
    available: true,
    raw: output,
    gemini: parsePoolGauge(output, "gemini"),
    claude: parsePoolGauge(output, "claude")
  };
}

// ---------------------------------------------------------------------------
// Quota guard: fail fast (or wait briefly) instead of sending work to an
// exhausted Gemini pool.
// ---------------------------------------------------------------------------

export const QUOTA_ERROR_CODE = "AGY_QUOTA_EXHAUSTED";
export const QUOTA_EXIT_CODE = 75; // EX_TEMPFAIL: retry later
export const QUOTA_CACHE_MAX_AGE_MS = 90_000;

export function quotaMinPercent(env = process.env) {
  const value = Number(env.AGY_QUOTA_MIN_PERCENT);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_EXHAUSTED_PERCENT;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const totalMinutes = Math.ceil(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, (minutes || (!days && !hours)) && `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

export function parseDuration(value) {
  const match = String(value ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use e.g. 90s, 15m or 1h.`);
  }
  const unit = (match[2] || "m").toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  return Math.round(parseFloat(match[1]) * factor);
}

export class AgyQuotaError extends Error {
  constructor({ window = null, percent = null, resetAt = null, waitMs = null, detail = null } = {}) {
    const where = window ? `${window} limit` : "limit";
    const left = percent !== null && percent !== undefined ? `, ${percent}% left` : "";
    const when = resetAt
      ? ` Resets at ${resetAt}${Number.isFinite(waitMs) ? ` (in ${formatDuration(waitMs)})` : ""}.`
      : " Reset time unknown; check `/agy:setup`.";
    super(`Antigravity Gemini quota exhausted (${where}${left}).${when}${detail ? ` ${detail}` : ""}`);
    this.name = "AgyQuotaError";
    this.code = QUOTA_ERROR_CODE;
    this.window = window;
    this.percent = percent;
    this.resetAt = resetAt;
    this.waitMs = waitMs;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      quotaExhausted: true,
      window: this.window,
      percent: this.percent,
      resetAt: this.resetAt,
      waitMs: this.waitMs
    };
  }
}

// Deliberately specific: a failed turn whose answer merely mentions "quota"
// (e.g. a task about quota code) must not be reported as an exhausted pool.
const QUOTA_ERROR_PATTERN =
  /RESOURCE_EXHAUSTED|\b429\b|quota (?:has been |was |is )?(?:exceeded|exhausted)|exceeded (?:your |the )?(?:current )?quota|rate[ _-]?limit(?:ed| exceeded| reached)|too many requests|usage limit (?:reached|exceeded)|limit (?:has been )?(?:reached|exceeded)/i;

export function isQuotaErrorText(text) {
  return QUOTA_ERROR_PATTERN.test(String(text ?? ""));
}

function quotaCacheFile() {
  return path.join(resolveCompanionDataRoot(), "quota-cache.json");
}

export function getQuotaSnapshot(options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? QUOTA_CACHE_MAX_AGE_MS;
  const cacheFile = options.cacheFile ?? quotaCacheFile();
  const probe = options.probe ?? probeAgyUsage;

  if (!options.fresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (cached && now - cached.checkedAt < maxAgeMs) {
        return cached.quota;
      }
    } catch {}
  }

  const quota = probe({ cwd: options.cwd });
  if (quota?.available) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: now, quota }), "utf8");
    } catch {}
  }
  return quota;
}

export function assessGeminiQuota(quota, options = {}) {
  const now = options.now ?? Date.now();
  const threshold = options.minPercent ?? quotaMinPercent();
  const gemini = quota?.available ? quota.gemini : null;
  if (!gemini || gemini.percent === null) {
    return { known: false, exhausted: false, percent: null, window: null, resetAt: null, waitMs: null };
  }
  const resetMs = gemini.reset ? Date.parse(gemini.reset) : NaN;
  return {
    known: true,
    exhausted: gemini.percent <= threshold,
    percent: gemini.percent,
    window: gemini.window,
    resetAt: gemini.reset,
    waitMs: Number.isFinite(resetMs) ? Math.max(0, resetMs - now) : null
  };
}

export function quotaErrorFromAssessment(assessment, detail = null) {
  return new AgyQuotaError({
    window: assessment?.window ?? null,
    percent: assessment?.percent ?? null,
    resetAt: assessment?.resetAt ?? null,
    waitMs: assessment?.waitMs ?? null,
    detail
  });
}

// Throws AgyQuotaError when the Gemini pool is exhausted, unless the reset
// happens within maxWaitMs, in which case it sleeps until the reset and
// re-checks. An unknown quota (probe failed) never blocks.
export async function ensureGeminiQuota(options = {}) {
  const maxWaitMs = Math.max(0, options.maxWaitMs ?? 0);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? (() => Date.now());
  const deadline = clock() + maxWaitMs;
  let fresh = Boolean(options.fresh);

  for (;;) {
    const quota = getQuotaSnapshot({ ...options, fresh, now: clock() });
    const assessment = assessGeminiQuota(quota, { now: clock(), minPercent: options.minPercent });
    if (!assessment.exhausted) {
      return assessment;
    }
    const remaining = deadline - clock();
    if (assessment.waitMs === null || remaining <= 0 || assessment.waitMs > remaining) {
      throw quotaErrorFromAssessment(assessment);
    }
    options.onWait?.(assessment);
    // Small buffer: the pool is refreshed shortly after the advertised reset.
    await sleep(Math.min(assessment.waitMs + 15_000, remaining));
    fresh = true;
  }
}

export const DEFAULT_GEMINI_FAMILY = "gemini-3.8-flash";
export const GEMINI_EFFORT_LEVELS = ["low", "medium", "high"];

// agy encodes reasoning effort in the model id (gemini-3.8-flash-high), so a
// separate --effort flag is ignored once --model is passed. Map effort onto the
// default family instead; an explicit --model always wins.
export function resolveTaskModel({ model = null, effort = null } = {}) {
  if (effort && !GEMINI_EFFORT_LEVELS.includes(effort)) {
    throw new Error(`Invalid --effort "${effort}". Use one of: ${GEMINI_EFFORT_LEVELS.join(", ")}.`);
  }
  if (model) {
    return selectGeminiModel(model);
  }
  return selectGeminiModel(effort ? `${DEFAULT_GEMINI_FAMILY}-${effort}` : null);
}

export function selectGeminiModel(requestedModel = null, quotaInfo = null) {
  const fallbackDefault = `${DEFAULT_GEMINI_FAMILY}-medium`;
  const model = requestedModel || fallbackDefault;

  // Verify that the requested model is in Gemini line
  if (!model.startsWith("gemini-")) {
    return {
      model: fallbackDefault,
      switched: true,
      original: model,
      reason: "Antigravity plugin enforces Gemini models only for cost efficiency"
    };
  }

  if (quotaInfo && quotaInfo.gemini && quotaInfo.gemini.percent !== null) {
    if (quotaInfo.gemini.percent <= DEFAULT_EXHAUSTED_PERCENT) {
      const fallback = GEMINI_MODEL_FALLBACKS[model] || "gemini-3.8-flash-low";
      return {
        model: fallback,
        switched: fallback !== model,
        original: model,
        reason: `Gemini quota pool low (${quotaInfo.gemini.percent}%)`
      };
    }
  }

  return {
    model,
    switched: false,
    original: model,
    reason: null
  };
}

export function findOwnLogFile(logDir, promptLength, knownLogs = new Set()) {
  if (!fs.existsSync(logDir)) return null;

  try {
    const entries = fs.readdirSync(logDir);
    for (const entry of entries) {
      if (!entry.startsWith("cli-") || !entry.endsWith(".log")) continue;
      const fullPath = path.join(logDir, entry);
      if (knownLogs.has(fullPath)) continue;

      try {
        const head = fs.readFileSync(fullPath, { encoding: "utf8", flag: "r" }).slice(0, 4096);
        const match = head.match(/Print mode: starting \(promptLength=([0-9]+)/);
        if (match && Number(match[1]) === Number(promptLength)) {
          return fullPath;
        }
      } catch {}
    }
  } catch {}

  return null;
}

export function inspectLogForQuotaError(logFile, threshold = 3) {
  if (!logFile || !fs.existsSync(logFile)) {
    return { exhausted: false, count: 0, reset: null };
  }

  try {
    const content = fs.readFileSync(logFile, "utf8");
    const matches = content.match(/RESOURCE_EXHAUSTED/g) || [];
    const count = matches.length;

    if (count >= threshold) {
      const resetMatch = content.match(/Resets in ([0-9A-Za-z.]+)/);
      const reset = resetMatch ? resetMatch[1] : null;
      return {
        exhausted: true,
        count,
        reset
      };
    }

    return { exhausted: false, count, reset: null };
  } catch {
    return { exhausted: false, count: 0, reset: null };
  }
}
