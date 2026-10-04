#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runAgyTurn } from "./lib/agy.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { getConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

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
    emitDecision({ decision: "ALLOW" });
    return;
  }

  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  if (!lastAssistantMessage) {
    emitDecision({ decision: "ALLOW" });
    return;
  }

  const template = loadPromptTemplate(ROOT_DIR, "stop-gate");
  const prompt = interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: `Previous Claude response:\n${lastAssistantMessage}`
  });

  try {
    const result = await runAgyTurn({
      prompt,
      cwd,
      sandbox: true,
      write: false,
      timeoutMs: 60_000
    });

    const firstLine = (result.response || "").split(/\r?\n/)[0].trim();
    if (firstLine.startsWith("BLOCK:")) {
      emitDecision({
        decision: "BLOCK",
        reason: firstLine.slice("BLOCK:".length).trim() || "Antigravity stop-gate blocked this change."
      });
      return;
    }

    emitDecision({ decision: "ALLOW" });
  } catch {
    // Fail-open on hook timeout or evaluation error so user is not stuck
    emitDecision({ decision: "ALLOW" });
  }
}

main().catch(() => {
  emitDecision({ decision: "ALLOW" });
});
