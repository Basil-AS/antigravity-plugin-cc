#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "agy-companion.mjs");

export function readPluginVersion(rootDir = ROOT_DIR) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(rootDir, ".claude-plugin", "plugin.json"), "utf8"));
    return typeof manifest.version === "string" && manifest.version ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const SERVER_VERSION = readPluginVersion();

async function runCliAsync(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: options.cwd,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    });
    return stdout || stderr;
  } catch (err) {
    return err.stdout || err.stderr || err.message;
  }
}

function tool(name, title, description, annotations, required, properties) {
  return {
    name,
    description,
    annotations: { title, ...annotations },
    inputSchema: { type: "object", additionalProperties: false, required, properties }
  };
}

export const TOOLS = [
  tool(
    "agy_rescue",
    "Delegate task to Google Antigravity (Gemini)",
    "Run a task using Google Antigravity CLI (agy / Gemini). Read-only analysis by default (runs in a disposable copy; edits are discarded and reported). With `write: true` it edits an isolated git worktree and returns a patch summary; apply it with `agy_apply` after review. `verify` commands are run by the plugin itself and their real output is attached. `background: true` returns only a launch receipt (result pending) — poll `agy_status`/`agy_result`.",
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    ["prompt"],
    {
      prompt: { type: "string", description: "The task instructions for Antigravity" },
      workspace: { type: "string", description: "Target workspace directory (defaults to current working directory)" },
      write: { type: "boolean", default: false, description: "Allow Antigravity to modify files (in an isolated worktree unless in_place)" },
      in_place: { type: "boolean", default: false, description: "With write: edit the workspace directly instead of an isolated worktree" },
      verify: { type: "array", items: { type: "string" }, description: "Shell commands the plugin runs after the task (in the isolated copy) and attaches real output for, e.g. [\"npm test\"]" },
      background: { type: "boolean", default: false, description: "Run task in the background" },
      model: { type: "string", description: "Optional Gemini model (defaults to gemini-3.8-flash-medium)" },
      effort: { type: "string", enum: ["low", "medium", "high"], description: "Reasoning effort; selects gemini-3.8-flash-<effort> unless model is set. Use high for audits and root-cause analysis" },
      resume_last: { type: "boolean", default: false, description: "Continue the latest Antigravity task conversation in this workspace" },
      wait_for_quota: { type: "string", description: "If the Gemini quota is exhausted but resets within this duration (e.g. 15m), wait instead of failing" }
    }
  ),
  tool(
    "agy_review",
    "Review code diff with Google Antigravity",
    "Run an objective, automated code review of git diffs using Google Antigravity in an isolated shadow worktree.",
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    [],
    {
      workspace: { type: "string", description: "Target repository directory" },
      base: { type: "string", description: "Git base reference to compare against (e.g. main)" },
      focus: { type: "string", description: "Specific aspects to focus on (e.g. security, performance)" },
      wait_for_quota: { type: "string", description: "If the Gemini quota is exhausted but resets within this duration (e.g. 15m), wait instead of failing" }
    }
  ),
  tool(
    "agy_status",
    "Check Antigravity job status",
    "List active and recent Antigravity tasks and code reviews.",
    { readOnlyHint: true, destructiveHint: false },
    [],
    {
      workspace: { type: "string", description: "Target workspace directory" },
      job_id: { type: "string", description: "Optional specific job ID to inspect" }
    }
  ),
  tool(
    "agy_result",
    "Get Antigravity job result",
    "Retrieve the full output and verdict of a completed Antigravity job.",
    { readOnlyHint: true, destructiveHint: false },
    [],
    {
      workspace: { type: "string", description: "Target workspace directory" },
      job_id: { type: "string", description: "Specific job ID (optional, defaults to latest)" }
    }
  ),
  tool(
    "agy_apply",
    "Apply Antigravity changes",
    "Apply the isolated changes (patch) of a finished Antigravity write task to the workspace. Nothing is committed.",
    { readOnlyHint: false, destructiveHint: false },
    [],
    {
      workspace: { type: "string", description: "Target workspace directory" },
      job_id: { type: "string", description: "Job ID (defaults to the latest finished job)" }
    }
  ),
  tool(
    "agy_discard",
    "Discard Antigravity changes",
    "Discard the isolated worktree and patch of a finished Antigravity write task.",
    { readOnlyHint: false, destructiveHint: true },
    [],
    {
      workspace: { type: "string", description: "Target workspace directory" },
      job_id: { type: "string", description: "Job ID (defaults to the latest finished job)" }
    }
  ),
  tool(
    "agy_cancel",
    "Cancel running Antigravity job",
    "Cancel an in-progress Antigravity background task and terminate its process tree.",
    { readOnlyHint: false, destructiveHint: true },
    [],
    {
      workspace: { type: "string", description: "Target workspace directory" },
      job_id: { type: "string", description: "Job ID to cancel" }
    }
  )
];

