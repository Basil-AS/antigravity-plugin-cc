import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./process.mjs";

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

export function parsePoolGauge(text, poolName = "gemini") {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed.startsWith(poolName.toLowerCase())) continue;

    // Line format typically contains percent e.g. "85%" or "85.0%" and reset info
    const match = line.match(/([0-9.]+)%\s*(.*)$/);
    if (match) {
      const percent = Math.round(parseFloat(match[1]));
      const reset = match[2]?.trim() || "";
      return { percent, reset };
    }
  }
  return { percent: null, reset: null };
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
    cwd: options.cwd || process.cwd()
  });

  if (result.status !== 0) {
    return {
      available: false,
      error: result.stderr || result.stdout || `exit ${result.status}`,
      gemini: { percent: null, reset: null },
      claude: { percent: null, reset: null }
    };
  }

  const output = result.stdout;
  const gemini = parsePoolGauge(output, "gemini");
  const claude = parsePoolGauge(output, "claude");

  return {
    available: true,
    raw: output,
    gemini,
    claude
  };
}

export function selectGeminiModel(requestedModel = null, quotaInfo = null) {
  const fallbackDefault = "gemini-3.8-flash-medium";
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
