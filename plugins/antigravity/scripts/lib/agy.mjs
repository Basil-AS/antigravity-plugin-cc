import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createAgyStreamReader } from "./agy-stream.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./process.mjs";
import {
  assessGeminiQuota,
  ensureGeminiQuota,
  getQuotaSnapshot,
  isQuotaErrorText,
  quotaErrorFromAssessment,
  selectGeminiModel
} from "./quota.mjs";
import { resolveCompanionDataRoot } from "./state.mjs";

export const DEFAULT_PRINT_TIMEOUT_SECONDS = 720;
export const DEFAULT_TURN_TIMEOUT_MS = 780 * 1000;

export function getAgyAvailability() {
  const binaryCheck = binaryAvailable("agy", ["--version"]);
  if (!binaryCheck.available) {
    return {
      available: false,
      version: null,
      error: "agy binary not found in PATH. Install from https://antigravity.google/docs/cli/overview"
    };
  }
  const version = binaryCheck.detail.split(/\r?\n/)[0].trim();
  return {
    available: true,
    version,
    error: null
  };
}

// agy <= 1.2 kept an OAuth token file; 1.3+ keeps credentials elsewhere (OS
// keyring), so a missing file proves nothing. Ask agy itself: `agy models`
// answers in ~1-2s and says "Please sign in" without a login.
export function agyTokenPaths(home = os.homedir()) {
  return [
    path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    path.join(home, ".antigravity", "antigravity-oauth-token")
  ];
}

const SIGN_IN_PATTERN = /please sign in|sign in to|not signed in|authentication required|visit the url to log in|log in to/i;
const AUTH_PROBE_TIMEOUT_MS = 20_000;
const AUTH_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

function authCacheFile() {
  return path.join(resolveCompanionDataRoot(), "auth-cache.json");
}

export function readCompanionSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveCompanionDataRoot(), "settings.json"), "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function saveCompanionSettings(patch) {
  const file = path.join(resolveCompanionDataRoot(), "settings.json");
  const next = { ...readCompanionSettings(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function findTokenFile(checkedPaths) {
  for (const tokenPath of checkedPaths) {
    if (!fs.existsSync(tokenPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
      if (data.token?.access_token || data.token?.refresh_token || data.id_token) {
        return { tokenPath, authMethod: data.auth_method || "consumer", expiry: data.token?.expiry || null };
      }
    } catch {}
  }
  return null;
}

export function probeAgyLogin({ timeoutMs = AUTH_PROBE_TIMEOUT_MS } = {}) {
  const run = runCommand("agy", ["models"], { windowsShell: true, timeout: timeoutMs, input: "" });
  const text = `${run.stdout}\n${run.stderr}`.trim();
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() && !/^fetching/i.test(l.trim()))?.trim() ?? "";
  if (run.error && run.error.code !== "ETIMEDOUT") {
    return { authenticated: null, detail: `could not run \`agy models\`: ${run.error.message}` };
  }
  if (SIGN_IN_PATTERN.test(text)) {
    return { authenticated: false, detail: firstLine.slice(0, 200) };
  }
  if (run.status === 0 && firstLine) {
    return { authenticated: true, detail: null };
  }
  return {
    authenticated: null,
    detail: run.error?.code === "ETIMEDOUT" ? "`agy models` timed out" : `\`agy models\` exit ${run.status}: ${firstLine.slice(0, 200)}`
  };
}

// authenticated: true (proven), false (agy itself asked for a login) or null
// (could not tell). Only false blocks a run.
export function getAgyAuthStatus({ probe = true, fresh = false, home = os.homedir(), now = Date.now() } = {}) {
  const checkedPaths = agyTokenPaths(home);
  const token = findTokenFile(checkedPaths);
  if (token) {
    return { authenticated: true, authMethod: token.authMethod, source: "token-file", tokenPath: token.tokenPath, expiry: token.expiry, checkedPaths, detail: null };
  }
  const base = { authMethod: null, tokenPath: null, expiry: null, checkedPaths };
  if (!probe) {
    return { ...base, authenticated: null, source: "none", detail: "no token file (agy 1.3+ stores credentials elsewhere)" };
  }
  if (!fresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(authCacheFile(), "utf8"));
      if (cached?.authenticated === true && now - cached.checkedAt < AUTH_CACHE_MAX_AGE_MS) {
        return { ...base, authenticated: true, authMethod: "agy", source: "agy models (cached)", detail: null };
      }
    } catch {}
  }
  const probed = probeAgyLogin();
  if (probed.authenticated === true) {
    try {
      fs.mkdirSync(path.dirname(authCacheFile()), { recursive: true });
      fs.writeFileSync(authCacheFile(), JSON.stringify({ authenticated: true, checkedAt: now }), "utf8");
    } catch {}
  }
  return { ...base, authenticated: probed.authenticated, authMethod: probed.authenticated ? "agy" : null, source: "agy models", detail: probed.detail };
}

