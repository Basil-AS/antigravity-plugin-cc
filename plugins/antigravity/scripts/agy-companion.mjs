#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseArgs } from "./lib/args.mjs";
import { getAgyAvailability, getAgyAuthStatus, runAgyTurn } from "./lib/agy.mjs";
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
import { probeAgyUsage, selectGeminiModel } from "./lib/quota.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
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
  saveConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
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
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
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
  const auth = getAgyAuthStatus();
  const quota = agy.available ? probeAgyUsage({ cwd }) : null;

  const ready = nodeCheck.available && gitCheck.available && agy.available && auth.authenticated;

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

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "background", "resume-last", "dry-run"],
    aliasMap: { m: "model" }
  });

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const userPrompt = readTaskPrompt(cwd, options, positionals);

  if (!userPrompt && !options["resume-last"]) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // Prepend proactive constraints to prevent passive waiting
  const constraints = loadSystemConstraints();
  const fullPrompt = constraints ? `${constraints}\n\nTask:\n${userPrompt}` : userPrompt;

  const modelSelection = selectGeminiModel(options.model);

  if (options["dry-run"]) {
    const quota = probeAgyUsage({ cwd });
    const dryRunPayload = {
      dryRun: true,
      command: "task",
      model: modelSelection.model,
      write: Boolean(options.write),
      background: Boolean(options.background),
      promptChars: fullPrompt.length,
      quota
    };
    const rendered = [
      "# Antigravity Task (Dry Run)",
      `- Model: ${modelSelection.model}`,
      `- Write mode: ${Boolean(options.write)}`,
      `- Background: ${Boolean(options.background)}`,
      `- Prompt length: ${fullPrompt.length} characters`,
      `- Gemini Quota: ${quota?.gemini?.available ? `${quota.gemini.percentRemaining}%` : "unknown"}`
    ].join("\n");
    outputCommandResult(dryRunPayload, rendered, options.json);
    return;
  }

  const jobId = generateJobId("task");

  const taskMetadata = {
    id: jobId,
    prefix: "task",
    kind: "task",
    jobClass: "task",
    title: userPrompt.slice(0, 60).replace(/\r?\n/g, " ") || "Antigravity Task",
    summary: userPrompt.slice(0, 120),
    workspaceRoot,
    write: Boolean(options.write),
    model: modelSelection.model,
    effort: options.effort || null
  };

  const jobRecord = createJobRecord(taskMetadata);

  if (options.background) {
    const logFile = createJobLogFile(workspaceRoot, jobId, taskMetadata.title);
    appendLogLine(logFile, `Queued background task on ${modelSelection.model}.`);

    const storedJob = {
      ...jobRecord,
      status: "queued",
      phase: "queued",
      logFile,
      request: {
        cwd,
        prompt: fullPrompt,
        write: Boolean(options.write),
        model: modelSelection.model,
        effort: options.effort || null,
        jobId
      }
    };

    writeJobFile(workspaceRoot, jobId, storedJob);

    const child = spawnDetachedTaskWorker(cwd, jobId);
    storedJob.pid = child.pid || null;
    writeJobFile(workspaceRoot, jobId, storedJob);

    const payload = {
      jobId,
      status: "queued",
      title: taskMetadata.title,
      logFile
    };
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  // Foreground run
  const logFile = createJobLogFile(workspaceRoot, jobId, taskMetadata.title);
  const progress = createProgressReporter({
    stderr: !options.json,
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, jobId)
  });

  const execution = await runTrackedJob(
    { ...jobRecord, logFile },
    async () => {
      progress({ message: `Starting task on ${modelSelection.model}...` });
      const result = await runAgyTurn({
        prompt: fullPrompt,
        cwd,
        write: Boolean(options.write),
        model: modelSelection.model,
        effort: options.effort || null,
        onProgress: (p) => progress({ message: p.message, conversationId: p.conversationId })
      });

      return {
        exitStatus: result.status === "SUCCESS" ? 0 : 1,
        conversationId: result.conversation_id,
        payload: result,
        rendered: result.response,
        summary: result.response.slice(0, 120).replace(/\r?\n/g, " ")
      };
    },
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
  if (!request) throw new Error(`Stored job ${jobId} is missing request payload`);

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
      async () => {
        progress({ message: `Worker executing task on ${request.model || "Gemini"}...` });
        const result = await runAgyTurn({
          prompt: request.prompt,
          cwd: request.cwd,
          write: request.write,
          model: request.model,
          effort: request.effort,
          onProgress: (p) => progress({ message: p.message, conversationId: p.conversationId })
        });

        return {
          exitStatus: result.status === "SUCCESS" ? 0 : 1,
          conversationId: result.conversation_id,
          payload: result,
          rendered: result.response,
          summary: result.response.slice(0, 120).replace(/\r?\n/g, " ")
        };
      },
      { logFile }
    );
  } finally {
    slot.release();
  }
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
        const result = await runAgyTurn({
          prompt,
          cwd: shadow.worktreePath,
          sandbox: true,
          write: false,
          model: request.model,
          jsonSchema: schemaContent,
          onProgress: (p) => progress({ message: p.message, conversationId: p.conversationId })
        });

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
    valueOptions: ["base", "scope", "model", "cwd"],
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
    const quota = probeAgyUsage({ cwd });
    const reviewContext = collectReviewContext(cwd, target);
    const dryRunPayload = {
      dryRun: true,
      command: "review",
      target,
      changedFiles: reviewContext.changedFiles,
      summary: reviewContext.summary,
      model: modelSelection.model,
      quota
    };
    const rendered = [
      "# Antigravity Review (Dry Run)",
      `- Target: ${target.label} (${target.mode})`,
      `- Changed files: ${reviewContext.changedFiles.length}`,
      `- Summary: ${reviewContext.summary}`,
      `- Model: ${modelSelection.model}`,
      `- Gemini Quota: ${quota?.gemini?.available ? `${quota.gemini.percentRemaining}%` : "unknown"}`
    ].join("\n");
    outputCommandResult(dryRunPayload, rendered, options.json);
    return;
  }

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
        const result = await runAgyTurn({
          prompt,
          cwd: shadow.worktreePath,
          sandbox: true,
          write: false,
          model: modelSelection.model,
          jsonSchema: schemaContent,
          onProgress: (p) => progress({ message: p.message, conversationId: p.conversationId })
        });

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
        "  node agy-companion.mjs task [--background] [--write] [--model <model>] [prompt]",
        "  node agy-companion.mjs task-worker --cwd <cwd> --job-id <id>",
        "  node agy-companion.mjs review [--base <ref>] [--scope <scope>] [focus]",
        "  node agy-companion.mjs review-worker --cwd <cwd> --job-id <id>",
        "  node agy-companion.mjs status [job-id] [--all] [--json]",
        "  node agy-companion.mjs result [job-id] [--json]",
        "  node agy-companion.mjs cancel [job-id] [--json]"
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
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
