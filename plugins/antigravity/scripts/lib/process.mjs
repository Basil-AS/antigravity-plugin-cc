import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const useShell = process.platform === "win32" && options.windowsShell === true;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: useShell,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, {
    windowsShell: true,
    ...options
  });
  if (result.error && result.error.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export const DEFAULT_TERMINATION_GRACE_MS = 3000;

function sleepSyncMs(ms) {
  if (!(ms > 0)) {
    return;
  }
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // Coarse fallback wait
    }
  }
}

export function pidIsAlive(pid, killImpl = process.kill.bind(process)) {
  if (!Number.isFinite(pid)) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function processIsAlive(killImpl, pid, negate) {
  try {
    killImpl(negate ? -pid : pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function deliverSignal(killImpl, pid, signal) {
  try {
    killImpl(-pid, signal);
    return { delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      try {
        killImpl(pid, signal);
        return { delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { delivered: false, method: "process" };
        }
        throw innerError;
      }
    }
    try {
      killImpl(pid, signal);
      return { delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : DEFAULT_TERMINATION_GRACE_MS;
  const sleepImpl = options.sleepImpl ?? sleepSyncMs;
  const escalate = options.escalate !== false;
  const firstSignal = options.signalOverride ?? "SIGTERM";

  const sigterm = deliverSignal(killImpl, pid, firstSignal);
  if (!sigterm.delivered) {
    return { attempted: true, delivered: false, method: sigterm.method, escalated: false };
  }

  if (!escalate) {
    return { attempted: true, delivered: true, method: sigterm.method, escalated: false };
  }

  const negate = sigterm.method === "process-group";
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(1, options.pollMs) : 50;
  let waited = 0;
  while (waited < graceMs) {
    if (!processIsAlive(killImpl, pid, negate)) {
      return { attempted: true, delivered: true, method: sigterm.method, escalated: false };
    }
    const slice = Math.min(pollMs, graceMs - waited);
    sleepImpl(slice);
    waited += slice;
  }

  if (!processIsAlive(killImpl, pid, negate)) {
    return { attempted: true, delivered: true, method: sigterm.method, escalated: false };
  }

  const sigkill = deliverSignal(killImpl, pid, "SIGKILL");
  return {
    attempted: true,
    delivered: sigkill.delivered || sigterm.delivered,
    method: sigkill.method ?? sigterm.method,
    escalated: true
  };
}

export function terminateProcessTrees(pids, options = {}) {
  const terminate = options.terminate ?? terminateProcessTree;
  let allStopped = true;
  for (const pid of pids) {
    try {
      terminate(pid, options.terminateOptions ?? {});
    } catch (error) {
      allStopped = false;
      options.onError?.(pid, error);
    }
  }
  return { allStopped };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
