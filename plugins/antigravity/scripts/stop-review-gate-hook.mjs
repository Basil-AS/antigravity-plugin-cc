#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runAgyTurnWithQuota } from "./lib/agy.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { getConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const STOP_GATE_TIMEOUT_MS = 180_000;

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  if (!config.stopReviewGate) {
    emitDecision({});
    return;
  }

  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  if (!lastAssistantMessage) {
    emitDecision({});
    return;
  }

  const template = loadPromptTemplate(ROOT_DIR, "stop-gate");
  const prompt = interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: `Previous Claude response:\n${lastAssistantMessage}`
  });

  try {
    const result = await runAgyTurnWithQuota({
      prompt,
      cwd,
      sandbox: true,
      write: false,
      // Must stay below the Stop hook budget in hooks/hooks.json (900s).
      timeoutMs: STOP_GATE_TIMEOUT_MS
    });

    const firstLine = (result.response || "").split(/\r?\n/)[0].trim();
    if (firstLine.startsWith("BLOCK:")) {
      emitDecision({
        decision: "block",
        reason: firstLine.slice("BLOCK:".length).trim() || "Antigravity stop-gate blocked this change."
      });
      return;
    }

    emitDecision({});
  } catch {
    // Fail-open on hook timeout, exhausted Gemini quota (fails fast, no wait)
    // or evaluation error so the user is not stuck
    emitDecision({});
  }
}

main().catch(() => {
  emitDecision({});
});
