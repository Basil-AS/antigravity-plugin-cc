#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseArgs } from "./lib/args.mjs";
import {
  AUTH_ERROR_CODE,
  AUTH_EXIT_CODE,
  assertAgyAuthenticated,
  getAgyAvailability,
  getAgyAuthStatus,
  isAuthCheckSkipped,
  saveCompanionSettings,
  runAgyTurnWithQuota
} from "./lib/agy.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  collectReviewContext,
  createReadOnlyWorktree,
  ensureGitRepository,
  removeReadOnlyWorktree,
  resolveReviewTarget
} from "./lib/git.mjs";
import { acquireJobSlot } from "./lib/job-slots.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  QUOTA_ERROR_CODE,
  QUOTA_EXIT_CODE,
  assessGeminiQuota,
  formatDuration,
  getQuotaSnapshot,
  parseDuration,
  probeAgyUsage,
  quotaErrorFromAssessment,
  resolveTaskModel,
  selectGeminiModel
} from "./lib/quota.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  findLastTaskConversation,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import {
  normalizeReviewResultData,
  renderJobStatusReport,
  renderQueuedTaskLaunch,
  renderReviewResult,
  renderSetupReport,
  renderStatusPayload
} from "./lib/render.mjs";
import { validateAgainstSchema } from "./lib/schema-validate.mjs";
import {
  getConfig,
  resolveJobFile,
  saveConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  applyTaskPatch,
  captureTreeState,
  finalizeTaskIsolation,
  prepareTaskIsolation,
  removeTaskIsolation
} from "./lib/task-isolation.mjs";
import { renderVerifications, runVerifications } from "./lib/verify.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");

function generateJobId(prefix = "job") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function readQuotaWaitMs(options) {
  return options["wait-for-quota"] ? parseDuration(options["wait-for-quota"]) : 0;
}

// Launcher-side check so a background job is not queued against an exhausted
// pool; the job itself still re-checks (and may wait) right before agy runs.
function assertQuotaForLaunch(cwd, maxWaitMs) {
  assertAgyAuthenticated();
  const assessment = assessGeminiQuota(getQuotaSnapshot({ cwd }));
  if (assessment.exhausted && !(assessment.waitMs !== null && assessment.waitMs <= maxWaitMs)) {
    throw quotaErrorFromAssessment(assessment);
  }
  return assessment;
}

function describeQuota(assessment) {
  if (!assessment?.known) return "unknown";
  const reset = assessment.resetAt ? `, resets ${assessment.resetAt} (in ${formatDuration(assessment.waitMs)})` : "";
  return `${assessment.percent}% (${assessment.window} limit${reset})${assessment.exhausted ? " — EXHAUSTED" : ""}`;
}

function quotaWaitReporter(progress) {
  return (a) => progress({ message: `Waiting for Gemini quota reset at ${a.resetAt} (in ${formatDuration(a.waitMs)})...`, phase: "waiting-quota" });
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ").trim();
  return positionalPrompt || readStdinIfPiped();
}

