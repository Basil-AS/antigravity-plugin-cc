import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { extractCaveats, renderCaveats, rewriteIsolationPaths, salvageTaskResult } from "../plugins/antigravity/scripts/lib/report.mjs";
import { createProgressReporter } from "../plugins/antigravity/scripts/lib/tracked-jobs.mjs";

test("Windows worktree paths in every spelling map back to the workspace", () => {
  const isolation = { mode: "worktree", workPath: "C:\\Users\\me\\AppData\\Local\\Temp\\agy-task-Ab12\\wrt" };
  const root = "C:\\Users\\me\\Projects\\wrt";
  const text = [
    "See C:\\Users\\me\\AppData\\Local\\Temp\\agy-task-Ab12\\wrt\\src\\ports.ts:12.",
    "[ports](file:///c:/Users/me/AppData/Local/Temp/agy-task-Ab12/wrt/src/ports.ts#L12)",
    "Also C:/Users/me/AppData/Local/Temp/agy-task-Ab12/wrt/README.md and the root C:\\Users\\me\\AppData\\Local\\Temp\\agy-task-Ab12\\wrt."
  ].join("\n");
  const out = rewriteIsolationPaths(text, isolation, root);
  assert.doesNotMatch(out, /agy-task-/i);
  assert.match(out, /C:\\Users\\me\\Projects\\wrt\\src\\ports\.ts:12/);
  assert.match(out, /file:\/\/\/C:\/Users\/me\/Projects\/wrt\/src\/ports\.ts#L12/);
  assert.match(out, /C:\/Users\/me\/Projects\/wrt\/README\.md/);
  assert.match(out, /root C:\\Users\\me\\Projects\\wrt\./);
});

test("POSIX worktree paths are rewritten, sibling names and in-place runs are left alone", () => {
  const isolation = { mode: "worktree", workPath: "/tmp/agy-task-x/repo" };
  const out = rewriteIsolationPaths("/tmp/agy-task-x/repo/a.js:3 vs /tmp/agy-task-x/repo-old/b.js file:///tmp/agy-task-x/repo/c.js", isolation, "/home/u/repo");
  assert.equal(out, "/home/u/repo/a.js:3 vs /tmp/agy-task-x/repo-old/b.js file:///home/u/repo/c.js");
  assert.equal(rewriteIsolationPaths("/w/a.js", { mode: "in-place", workPath: "/w" }, "/w"), "/w/a.js");
});

test("caveats come from the Unverified section and from admissions in the text", () => {
  const report = [
    "## Findings",
    "- Ports 5100-5109 are slow.",
    "- I did not verify the latency table line by line.",
    "```",
    "not verified inside code fences is ignored",
    "```",
    "## Unverified",
    "- The 5100-5109 range classification.",
    "## Next steps",
    "- Run the benchmark."
  ].join("\n");
  const caveats = extractCaveats(report);
  assert.deepEqual(caveats, ["I did not verify the latency table line by line.", "The 5100-5109 range classification."]);
  assert.match(renderCaveats(caveats), /^## ⚠ Unverified by Antigravity/);
});

test("an Unverified section that says None produces no block", () => {
  assert.deepEqual(extractCaveats("Done, see src/a.js:3.\n\n## Unverified\nNone"), []);
  assert.equal(renderCaveats([]), "");
});

test("progress reporter collapses consecutive duplicate lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-progress-"));
  const logFile = path.join(dir, "job.log");
  try {
    const events = [];
    const report = createProgressReporter({ logFile, onEvent: (e) => events.push(e.message) });
    for (let i = 0; i < 300; i += 1) report({ message: "step 15 agent_response (ACTIVE)", phase: "running" });
    report({ message: "step 16 tool_call (ACTIVE)", phase: "running" });
    report({ message: "step 15 agent_response (ACTIVE)", phase: "running" });
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(events.length, 302, "phase/state events still reach the job record");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("salvageTaskResult keeps the raw answer and fails the job when finalising throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salvage-"));
  try {
    const responseFile = path.join(dir, "job.response.md");
    const out = salvageTaskResult({
      responseFile,
      result: { conversation_id: "c1", status: "SUCCESS", response: "Found it in src/a.js:3.\n" },
      error: new Error("rewriteIsolationPaths is not defined")
    });
    assert.equal(out.exitStatus, 1);
    assert.equal(out.conversationId, "c1");
    assert.equal(out.payload.postProcessingError, "rewriteIsolationPaths is not defined");
    assert.equal(fs.readFileSync(responseFile, "utf8"), "Found it in src/a.js:3.\n");
    assert.match(out.rendered, /Post-processing failed/);
    assert.match(out.rendered, /Found it in src\/a\.js:3\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("salvageTaskResult still returns the answer when it cannot be written to disk", () => {
  const out = salvageTaskResult({
    responseFile: path.join(os.tmpdir(), "definitely", "missing", "dir", "x.md"),
    result: { response: "answer" },
    error: "boom"
  });
  assert.equal(out.payload.responseFile, null);
  assert.match(out.rendered, /could not be saved/);
  assert.match(out.rendered, /answer/);
});