export function isAuthCheckSkipped(env = process.env) {
  return env.AGY_SKIP_AUTH_CHECK === "1" || readCompanionSettings().skipAuthCheck === true;
}

export const AUTH_ERROR_CODE = "AGY_NOT_AUTHENTICATED";
export const AUTH_EXIT_CODE = 77; // EX_NOPERM: needs an interactive login first

const AUTH_REQUIRED_PATTERN = /Authentication required|visit the URL to log in|Waiting for authentication/i;

export class AgyAuthError extends Error {
  constructor(detail = null) {
    super(
      "Antigravity CLI is not logged in to Google. Run `agy` once in a terminal to log in, then retry." +
        (detail ? ` (${detail})` : "") +
        " If you are logged in and this is wrong, run `/agy:setup --skip-auth-check`."
    );
    this.name = "AgyAuthError";
    this.code = AUTH_ERROR_CODE;
  }

  toJSON() {
    return { error: this.message, code: this.code, authRequired: true };
  }
}

export function isAuthRequiredText(text) {
  return AUTH_REQUIRED_PATTERN.test(String(text ?? ""));
}

// Without a login agy prints an OAuth URL and blocks ~60s waiting for it, so
// fail fast when agy itself says it needs a login. An inconclusive check does
// not block: a login prompt during the turn is still mapped to AgyAuthError.
// Bypass: AGY_SKIP_AUTH_CHECK=1 or `setup --skip-auth-check` (persistent, so
// it also reaches subagents that cannot set env vars).
export function assertAgyAuthenticated(status = null, env = process.env) {
  if (isAuthCheckSkipped(env)) return;
  const auth = status ?? getAgyAuthStatus();
  if (auth.authenticated === false) {
    throw new AgyAuthError(auth.detail ? `agy said: ${auth.detail}` : null);
  }
}

export function formatAgyTimeout(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return `${DEFAULT_PRINT_TIMEOUT_SECONDS}s`;
  const sec = Math.max(5, Math.round(timeoutMs / 1000));
  return `${sec}s`;
}

export function buildAgyArgs(options = {}) {
  const {
    cwd = process.cwd(),
    write = false,
    sandbox = false,
    resumeThreadId = null,
    model = null,
    effort = null,
    printTimeoutSeconds = DEFAULT_PRINT_TIMEOUT_SECONDS,
    jsonSchema = null
  } = options;

  const args = ["--disable-slash-commands", "--output-format", "stream-json"];

  if (model) {
    const selected = selectGeminiModel(model);
    args.push("--model", selected.model);
  }

  if (effort && !model) {
    args.push("--effort", effort);
  }

  if (write) {
    args.push("--dangerously-skip-permissions");
    args.push("--mode", "accept-edits");
  } else if (sandbox) {
    args.push("--sandbox");
  }

  if (resumeThreadId) {
    args.push("--conversation", resumeThreadId);
  } else {
    args.push("--add-dir", path.resolve(cwd));
  }

  if (jsonSchema) {
    args.push("--json-schema", typeof jsonSchema === "string" ? jsonSchema : JSON.stringify(jsonSchema));
  }

  args.push("--print-timeout", `${printTimeoutSeconds}s`);

  return args;
}