function loadSystemConstraints() {
  try {
    const p = path.join(ROOT_DIR, "prompts", "system-constraints.md");
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8").trim();
    }
  } catch {}
  return "";
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "skip-auth-check", "enforce-auth-check"]
  });

  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  if (options["enable-review-gate"]) {
    saveConfig(workspaceRoot, { stopReviewGate: true });
  } else if (options["disable-review-gate"]) {
    saveConfig(workspaceRoot, { stopReviewGate: false });
  }

  const nodeCheck = binaryAvailable("node", ["--version"]);
  const gitCheck = binaryAvailable("git", ["--version"]);
  const agy = getAgyAvailability();
  if (options["skip-auth-check"]) {
    saveCompanionSettings({ skipAuthCheck: true });
  } else if (options["enforce-auth-check"]) {
    saveCompanionSettings({ skipAuthCheck: false });
  }
  const authCheckSkipped = isAuthCheckSkipped();
  const auth = agy.available ? { ...getAgyAuthStatus({ fresh: true }), checkSkipped: authCheckSkipped } : { authenticated: null, checkSkipped: authCheckSkipped, checkedPaths: [], source: "none", detail: "agy not installed" };
  // An unauthenticated agy blocks the /usage probe on an OAuth prompt; skip it.
  const quota = agy.available && auth.authenticated !== false ? probeAgyUsage({ cwd }) : null;

  const ready = nodeCheck.available && gitCheck.available && agy.available && (auth.authenticated !== false || authCheckSkipped);

  const data = {
    ready,
    node: { available: nodeCheck.available, version: nodeCheck.detail },
    git: { available: gitCheck.available, version: gitCheck.detail },
    agy,
    auth,
    quota,
    config: getConfig(workspaceRoot)
  };

  outputCommandResult(data, renderSetupReport(data), options.json);
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "agy-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function buildTaskPrompt({ taskText, isolation, workspaceRoot, callerRel, write, verify, resumed }) {
  const lines = [];
  if (!resumed) {
    const constraints = loadSystemConstraints();
    if (constraints) lines.push(constraints, "");
  }
  const where =
    isolation.mode === "worktree"
      ? write
        ? `an isolated copy of ${workspaceRoot}; your changes there are returned to the caller as a patch`
        : `an isolated, disposable copy of ${workspaceRoot}`
      : "the caller's workspace";
  lines.push(`Working directory: ${isolation.workPath} (${where}).`);
  if (callerRel) {
    lines.push(`The caller was in the subdirectory \`${callerRel}\`; relative paths in the task are relative to the working directory root unless they only make sense from that subdirectory.`);
  }
  lines.push(
    write
      ? "Mode: WRITE. Make the requested changes directly with your file tools inside the working directory; do not just print code. When done, list the files you changed and the checks you ran with their real output."
      : "Mode: READ-ONLY ANALYSIS. Do not create, modify or delete any files. Investigate and report findings with evidence. Any file change will be discarded and reported as a violation."
  );
  if (verify.length > 0) {
    lines.push(`After you finish, the companion will itself run and attach the output of: ${verify.map((c) => `\`${c}\``).join(", ")}.`);
  }
  lines.push(
    "End your report with a `## Unverified` section listing every claim you did not check line by line against the code or data (write `None` if you checked everything)."
  );
  lines.push("", "Task:", taskText);
  return lines.join("\n");
}

function taskPatchFile(workspaceRoot, jobId) {
  return resolveJobFile(workspaceRoot, jobId).replace(/\.json$/, ".patch");
}

function renderIsolationSection(jobId, isolation, escaped) {
  const lines = [];
  if (isolation.mode === "worktree" && isolation.write) {
    lines.push("## Changes (isolated worktree — NOT yet applied to your workspace)", "");
    if (isolation.changedFiles.length === 0) {
      lines.push("No file changes were made.");
    } else {
      lines.push("```", isolation.diffStat, "```", "");
      lines.push(`- Worktree: \`${isolation.workPath}\``);
      lines.push(`- Patch: \`${isolation.patchFile}\``);
      lines.push(`- Apply after review: \`/agy:apply ${jobId}\` — or drop it: \`/agy:discard ${jobId}\``);
    }
  } else if (isolation.mode === "worktree") {
    if (isolation.changedFiles.length > 0) {
      lines.push(
        "## ⚠ Read-only violation",
        "",
        `Antigravity modified ${isolation.changedFiles.length} file(s) in its disposable copy; the changes were discarded:`,
        "```",
        ...isolation.changedFiles,
        "```"
      );
    }
  } else if (isolation.note) {
    lines.push(`> ${isolation.note}`);
  }
  if (escaped) {
    lines.push(
      "",
      "## ⚠ Workspace changed during the job",
      "",
      "Files in the real workspace changed while the job ran (outside the isolated copy). Check `git status` — the change may come from Antigravity using an absolute path, or from other activity."
    );
  }
  return lines.join("\n");
}

function summarizeIsolation(isolation) {
  return {
    mode: isolation.mode,
    write: Boolean(isolation.write),
    workPath: isolation.mode === "worktree" && isolation.write ? isolation.workPath : null,
    tempDir: isolation.mode === "worktree" && isolation.write ? isolation.tempDir : null,
    baselineTree: isolation.baselineTree ?? null,
    patchFile: isolation.patchFile ?? null,
    changedFiles: isolation.changedFiles ?? [],
    diffStat: isolation.diffStat ?? "",
    discarded: Boolean(isolation.discarded),
    note: isolation.note ?? null
  };
}

