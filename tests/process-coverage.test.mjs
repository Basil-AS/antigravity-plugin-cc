import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { runCommand } from "../plugins/antigravity/scripts/lib/process.mjs";

test("runCommand handles nonexistent command returning ENOENT error", () => {
  const result = runCommand("__nonexistent_cmd_404__", ["--version"]);

  assert.equal(result.command, "__nonexistent_cmd_404__");
  assert.deepEqual(result.args, ["--version"]);
  assert.ok(result.error);
  assert.equal(result.error.code, "ENOENT");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});

test("runCommand handles non-zero exit code", () => {
  const result = runCommand(process.execPath, [
    "-e",
    "process.exit(42)"
  ]);

  assert.equal(result.status, 42);
  assert.equal(result.signal, null);
  assert.equal(result.error, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("runCommand captures stderr output and distinguishes it from stdout", () => {
  const result = runCommand(process.execPath, [
    "-e",
    "console.error('stderr sample line'); console.log('stdout sample line');"
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.error, null);
  assert.equal(result.stdout.trim(), "stdout sample line");
  assert.equal(result.stderr.trim(), "stderr sample line");
});

test("runCommand handles empty output from silent commands", () => {
  const result = runCommand(process.execPath, [
    "-e",
    "/* empty body */"
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.error, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("runCommand respects cwd option", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "process-cwd-test-"));
  try {
    const result = runCommand(process.execPath, [
      "-e",
      "console.log(process.cwd())"
    ], { cwd: tmpDir });

    assert.equal(result.status, 0);
    assert.equal(result.error, null);
    assert.equal(
      fs.realpathSync(result.stdout.trim()),
      fs.realpathSync(tmpDir)
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runCommand respects env option", () => {
  const testVal = "edge_env_var_" + Date.now();
  const result = runCommand(process.execPath, [
    "-e",
    "console.log(process.env.TEST_PROCESS_EDGE_ENV || '')"
  ], {
    env: {
      ...process.env,
      TEST_PROCESS_EDGE_ENV: testVal
    }
  });

  assert.equal(result.status, 0);
  assert.equal(result.error, null);
  assert.equal(result.stdout.trim(), testVal);
});

test("runCommand supports stdin input via options.input", () => {
  const inputPayload = "line 1\nline 2\nend of input";
  const result = runCommand(process.execPath, [
    "-e",
    "let buf = ''; process.stdin.on('data', chunk => { buf += chunk; }); process.stdin.on('end', () => { process.stdout.write(buf); });"
  ], {
    input: inputPayload
  });

  assert.equal(result.status, 0);
  assert.equal(result.error, null);
  assert.equal(result.stdout, inputPayload);
});

test("runCommand reports signal and maps null status to 0 when child is killed", () => {
  const result = runCommand(process.execPath, [
    "-e",
    "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 10000);"
  ]);

  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.status, 0);
  assert.equal(result.error, null);
});

test("runCommand handles large stdout output without truncation", () => {
  const lineCount = 5000;
  const result = runCommand(process.execPath, [
    "-e",
    `for (let i = 0; i < ${lineCount}; i++) { console.log('line ' + i); }`
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.error, null);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, lineCount);
  assert.equal(lines[0], "line 0");
  assert.equal(lines[lineCount - 1], `line ${lineCount - 1}`);
});

test("runCommand surfaces ENOBUFS error when maxBuffer limit is exceeded", () => {
  const result = runCommand(process.execPath, [
    "-e",
    "console.log('x'.repeat(4096))"
  ], {
    maxBuffer: 256
  });

  assert.ok(result.error);
  assert.equal(result.error.code, "ENOBUFS");
});

test("runCommand defaults args and options safely when omitted", () => {
  const result = runCommand(process.execPath, ["--version"]);

  assert.equal(result.status, 0);
  assert.equal(result.error, null);
  assert.ok(result.stdout.trim().startsWith("v"));
  assert.deepEqual(result.args, ["--version"]);
});
