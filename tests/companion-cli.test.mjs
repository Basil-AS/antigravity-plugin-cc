import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT_DIR, "plugins", "antigravity", "scripts", "agy-companion.mjs");

test("companion setup --json emits valid ready status", () => {
  const output = execFileSync(process.execPath, [SCRIPT, "setup", "--json"], {
    encoding: "utf8",
    cwd: ROOT_DIR
  });
  const data = JSON.parse(output);
  assert.equal(typeof data.ready, "boolean");
  assert.equal(data.node.available, true);
  assert.equal(data.git.available, true);
  assert.equal(typeof data.agy.version, "string");
});

test("companion task --dry-run produces preview without calling LLM", () => {
  const output = execFileSync(process.execPath, [SCRIPT, "task", "--dry-run", "--json", "test task"], {
    encoding: "utf8",
    cwd: ROOT_DIR
  });
  const data = JSON.parse(output);
  assert.equal(data.dryRun, true);
  assert.equal(data.command, "task");
  assert.equal(typeof data.model, "string");
  assert.ok(data.promptChars > 0);
});

test("companion review --dry-run produces preview without calling LLM", () => {
  const output = execFileSync(process.execPath, [SCRIPT, "review", "--dry-run", "--json"], {
    encoding: "utf8",
    cwd: ROOT_DIR
  });
  const data = JSON.parse(output);
  assert.equal(data.dryRun, true);
  assert.equal(data.command, "review");
  assert.equal(data.target.mode, "working-tree");
  assert.ok(Array.isArray(data.changedFiles));
});