async function executeTask({ workspaceRoot, jobId, request, progress }) {
  const verify = request.verify ?? [];
  const isolation = prepareTaskIsolation({
    workspaceRoot,
    write: request.write,
    inPlace: request.inPlace,
    reuse: request.reuseIsolation ?? null
  });
  const before = isolation.mode === "worktree" ? captureTreeState(workspaceRoot) : null;
  const prompt = buildTaskPrompt({
    taskText: request.taskText,
    isolation,
    workspaceRoot,
    callerRel: request.callerRel,
    write: request.write,
    verify,
    resumed: Boolean(request.resumeThreadId)
  });

  let result;
  try {
    progress({ message: `Running on ${request.model} in ${isolation.mode === "worktree" ? "isolated worktree" : "workspace"}...`, phase: "running" });
    result = await runAgyTurnWithQuota({
      prompt,
      cwd: isolation.workPath,
      write: request.write,
      model: request.model,
      resumeThreadId: request.resumeThreadId ?? null,
      onProgress: (p) => progress({ message: p.message, conversationId: p.conversationId, phase: "running" })
    }, {
      maxWaitMs: request.quotaWaitMs ?? 0,
      onWait: (a) => progress({ message: `Waiting for Gemini quota reset at ${a.resetAt} (in ${formatDuration(a.waitMs)})...`, phase: "waiting-quota" })
    });
  } catch (error) {
    if (!isolation.reused) removeTaskIsolation(isolation, workspaceRoot);
    throw error;
  }

  // Capture the model's changes before verification runs, so build/test
  // artefacts produced by the checks never end up in the patch.
  const finalIsolation = finalizeTaskIsolation(isolation, {
    workspaceRoot,
    patchFile: taskPatchFile(workspaceRoot, jobId),
    keepReadOnly: true
  });
  const escaped = before !== null && captureTreeState(workspaceRoot) !== before;

  let verifications = [];
  if (verify.length > 0) {
    verifications = runVerifications(verify, {
      cwd: isolation.workPath,
      onStart: (command) => progress({ message: `Verifying: ${command}`, phase: "verifying" })
    });
  }
  if (!request.write) removeTaskIsolation(isolation, workspaceRoot);

  // Links into the deleted temp copy are useless to the caller; point them at
  // the real workspace (for write jobs the files exist there after apply).
  const response = rewriteIsolationPaths(result.response, isolation, workspaceRoot);
  result = { ...result, response, caveats: extractCaveats(response) };
  const sections = [];
  const caveatText = renderCaveats(result.caveats);
  if (caveatText) sections.push(caveatText);
  sections.push(response.trimEnd());
  const isolationText = renderIsolationSection(jobId, finalIsolation, escaped);
  if (isolationText) sections.push(isolationText);
  const verifyText = renderVerifications(verifications);
  if (verifyText) sections.push(verifyText);
  const rendered = `${sections.join("\n\n")}\n`;

  const verifyFailed = verifications.some((v) => !v.passed);
  return {
    exitStatus: result.status === "SUCCESS" && !verifyFailed ? 0 : 1,
    conversationId: result.conversation_id,
    payload: {
      ...result,
      isolation: summarizeIsolation(finalIsolation),
      workspaceChangedDuringJob: escaped,
      verification: verifications
    },
    rendered,
    summary: `${verifyFailed ? "[verification failed] " : ""}${result.response.slice(0, 120).replace(/\r?\n/g, " ")}`
  };
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "wait-for-quota"],
    arrayOptions: ["verify"],
    booleanOptions: ["json", "write", "background", "wait", "resume-last", "dry-run", "in-place", "read-only"],
    aliasMap: { m: "model" }
  });

  if (options.write && options["read-only"]) {
    throw new Error("--write and --read-only are mutually exclusive.");
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const callerRel = path.relative(workspaceRoot, cwd);
  const userPrompt = readTaskPrompt(cwd, options, positionals);

  if (!userPrompt && !options["resume-last"]) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  let resume = null;
  if (options["resume-last"]) {
    resume = findLastTaskConversation(cwd);
    if (!resume) {
      throw new Error("No previous Antigravity task conversation found in this workspace to resume.");
    }
  }

  const write = Boolean(options.write);
  const taskText = userPrompt || "Continue the previous task from where you left off.";
  const resumeThreadId = resume?.threadId ?? null;
  const modelSelection = resolveTaskModel({ model: options.model, effort: options.effort });
  const verify = (options.verify ?? []).map((c) => c.trim()).filter(Boolean);

  const request = {
    cwd,
    workspaceRoot,
    callerRel: callerRel && !callerRel.startsWith("..") ? callerRel : "",
    taskText,
    write,
    inPlace: Boolean(options["in-place"]),
    model: modelSelection.model,
    effort: options.effort || null,
    resumeThreadId,
    reuseIsolation: write && resume?.isolation?.write ? resume.isolation : null,
    verify,
    quotaWaitMs: 0
  };

  if (options["dry-run"]) {
    const quota = getQuotaSnapshot({ cwd });
    const quotaAssessment = assessGeminiQuota(quota);
    const dryRunPayload = {
      dryRun: true,
      command: "task",
      model: modelSelection.model,
      write,
      isolation: request.inPlace ? "in-place" : "worktree",
      background: Boolean(options.background),
      effort: options.effort || null,
      resumeThreadId,
      verify,
      promptChars: taskText.length,
      quota,
      quotaAssessment
    };
    const rendered = [
      "# Antigravity Task (Dry Run)",
      `- Model: ${modelSelection.model}`,
      `- Mode: ${write ? "write" : "read-only"} (${request.inPlace ? "in place" : "isolated worktree"})`,
      `- Background: ${Boolean(options.background)}`,
      `- Resume: ${resume ? `${resume.threadId} (from ${resume.jobId})` : "no"}`,
      `- Verify: ${verify.length ? verify.map((c) => `\`${c}\``).join(", ") : "none"}`,
      `- Task length: ${taskText.length} characters`,
      `- Gemini Quota: ${describeQuota(quotaAssessment)}`
    ].join("\n");
    outputCommandResult(dryRunPayload, rendered, options.json);
    return;
  }

  request.quotaWaitMs = readQuotaWaitMs(options);
  assertQuotaForLaunch(cwd, request.quotaWaitMs);

  const jobId = generateJobId("task");
  const taskMetadata = {
    id: jobId,
    prefix: "task",
    kind: "task",
    jobClass: "task",
    title: taskText.slice(0, 60).replace(/\r?\n/g, " ") || "Antigravity Task",
    summary: taskText.slice(0, 120),
    workspaceRoot,
    write,
    model: modelSelection.model,
    effort: options.effort || null
  };
  const jobRecord = createJobRecord(taskMetadata);

  if (options.background) {
    const logFile = createJobLogFile(workspaceRoot, jobId, taskMetadata.title);
    appendLogLine(logFile, `Queued background task on ${modelSelection.model}.`);
    const storedJob = { ...jobRecord, status: "queued", phase: "queued", logFile, request: { ...request, jobId } };
    writeJobFile(workspaceRoot, jobId, storedJob);

    const child = spawnDetachedTaskWorker(cwd, jobId);
    storedJob.pid = child.pid || null;
    writeJobFile(workspaceRoot, jobId, storedJob);

    const payload = { jobId, status: "queued", resultPending: true, title: taskMetadata.title, logFile };
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const logFile = createJobLogFile(workspaceRoot, jobId, taskMetadata.title);
  const progress = createProgressReporter({
    stderr: !options.json,
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, jobId)
  });

  const execution = await runTrackedJob(
    { ...jobRecord, logFile },
    () => executeTask({ workspaceRoot, jobId, request, progress }),
    { logFile }
  );

  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  const jobId = options["job-id"];
  if (!jobId) throw new Error("Missing --job-id for task-worker");

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const storedJob = readStoredJob(workspaceRoot, jobId);
  if (!storedJob) throw new Error(`Stored job ${jobId} not found`);

  const request = storedJob.request;
  if (!request || typeof request.taskText !== "string") {
    throw new Error(`Stored job ${jobId} is missing request payload`);
  }

  // Acquire job slot to prevent concurrency race on last_conversations.json
  const slot = await acquireJobSlot(cwd, { timeoutMs: 60_000 });

  const logFile = storedJob.logFile || createJobLogFile(workspaceRoot, jobId, storedJob.title);
  const progress = createProgressReporter({
    stderr: false,
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, jobId)
  });

  try {
    await runTrackedJob(
      { ...storedJob, logFile },
      () => executeTask({ workspaceRoot, jobId, request, progress }),
      { logFile }
    );
  } finally {
    slot.release();
  }
}

function resolveIsolatedJob(cwd, reference) {
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const isolation = job.result?.isolation;
  if (!isolation || isolation.mode !== "worktree" || !isolation.write) {
    throw new Error(`Job ${job.id} has no isolated write changes.`);
  }
  return { workspaceRoot, job, isolation };
}

function markIsolation(workspaceRoot, job, patch) {
  const updated = {
    ...job,
    result: { ...job.result, isolation: { ...job.result.isolation, ...patch } },
    updatedAt: new Date().toISOString()
  };
  writeJobFile(workspaceRoot, job.id, updated);
}

function handleApply(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "keep-worktree"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const { workspaceRoot, job, isolation } = resolveIsolatedJob(cwd, positionals[0] ?? "");
  if (isolation.appliedAt) {
    throw new Error(`Job ${job.id} was already applied at ${isolation.appliedAt}.`);
  }
  const stat = applyTaskPatch(workspaceRoot, isolation.patchFile);
  if (!options["keep-worktree"]) {
    removeTaskIsolation(isolation, workspaceRoot);
  }
  markIsolation(workspaceRoot, job, { appliedAt: new Date().toISOString(), workPath: options["keep-worktree"] ? isolation.workPath : null });
  const payload = { jobId: job.id, applied: true, stat };
  outputCommandResult(payload, `# Applied Antigravity changes from \`${job.id}\`\n\n\`\`\`\n${stat}\n\`\`\`\n\nReview with \`git diff\`; nothing was committed.\n`, options.json);
}