async function handleToolCall(name, args) {
  const cwd = args.workspace ? path.resolve(args.workspace) : process.cwd();

  switch (name) {
    case "agy_rescue": {
      const cliArgs = [SCRIPT_PATH, "task", "--json"];
      if (args.write) cliArgs.push("--write");
      if (args.write && args.in_place) cliArgs.push("--in-place");
      for (const command of Array.isArray(args.verify) ? args.verify : []) {
        if (typeof command === "string" && command.trim()) cliArgs.push("--verify", command);
      }
      if (args.background) cliArgs.push("--background");
      if (args.model) cliArgs.push("--model", args.model);
      if (args.effort) cliArgs.push("--effort", args.effort);
      if (args.resume_last) cliArgs.push("--resume-last");
      if (args.wait_for_quota) cliArgs.push("--wait-for-quota", args.wait_for_quota);
      cliArgs.push("--cwd", cwd, args.prompt);

      return await runCliAsync(cliArgs, { cwd });
    }
    case "agy_review": {
      const cliArgs = [SCRIPT_PATH, "review", "--json", "--cwd", cwd];
      if (args.base) cliArgs.push("--base", args.base);
      if (args.wait_for_quota) cliArgs.push("--wait-for-quota", args.wait_for_quota);
      if (args.focus) cliArgs.push(args.focus);

      return await runCliAsync(cliArgs, { cwd });
    }
    case "agy_status": {
      const cliArgs = [SCRIPT_PATH, "status", "--json", "--cwd", cwd];
      if (args.job_id) cliArgs.push(args.job_id);

      return await runCliAsync(cliArgs, { cwd });
    }
    case "agy_result": {
      const cliArgs = [SCRIPT_PATH, "result", "--json", "--cwd", cwd];
      if (args.job_id) cliArgs.push(args.job_id);

      return await runCliAsync(cliArgs, { cwd });
    }
    case "agy_apply":
    case "agy_discard": {
      const cliArgs = [SCRIPT_PATH, name === "agy_apply" ? "apply" : "discard", "--json", "--cwd", cwd];
      if (args.job_id) cliArgs.push(args.job_id);

      return await runCliAsync(cliArgs, { cwd });
    }
    case "agy_cancel": {
      const cliArgs = [SCRIPT_PATH, "cancel", "--json", "--cwd", cwd];
      if (args.job_id) cliArgs.push(args.job_id);

      return await runCliAsync(cliArgs, { cwd });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    const { id, method, params } = message;

    if (method === "initialize") {
      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "antigravity-mcp", version: SERVER_VERSION }
        }
      };
      process.stdout.write(JSON.stringify(response) + "\n");
      continue;
    }

    if (method === "notifications/initialized") {
      continue;
    }

    if (method === "tools/list") {
      const response = {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS }
      };
      process.stdout.write(JSON.stringify(response) + "\n");
      continue;
    }

    if (method === "tools/call") {
      try {
        const output = await handleToolCall(params.name, params.arguments || {});
        let contentText = output;
        let blocked = false;
        try {
          const parsed = JSON.parse(output);
          contentText = JSON.stringify(parsed, null, 2);
          // The payload keeps quotaExhausted and authRequired distinct: only a
          // quota error has a resetAt worth waiting for; a missing login never
          // resolves by waiting.
          blocked = parsed?.quotaExhausted === true || parsed?.authRequired === true;
        } catch {}

        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            // Exhausted quota or a missing login is a tool error the caller
            // should act on (do the work itself / log in), not a normal result.
            ...(blocked ? { isError: true } : {}),
            content: [{ type: "text", text: contentText }]
          }
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } catch (err) {
        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: `Error: ${err.message}` }]
          }
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      }
      continue;
    }

    if (method === "ping") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
      continue;
    }

    // Default response for unhandled requests
    if (id !== undefined) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        }) + "\n"
      );
    }
  }
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