export async function runAgyTurn(options = {}) {
  const {
    prompt,
    cwd = process.cwd(),
    write = false,
    sandbox = false,
    resumeThreadId = null,
    model = null,
    effort = null,
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    onProgress = null,
    jsonSchema = null
  } = options;

  if (!prompt && typeof prompt !== "string") {
    throw new Error("Prompt is required for runAgyTurn.");
  }

  // Calculate inner print timeout to maintain invariant: print-timeout < turn-timeout
  const printTimeoutSeconds = Math.max(5, Math.floor((timeoutMs - 30_000) / 1000));
  const args = buildAgyArgs({
    cwd,
    write,
    sandbox,
    resumeThreadId,
    model,
    effort,
    printTimeoutSeconds,
    jsonSchema
  });

  const reader = createAgyStreamReader();
  let timedOut = false;
  let killTimer = null;
  let child = null;

  const executionPromise = new Promise((resolve, reject) => {
    try {
      child = spawn("agy", args, {
        cwd,
        env: {
          ...process.env,
          MSYS_NO_PATHCONV: "1"
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
    } catch (err) {
      return reject(err);
    }

    let lineBuffer = "";
    let lastLabel = null;

    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop(); // remainder

      for (const line of lines) {
        reader.accept(line);
        // Streamed text deltas repeat the same step label hundreds of times;
        // report only when the step actually changes.
        const label = reader.progressLabel();
        if (onProgress && label !== lastLabel) {
          lastLabel = label;
          onProgress({ message: label, conversationId: reader.state.conversationId });
        }
      }
    });

    let stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);

      if (lineBuffer.trim()) {
        reader.accept(lineBuffer.trim());
      }

      const envelope = reader.envelope();
      const partialText = reader.partialText();

      if (envelope) {
        return resolve({
          status: envelope.status || (code === 0 ? "SUCCESS" : "ERROR"),
          response: envelope.response || partialText,
          duration_seconds: envelope.duration_seconds || 0,
          usage: envelope.usage || null,
          conversation_id: envelope.conversation_id || reader.state.conversationId,
          exitCode: code,
          partial: false
        });
      }

      if (partialText) {
        return resolve({
          status: timedOut ? "TIMEOUT" : (code === 0 ? "SUCCESS" : "PARTIAL"),
          response: partialText,
          duration_seconds: 0,
          usage: null,
          conversation_id: reader.state.conversationId,
          exitCode: code,
          partial: true,
          stderr: stderrBuffer.trim()
        });
      }

      if (timedOut) {
        return reject(new Error(`Antigravity run timed out after ${timeoutMs}ms.`));
      }

      if (code !== 0) {
        const errorDetail = stderrBuffer.trim() || `exit code ${code}`;
        return reject(new Error(`Antigravity CLI failed (${errorDetail}).`));
      }

      resolve({
        status: "SUCCESS",
        response: "",
        duration_seconds: 0,
        usage: null,
        conversation_id: reader.state.conversationId,
        exitCode: code,
        partial: false
      });
    });

    // Write prompt strictly via STDIN and close stream
    child.stdin.on("error", () => {});
    child.stdin.write(prompt, "utf8", (err) => {
      if (err) {
        try { child.kill("SIGTERM"); } catch {}
        reject(err);
      } else {
        try { child.stdin.end(); } catch {}
      }
    });

    // Outer timeout guard
    killTimer = setTimeout(() => {
      timedOut = true;
      if (child && child.pid) {
        terminateProcessTree(child.pid, { graceMs: 2000 });
      }
    }, timeoutMs);
  });

  return executionPromise;
}

function quotaErrorAfterFailure(cwd, detailText) {
  const quota = getQuotaSnapshot({ cwd, fresh: true });
  const firstLine = String(detailText ?? "").trim().split(/\r?\n/)[0].slice(0, 200);
  return quotaErrorFromAssessment(assessGeminiQuota(quota), firstLine ? `agy said: ${firstLine}` : null);
}

// runAgyTurn plus the Gemini quota guard: refuse (or wait up to
// guard.maxWaitMs for the reset) before starting, and turn agy's own
// quota/rate-limit failures into an AgyQuotaError with the reset time.
export async function runAgyTurnWithQuota(options = {}, guard = {}) {
  assertAgyAuthenticated();
  await ensureGeminiQuota({ cwd: options.cwd, maxWaitMs: guard.maxWaitMs ?? 0, onWait: guard.onWait });

  let result;
  try {
    result = await runAgyTurn(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAuthRequiredText(message)) {
      throw new AgyAuthError();
    }
    if (isQuotaErrorText(message)) {
      throw quotaErrorAfterFailure(options.cwd, message);
    }
    throw error;
  }

  if (result.status !== "SUCCESS") {
    const text = `${result.stderr ?? ""}\n${result.response ?? ""}`;
    if (isAuthRequiredText(result.stderr)) {
      throw new AgyAuthError();
    }
    if (isQuotaErrorText(text)) {
      throw quotaErrorAfterFailure(options.cwd, text);
    }
  }
  return result;
}