function handleDiscard(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const { workspaceRoot, job, isolation } = resolveIsolatedJob(cwd, positionals[0] ?? "");
  removeTaskIsolation(isolation, workspaceRoot);
  if (isolation.patchFile && fs.existsSync(isolation.patchFile)) fs.rmSync(isolation.patchFile, { force: true });
  markIsolation(workspaceRoot, job, { discardedAt: new Date().toISOString(), workPath: null, patchFile: null });
  outputCommandResult({ jobId: job.id, discarded: true }, `Discarded Antigravity changes from \`${job.id}\`.\n`, options.json);
}

function spawnDetachedReviewWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "agy-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "review-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

async function handleReviewWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  const jobId = options["job-id"];
  if (!jobId) throw new Error("Missing --job-id for review-worker");

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const storedJob = readStoredJob(workspaceRoot, jobId);
  if (!storedJob) throw new Error(`Stored job ${jobId} not found`);

  const request = storedJob.request;
  if (!request) throw new Error(`Stored job ${jobId} is missing request payload`);

  const slot = await acquireJobSlot(cwd, { timeoutMs: 60_000 });
  const logFile = storedJob.logFile || createJobLogFile(workspaceRoot, jobId, storedJob.title);
  const progress = createProgressReporter({
    stderr: false,
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, jobId)
  });

  const shadow = createReadOnlyWorktree(workspaceRoot);
  try {
    const reviewContext = collectReviewContext(shadow.worktreePath, request.target);
    const template = loadPromptTemplate(ROOT_DIR, "review");
    const prompt = interpolateTemplate(template, {
      FOCUS_TEXT: request.focusText || "General correctness, edge cases, bugs, and security.",
      REPO_ROOT: workspaceRoot,
      TARGET_LABEL: request.target.label,
      BRANCH: reviewContext.branch,
      SUMMARY: reviewContext.summary,
      DIFF_CONTENT: reviewContext.diffText
    });

    const schemaContent = JSON.parse(fs.readFileSync(REVIEW_SCHEMA, "utf8"));

    await runTrackedJob(
      { ...storedJob, logFile },
      async () => {
        progress({ message: `Review worker running on ${request.model || "Gemini"}...` });
        const result = await runAgyTurnWithQuota({
          prompt,
          cwd: shadow.worktreePath,
          sandbox: true,
          write: false,
          model: request.model,
          jsonSchema: schemaContent,
          onProgress: (p) => progress({ message: p.message, conversationId: p.conversationId, phase: "running" })
        }, { maxWaitMs: request.quotaWaitMs ?? 0, onWait: quotaWaitReporter(progress) });

        let parsedData = null;
        let validation = { valid: false, errors: [] };
        try {
          parsedData = JSON.parse(result.response);
          validation = validateAgainstSchema(parsedData, schemaContent);
        } catch (e) {
          validation.errors.push(`JSON parse error: ${e.message}`);
        }

        const normalized = parsedData ? normalizeReviewResultData(parsedData) : null;
        const rendered = renderReviewResult(
          { data: normalized || { verdict: "needs-attention", summary: result.response, findings: [], next_steps: [] } },
          { targetLabel: request.target.label }
        );

        return {
          exitStatus: result.status === "SUCCESS" ? 0 : 1,
          conversationId: result.conversation_id,
          payload: {
            review: "Antigravity Review",
            target: request.target,
            validation,
            data: normalized,
            raw: result.response
          },
          rendered,
          summary: normalized?.summary || "Review completed"
        };
      },
      { logFile }
    );
  } finally {
    try {
      removeReadOnlyWorktree(workspaceRoot, shadow.worktreePath, shadow.tempDir);
    } catch {}
    slot.release();
  }
}

