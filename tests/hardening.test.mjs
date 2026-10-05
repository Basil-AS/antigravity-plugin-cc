import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeArgv } from "../plugins/antigravity/scripts/lib/args.mjs";
import { renderReviewResult } from "../plugins/antigravity/scripts/lib/render.mjs";
import { resolveWorkspaceName, resolveWorkspaceRoot } from "../plugins/antigravity/scripts/lib/workspace.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "antigravity");

test("renderReviewResult does not claim 'no issues' for needs-attention without findings", () => {
  const output = renderReviewResult({
    data: { verdict: "needs-attention", summary: "Risky change.", findings: [], next_steps: [] }
  });

  assert.match(output, /NEEDS ATTENTION/);
  assert.doesNotMatch(output, /No blocking issues/);
  assert.match(output, /no structured findings were itemized/);
});

test("renderReviewResult reports no issues only for an approve verdict", () => {
  const output = renderReviewResult({
    data: { verdict: "approve", summary: "Looks good.", findings: [], next_steps: [] }
  });

  assert.match(output, /APPROVED/);
  assert.match(output, /No blocking issues or defects found\./);
});

test("normalizeArgv splits a single quoted $ARGUMENTS word", () => {
  assert.deepEqual(normalizeArgv(["abc123 --all"]), ["abc123", "--all"]);
  assert.deepEqual(normalizeArgv([""]), []);
  assert.deepEqual(normalizeArgv(["job-1", "--json"]), ["job-1", "--json"]);
  assert.deepEqual(normalizeArgv([]), []);
});

test("resolveWorkspaceRoot falls back to the resolved cwd outside git", () => {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-root-test-")));
  try {
    assert.equal(resolveWorkspaceRoot(tmpDir), tmpDir);
    assert.equal(resolveWorkspaceName(tmpDir), path.basename(tmpDir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveWorkspaceRoot returns the git toplevel from a subdirectory", () => {
  const root = resolveWorkspaceRoot(path.join(PLUGIN_ROOT, "scripts"));
  assert.equal(fs.realpathSync(root), fs.realpathSync(REPO_ROOT));
});

test("versions are in sync across package.json, plugin.json and marketplace.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const market = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8"));

  assert.equal(plugin.version, pkg.version);
  assert.equal(market.metadata.version, pkg.version);
  for (const entry of market.plugins) {
    assert.equal(entry.version, pkg.version);
  }
});

test("MCP server reports the plugin.json version on initialize", async () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, "scripts", "agy-mcp.mjs")], {
    stdio: ["pipe", "pipe", "inherit"]
  });

  try {
    const line = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("MCP initialize timed out")), 5000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline !== -1) {
          clearTimeout(timer);
          resolve(buffer.slice(0, newline));
        }
      });
      child.on("error", reject);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    });

    const response = JSON.parse(line);
    assert.equal(response.result.serverInfo.version, plugin.version);
  } finally {
    child.stdin.end();
    child.kill();
  }
});

test("stop-gate review timeout fits inside the Stop hook budget", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  const stopBudgetSec = hooks.hooks.Stop[0].hooks[0].timeout;
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs"), "utf8");
  const match = source.match(/STOP_GATE_TIMEOUT_MS = ([\d_]+)/);
  assert.ok(match, "STOP_GATE_TIMEOUT_MS constant not found");
  const timeoutMs = Number(match[1].replace(/_/g, ""));

  assert.ok(timeoutMs >= 180_000, `stop-gate timeout too low: ${timeoutMs}`);
  assert.ok(timeoutMs < stopBudgetSec * 1000, "stop-gate timeout must be below the hook budget");
});
