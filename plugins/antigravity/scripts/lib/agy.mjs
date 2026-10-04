import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createAgyStreamReader } from "./agy-stream.mjs";
import { binaryAvailable, terminateProcessTree } from "./process.mjs";
import { selectGeminiModel } from "./quota.mjs";

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

export function getAgyAuthStatus() {
  const tokenPaths = [
    path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    path.join(os.homedir(), ".antigravity", "antigravity-oauth-token")
  ];

  for (const tokenPath of tokenPaths) {
    if (fs.existsSync(tokenPath)) {
      try {
        const raw = fs.readFileSync(tokenPath, "utf8");
        const data = JSON.parse(raw);
        const hasToken = Boolean(data.token?.access_token || data.token?.refresh_token || data.id_token);
        if (hasToken) {
          return {
            authenticated: true,
            authMethod: data.auth_method || "consumer",
            tokenPath,
            expiry: data.token?.expiry || null
          };
        }
      } catch {}
    }
  }

  return {
    authenticated: false,
    authMethod: null,
    tokenPath: null,
    expiry: null
  };
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

    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop(); // remainder

      for (const line of lines) {
        reader.accept(line);
        if (onProgress) {
          const delta = reader.partialText();
          const progress = reader.progressLabel();
          onProgress({ message: progress, delta, conversationId: reader.state.conversationId });
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