async function handleReview(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "wait-for-quota"],
    booleanOptions: ["json", "background", "wait", "dry-run"],
    aliasMap: { m: "model" }
  });

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  ensureGitRepository(cwd);

  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const modelSelection = selectGeminiModel(options.model);

  if (options["dry-run"]) {
    const quota = getQuotaSnapshot({ cwd });
    const quotaAssessment = assessGeminiQuota(quota);
    const reviewContext = collectReviewContext(cwd, target);
    const dryRunPayload = {
      dryRun: true,
      command: "review",
      target,
      changedFiles: reviewContext.changedFiles,
      summary: reviewContext.summary,
      model: modelSelection.model,
      quota,
      quotaAssessment
    };
    const rendered = [
      "# Antigravity Review (Dry Run)",
      `- Target: ${target.label} (${target.mode})`,
      `- Changed files: ${reviewContext.changedFiles.length}`,
      `- Summary: ${reviewContext.summary}`,
      `- Model: ${modelSelection.model}`,
      `- Gemini Quota: ${describeQuota(quotaAssessment)}`
    ].join("\n");
    outputCommandResult(dryRunPayload, rendered, options.json);
    return;
  }

  const quotaWaitMs = readQuotaWaitMs(options);
  assertQuotaForLaunch(cwd, quotaWaitMs);

  const jobId = generateJobId("review");
  const jobMetadata = {
    id: jobId,
    prefix: "review",
    kind: "review",
    jobClass: "review",
    title: `Antigravity Code Review: ${target.label}`,
    summary: focusText ? `Review focus: ${focusText}` : `Review ${target.label}`,
    workspaceRoot,
    write: false
  };

  const jobRecord = createJobRecord(jobMetadata);

  if (options.background) {
    const logFile = createJobLogFile(workspaceRoot, jobId, jobMetadata.title);
    appendLogLine(logFile, `Queued background review on ${modelSelection.model}.`);

    const storedJob = {
      ...jobRecord,
      status: "queued",
      phase: "queued",
      logFile,
      request: {
        cwd,
        workspaceRoot,
        target,
        focusText,
        model: modelSelection.model,
        quotaWaitMs,
        jobId
      }
    };

    writeJobFile(workspaceRoot, jobId, storedJob);

    const child = spawnDetachedReviewWorker(cwd, jobId);
    storedJob.pid = child.pid || null;
    writeJobFile(workspaceRoot, jobId, storedJob);

    const payload = {
      jobId,
      status: "queued",
      title: jobMetadata.title,
      logFile
    };
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const logFile = createJobLogFile(workspaceRoot, jobId, jobMetadata.title);

  // Use shadow worktree for 100% read-only isolation
  const shadow = createReadOnlyWorktree(workspaceRoot);

  try {
    const reviewContext = collectReviewContext(shadow.worktreePath, target);
    const template = loadPromptTemplate(ROOT_DIR, "review");
    const prompt = interpolateTemplate(template, {
      FOCUS_TEXT: focusText || "General correctness, edge cases, bugs, and security.",
      REPO_ROOT: workspaceRoot,
      TARGET_LABEL: target.label,
      BRANCH: reviewContext.branch,
      SUMMARY: reviewContext.summary,
      DIFF_CONTENT: reviewContext.diffText
    });

    const schemaContent = JSON.parse(fs.readFileSync(REVIEW_SCHEMA, "utf8"));
    const progress = createProgressReporter({
      stderr: !options.json,
      logFile,
      onEvent: createJobProgressUpdater(workspaceRoot, jobId)
    });

    const execution = await runTrackedJob(
      { ...jobRecord, logFile },
      async () => {
        progress({ message: "Running review turn in isolated worktree..." });
        const result = await runAgyTurnWithQuota({
          prompt,
          cwd: shadow.worktreePath,
          sandbox: true,
          write: false,
          model: modelSelection.model,
          jsonSchema: schemaContent,
          onProgress: (p) => progress({ message: p.message, conversationId: p.conversationId, phase: "running" })
        }, { maxWaitMs: quotaWaitMs, onWait: quotaWaitReporter(progress) });

        let parsedData = null;
        let validation = { valid: false, errors: [] };
        try {
          parsedData = JSON.parse(result.response);
          validation = validateAgainstSchema(parsedData, schemaContent);
        } catch (e) {
          validation.errors.push(`JSON parse error: ${e.message}`);
        }

        const normalized = parsedData ? normalizeReviewResultData(parsedData) : null;
        const rendered = renderReviewResult(
          { data: normalized || { verdict: "needs-attention", summary: result.response, findings: [], next_steps: [] } },
          { targetLabel: target.label }
        );

        return {
          exitStatus: result.status === "SUCCESS" ? 0 : 1,
          conversationId: result.conversation_id,
          payload: {
            review: "Antigravity Review",
            target,
            validation,
            data: normalized,
            raw: result.response
          },
          rendered,
          summary: normalized?.summary || "Review completed"
        };
      },
      { logFile }
    );

    outputResult(options.json ? execution.payload : execution.rendered, options.json);
  } finally {
    removeReadOnlyWorktree(workspaceRoot, shadow.worktreePath, shadow.tempDir);
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const reference = positionals[0] ?? "";

  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusPayload(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const reference = positionals[0] ?? "";
  const { job } = resolveResultJob(cwd, reference);

  if (options.json) {
    console.log(JSON.stringify(job.result ?? job, null, 2));
  } else {
    process.stdout.write(job.rendered || job.summary || `Job ${job.id} finished with status ${job.status}.\n`);
  }
}

function handleCancel(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);

  let stopped = false;
  if (job.pid) {
    const res = terminateProcessTree(job.pid, { graceMs: 2000 });
    stopped = res.delivered;
  }

  const cancelledJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: nowIso(),
    updatedAt: nowIso()
  };

  writeJobFile(workspaceRoot, job.id, cancelledJob);
  upsertJob(workspaceRoot, cancelledJob);

  const payload = {
    jobId: job.id,
    status: "cancelled",
    processTerminated: stopped
  };

  const rendered = `Job \`${job.id}\` cancelled.${stopped ? " Process terminated." : ""}\n`;
  outputCommandResult(payload, rendered, options.json);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(
      [
        "Antigravity Companion CLI",
        "",
        "Usage:",
        "  node agy-companion.mjs setup [--json]",
        "  node agy-companion.mjs task [--background|--wait] [--write [--in-place]|--read-only] [--verify <cmd>]... [--model <model>] [--effort low|medium|high] [--prompt-file <path>] [--resume-last] [--wait-for-quota <15m>] [--dry-run] [prompt]",
        "  node agy-companion.mjs task-worker --cwd <cwd> --job-id <id>",
        "  node agy-companion.mjs review [--base <ref>] [--scope <scope>] [--wait-for-quota <15m>] [focus]",
        "  node agy-companion.mjs review-worker --cwd <cwd> --job-id <id>",
        "  node agy-companion.mjs status [job-id] [--all] [--json]",
        "  node agy-companion.mjs result [job-id] [--json]",
        "  node agy-companion.mjs cancel [job-id] [--json]",
        "  node agy-companion.mjs apply [job-id] [--keep-worktree] [--json]",
        "  node agy-companion.mjs discard [job-id] [--json]"
      ].join("\n")
    );
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(rest);
      break;
    case "task":
      await handleTask(rest);
      break;
    case "task-worker":
      await handleTaskWorker(rest);
      break;
    case "review":
      await handleReview(rest);
      break;
    case "review-worker":
      await handleReviewWorker(rest);
      break;
    case "status":
      await handleStatus(rest);
      break;
    case "result":
      handleResult(rest);
      break;
    case "cancel":
      handleCancel(rest);
      break;
    case "apply":
      handleApply(rest);
      break;
    case "discard":
      handleDiscard(rest);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

const STRUCTURED_EXIT_CODES = { [QUOTA_ERROR_CODE]: QUOTA_EXIT_CODE, [AUTH_ERROR_CODE]: AUTH_EXIT_CODE };

main().catch((err) => {
  if (err?.code in STRUCTURED_EXIT_CODES) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(err.toJSON(), null, 2));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(STRUCTURED_EXIT_CODES[err.code]);
  }
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
